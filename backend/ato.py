"""Onboard ATO: speed-profile tracking, precise station stops, dwell, stop order.

Profile (all in m/s, metres):
    v_ref = min( civil ceiling over the train body − margin,
                 braking curve to each lower civil limit ahead,
                 service-brake curve to the next stopping point,
                 service-brake curve to the EOA − margin,
                 dispatcher / event speed cap )
Demand:
    a = a_ff + K·(v_ref − v)        a_ff = slope of the binding curve (feed-forward)
    |v_ref − v| < coast band and no feed-forward  →  a = 0 (coast; no traction/brake hunting)
    then clamped to the traction/brake envelope; the train applies it jerk-limited.

Stop curves use a tapered shape  v_ref = sqrt(2·b·D + vc²) − vc  so deceleration fades to
zero as the train comes to rest (smooth, monotonic, precise).  The planning decelerations are
well inside the ATP's guaranteed-EB curve, so ATP never needs to intervene.

Stop order: each train holds ``stop_idx`` = the next platform in ring order.  It only moves
forward when the train berths there, or when the nose physically crosses that stopping point
(dispatcher skip/express — or an overrun, which is logged).  No short-arc "have I passed it?"
guesses, so a stop can never silently disappear.
"""

from __future__ import annotations

import math
import random
from typing import Callable

import civil
from ma_constants import (
    ATO_CIVIL_DECEL_MPS2,
    ATO_COAST_BAND_MPS,
    ATO_DEPART_MIN_EOA_M,
    ATO_EOA_DECEL_MPS2,
    ATO_EOA_MARGIN_M,
    ATO_GAIN_PER_S,
    ATO_RESTART_M,
    ATO_SPEED_MARGIN_MPS,
    ATO_STOP_DECEL_MPS2,
    ATO_TAPER_MPS,
    JERK_LIMIT_MPS3,
    KPH_TO_MPS,
    SERVICE_BRAKE_MAX_MPS2,
    STOP_SNAP_MPS,
    STOP_TOLERANCE_M,
)
from route_geom import ROUTE_LEN_M
from stations import N_PLATFORMS, PLATFORMS, Platform, dwell_s, first_platform_ahead
from train import Train, traction_limit_mps2

_L = ROUTE_LEN_M
_VC = ATO_TAPER_MPS
_K = ATO_GAIN_PER_S
_J = JERK_LIMIT_MPS3
_B_STOP = ATO_STOP_DECEL_MPS2
_B_EOA = ATO_EOA_DECEL_MPS2
_B_CIV = ATO_CIVIL_DECEL_MPS2
_CIV_LOOKAHEAD_M = 900.0
_B_LATE = 1.0                # firmest decel accepted to still make a stop that appears late
_BERTH_OVERRUN_M = 10.0      # still within the platform for a 138 m train
_BERTH_OVERRUN_MPS = 1.0
# Blend width (m/s) for switching between profile curves.  The reference's slope then changes
# from one curve's to the other's over ~2·_BLEND/b seconds, i.e. at a jerk of b²/(2·_BLEND),
# which is kept under the jerk limit.
_BLEND = 1.15 * _B_STOP * _B_STOP / (2.0 * _J)
_BLEND_MIN = 0.25
_BLEND_MAX = 3.0
_BLEND_GAIN = 2.0    # blended reference jerk ≈ J / _BLEND_GAIN (headroom for curve nonlinearity)


def _smin(a: float, a_slope: float, b: float, b_slope: float) -> tuple[float, float]:
    """Smooth minimum of two curves (value, slope).  Blend width from the slope difference:
    the slope then changes at ~J/_BLEND_GAIN, so a jerk-limited train can follow it."""
    k = _BLEND_GAIN * (a_slope - b_slope) * (a_slope - b_slope) / (2.0 * _J)
    k = _BLEND_MIN if k < _BLEND_MIN else (_BLEND_MAX if k > _BLEND_MAX else k)
    h = k - abs(a - b)
    if h <= 0.0:
        return (a, a_slope) if a <= b else (b, b_slope)
    w = h / (2.0 * k)               # weight of the larger curve
    if a <= b:
        return a - h * h / (4.0 * k), (1.0 - w) * a_slope + w * b_slope
    return b - h * h / (4.0 * k), (1.0 - w) * b_slope + w * a_slope


def _smax(a: float, a_slope: float, b: float, b_slope: float) -> tuple[float, float]:
    """Smooth maximum of two curves (value, slope), blend width _BLEND."""
    h = _BLEND - abs(a - b)
    if h <= 0.0:
        return (a, a_slope) if a >= b else (b, b_slope)
    w = h / (2.0 * _BLEND)          # weight of the smaller curve
    if a >= b:
        return a + h * h / (4.0 * _BLEND), (1.0 - w) * a_slope + w * b_slope
    return b + h * h / (4.0 * _BLEND), (1.0 - w) * b_slope + w * a_slope


def _taper(d: float, b: float) -> float:
    if d <= 0.0:
        return 0.0
    return math.sqrt(2.0 * b * d + _VC * _VC) - _VC


_V_RESTART = _taper(ATO_RESTART_M, _B_EOA)


def _held(tr: Train) -> bool:
    return bool(tr._op_hold or getattr(tr, "_station_hold", False) or getattr(tr, "_door_interlock", False))


def will_stop(tr: Train, p: Platform, skips_before: int = 0) -> bool:
    """Does this train stop at platform p (given ``skips_before`` skips already planned)?"""
    if p.terminal:
        return True
    if tr.forced_pass_idx == p.ring_index:
        return False          # became the target too late to stop for (order released)
    if tr._op_express:
        return False
    return int(tr._op_skip_remaining) - skips_before <= 0


def effective_stop(tr: Train) -> int:
    """Ring index of the next platform this train will actually stop at."""
    k = tr.stop_idx if tr.stop_idx is not None else 0
    used = 0
    for _ in range(N_PLATFORMS):
        p = PLATFORMS[k]
        if will_stop(tr, p, used):
            return k
        if not p.terminal and not tr._op_express:
            used += 1
        k = (k + 1) % N_PLATFORMS
    return k


class AtoController:
    def __init__(self, rng: random.Random | None = None) -> None:
        self.rng = rng or random.Random(0)
        self.peak = True
        self.dwell_bias_s = 0.0
        self.on_berth: Callable[[Train, int, float], None] | None = None
        self.on_depart: Callable[[Train, int, float], None] | None = None
        self.on_pass: Callable[[Train, int, str, float], None] | None = None

    # ── setup ──────────────────────────────────────────────────────────────
    def ensure_train_state(self, tr: Train, sim_t: float = 0.0) -> None:
        if tr.stop_idx is None and tr.berthed_idx is None:
            # A train created standing on a stopping point is berthed there (otherwise a train
            # placed on a terminal departure platform would never be dispatched).
            if tr.v <= STOP_SNAP_MPS:
                for p in PLATFORMS:
                    back = (tr.chainage_front_m - p.chainage_m) % _L
                    fwd = (p.chainage_m - tr.chainage_front_m) % _L
                    if back <= _BERTH_OVERRUN_M or fwd <= STOP_TOLERANCE_M:
                        self.berth_now(tr, p.ring_index, sim_t, error_m=fwd if fwd <= STOP_TOLERANCE_M else -back)
                        return
            # Next stop = first platform the train can still brake for comfortably.
            brake = tr.v * tr.v / (2.0 * _B_STOP) + 2.0
            tr.stop_idx = first_platform_ahead(tr.chainage_front_m, brake)

    def berth_now(self, tr: Train, k: int, sim_t: float, dwell: float | None = None, error_m: float = 0.0) -> None:
        p = PLATFORMS[k]
        tr.v = 0.0
        tr.a = 0.0
        tr.a_target = 0.0
        tr.berthed_idx = k
        tr.stop_idx = (k + 1) % N_PLATFORMS
        tr.last_target_idx = None
        if tr.forced_pass_idx == k:
            tr.forced_pass_idx = None
        tr.at_station_name = p.name
        tr.ready_to_depart = False
        d = dwell if dwell is not None else dwell_s(p, self.peak, self.rng, self.dwell_bias_s)
        tr.dwell_remaining_sec = d
        tr.dwell_total_sec = d
        tr.berth_log.append((sim_t, k, error_m))
        tr.berth_count += 1
        if self.on_berth:
            self.on_berth(tr, k, sim_t)

    # ── per-step control (before physics) ─────────────────────────────────
    def control(self, tr: Train, dt: float, sim_t: float) -> None:
        self.ensure_train_state(tr, sim_t)
        if tr.berthed_idx is not None:
            self._dwell(tr, dt)
            if not tr.ready_to_depart or tr.e_brake or tr.atp_eb:
                tr.a_target = 0.0
                tr.ato_binding = "dwell"
                tr.ato_vref = 0.0
                return
            # ATS departure check: enough authority to get going (or to reach the next stop).
            eff = effective_stop(tr)
            d_next = (PLATFORMS[eff].chainage_m - tr.chainage_front_m) % _L
            avail = tr.eoa_dist_m - ATO_EOA_MARGIN_M
            if avail < min(ATO_DEPART_MIN_EOA_M, d_next) - 0.25:
                tr.a_target = 0.0
                tr.ato_binding = "dwell"
                tr.ato_vref = 0.0
                return
            k = tr.berthed_idx
            tr.berthed_idx = None
            tr.at_station_name = ""
            tr.ready_to_depart = False
            tr.dwell_remaining_sec = 0.0
            tr.depart_log.append((sim_t, k))
            if self.on_depart:
                self.on_depart(tr, k, sim_t)

        if tr.e_brake or tr.atp_eb:
            tr.a_target = 0.0
            tr.ato_binding = "eb"
            tr.hold_request = False
            return
        self._profile(tr)

    def _dwell(self, tr: Train, dt: float) -> None:
        held = _held(tr)
        if tr.ready_to_depart:
            if held:
                tr.ready_to_depart = False
                tr.dwell_remaining_sec = 1.0
            return
        r = tr.dwell_remaining_sec - dt
        if held:
            r = max(r, 1.0)
        tr.dwell_remaining_sec = max(0.0, r)
        if r <= 0.0:
            tr.ready_to_depart = True

    def _profile(self, tr: Train) -> None:
        v = tr.v
        nose = tr.chainage_front_m
        extra = tr.extra_restrictions
        cands: list[tuple[float, float, str]] = []    # (v_ref, slope feed-forward, label)

        # 1) Ceiling (civil over the body, event/dispatcher cap) — flat.
        ceil = civil.ceiling_mps(nose, tr.length_m, extra)
        label = "line" if ceil >= civil.LINE_SPEED_MPS else "civil"
        cap_kph = getattr(tr, "_speed_cap_kph", None)
        if cap_kph is not None and cap_kph * KPH_TO_MPS < ceil:
            ceil = float(cap_kph) * KPH_TO_MPS
            label = "cap"
        cands.append((max(ceil - ATO_SPEED_MARGIN_MPS, 0.0), 0.0, label))

        # 2) Lower civil limits ahead: braking curve that lands smoothly on the new limit
        #    (smooth-max with the flat target so deceleration fades out at the boundary).
        for d, lim in civil.ahead(nose, tr.length_m, _CIV_LOOKAHEAD_M, extra):
            tgt = max(lim - ATO_SPEED_MARGIN_MPS, 0.5)
            if tgt >= cands[0][0]:
                continue
            base = max(tgt - _BLEND, 0.0)
            c = math.sqrt(base * base + 2.0 * _B_CIV * d)
            c_slope = -_B_CIV * v / max(c, 0.1)
            vr, ff = _smax(c, c_slope, tgt, 0.0)
            cands.append((vr, ff, "civil_ahead"))

        # 3) Next stopping point (tapered service-brake curve).
        if tr.forced_pass_idx is not None and v < 1.0:
            tr.forced_pass_idx = None          # slowed right down anyway: it can stop there now
        eff = effective_stop(tr)
        if tr.last_target_idx is not None and eff != tr.last_target_idx:
            # The target changed outside normal progress (e.g. express/skip released).  If the
            # new stop is closer than a comfortable service stop, pass it rather than slam the
            # brakes and overrun anyway.
            p_new = PLATFORMS[eff]
            d_new = (p_new.chainage_m - nose) % _L
            need = v * v / (2.0 * _B_LATE) + 0.5 * v * _B_LATE / _J + 5.0
            if not p_new.terminal and v > 1.0 and d_new < need:
                tr.forced_pass_idx = eff
                eff = effective_stop(tr)
        tr.last_target_idx = eff
        d_stop = (PLATFORMS[eff].chainage_m - nose) % _L
        vs = _taper(d_stop, _B_STOP)
        cands.append((vs, -_B_STOP * v / (vs + _VC) if d_stop > 0 else 0.0, "stop"))

        # 4) End of authority: leader tail (moves at the leader's speed) and signal at stop
        #    (fixed) are separate curves so a hand-over between them is blended, not stepped.
        d_e = tr.eoa_dist_m - ATO_EOA_MARGIN_M
        d_t = tr.eoa_train_m - ATO_EOA_MARGIN_M
        u = tr.eoa_train_speed_mps
        ve_t = _taper(d_t, _B_EOA)
        cands.append((ve_t, _B_EOA * (u - v) / (ve_t + _VC) if d_t > 0 else 0.0, "eoa"))
        if tr.eoa_signal_m != float("inf"):
            d_s = tr.eoa_signal_m - ATO_EOA_MARGIN_M
            ve_s = _taper(d_s, _B_EOA)
            cands.append((ve_s, -_B_EOA * v / (ve_s + _VC) if d_s > 0 else 0.0, "eoa"))
        ve = min(ve_t, _taper(tr.eoa_dist_m - ATO_EOA_MARGIN_M, _B_EOA))

        # Smooth minimum folded over all curves (most restrictive last): where one curve takes
        # over from another, the reference's slope ramps instead of stepping, so the
        # jerk-limited train can follow it exactly.  Each pair's blend width is sized from the
        # slope difference so the blended reference never needs more than the jerk limit.
        cands.sort(key=lambda x: -x[0])
        vref, aff, _lab = cands[0]
        for v1, a1, _l in cands[1:]:
            vref, aff = _smin(vref, aff, v1, a1)
        vref = max(vref, 0.0)
        binding = cands[-1][2]
        tr.ato_binding = binding
        tr.ato_vref = vref
        tr.hold_request = binding in ("eoa", "stop", "cap") and vref < 0.1

        # Stopped (not at a platform): restart hysteresis so trains don't inch forward.
        if v <= 0.0:
            if binding == "stop":
                if d_stop <= STOP_TOLERANCE_M or (d_e < d_stop and d_e < ATO_RESTART_M):
                    tr.a_target = 0.0
                    return
            elif binding == "eoa":
                if ve < _V_RESTART:
                    tr.a_target = 0.0
                    return

        # Jerk-aware speed error: compare the reference with the speed the train will have
        # reached by the time its acceleration can be brought to the reference's slope.
        da = tr.a - aff
        e = vref - (v + da * abs(da) / (2.0 * _J))
        if binding in ("line", "civil", "cap") and aff == 0.0 and abs(e) < ATO_COAST_BAND_MPS and vref > 0.5:
            a = 0.0                                   # coast band: hold speed, no hunting
        else:
            a = aff + _K * e
        if binding == "stop" and a > 0.0 and v > 0.5 and e < 1.0:
            a = 0.0                                   # never re-apply traction on a stop approach
        a_max = traction_limit_mps2(v)
        if a > a_max:
            a = a_max
        elif a < -SERVICE_BRAKE_MAX_MPS2:
            a = -SERVICE_BRAKE_MAX_MPS2
        tr.a_target = a

    # ── after physics: berth / pass detection ───────────────────────────────
    def post_move(self, tr: Train, nose_before: float, ds: float, sim_t: float) -> None:
        if tr.berthed_idx is not None or tr.stop_idx is None:
            return
        for _ in range(3):   # at most a couple of platforms per step
            k = tr.stop_idx
            p = PLATFORMS[k]
            d_prev = (p.chainage_m - nose_before) % _L
            serve = will_stop(tr, p)
            if ds >= d_prev - 1e-9 and ds > 0.0:
                over = ds - d_prev
                if serve and tr.v <= STOP_SNAP_MPS * 5 and over <= STOP_TOLERANCE_M:
                    self.berth_now(tr, k, sim_t, error_m=-over)
                    return
                if serve and tr.v <= _BERTH_OVERRUN_MPS and over <= _BERTH_OVERRUN_M:
                    # Small low-speed overrun: platform (~150 m) is longer than the train, so the
                    # doors still open.  Recorded as an imprecise stop, never a missed one.
                    self.berth_now(tr, k, sim_t, error_m=-over)
                    return
                if tr.forced_pass_idx == k:
                    why = "late_release"
                    tr.forced_pass_idx = None
                else:
                    why = "overrun" if serve else "skip"
                    if not serve and not tr._op_express:
                        tr._op_skip_remaining = max(0, int(tr._op_skip_remaining) - 1)
                tr.pass_log.append((sim_t, k, why))
                tr.stop_idx = (k + 1) % N_PLATFORMS
                if self.on_pass:
                    self.on_pass(tr, k, why, sim_t)
                continue
            # Not crossed: berth if (nearly) at rest within tolerance of the stopping point.
            d_now = d_prev - ds
            if serve and d_now <= STOP_TOLERANCE_M and tr.v <= STOP_SNAP_MPS:
                self.berth_now(tr, k, sim_t, error_m=d_now)
            return
