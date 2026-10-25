"""Train: physics (jerk-limited, metres / m/s) and onboard ATP supervision.

Control split (CBTC):
  * zone_controller.py — wayside: issues movement authority (EOA) to each train.
  * ATP (here)         — onboard: supervises an emergency-brake curve to the EOA and the civil
                          ceiling; trips the emergency brake if the train could overrun.
  * ato.py             — onboard: tracks a speed profile that stays BELOW the ATP curve and
                          produces a continuous acceleration demand.  In normal operation ATP
                          never intervenes.

Only the train integrates its own speed and position; ``speed`` published to clients is this
integrated physical speed.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any

import civil
from ma_constants import (
    ATP_EB_RESET_S,
    ATP_OVERSPEED_KPH,
    ATP_REACTION_S,
    DESIGN_MAX_KPH,
    EB_BUILDUP_MPS3,
    EMERGENCY_BRAKE_MPS2,
    GEBR_MPS2,
    JERK_LIMIT_MPS3,
    KPH_TO_MPS,
    MPS_TO_KPH,
    RESIST_A_MPS2,
    RESIST_B_MPS2_PER_KPH,
    RESIST_C_MPS2_PER_KPH2,
    SERVICE_BRAKE_MAX_MPS2,
    STOP_SNAP_MPS,
    TRACTION_BASE_KPH,
    TRACTION_KNEE2_KPH,
    TRACTION_MAX_MPS2,
    TRAIN_LENGTH_M,
    ZC_SAFETY_MARGIN_M,
)
from route_geom import ROUTE_LEN_M

TRAIN_LOG_MAXLEN = 160          # per-train berth/depart/pass history kept (~2 round trips)


class BoundedLog(list):
    """A list that keeps only its newest ``maxlen`` items (list semantics: slicing, == [])."""

    __slots__ = ("maxlen",)

    def __init__(self, maxlen: int, items=()) -> None:
        super().__init__(items)
        self.maxlen = maxlen
        if len(self) > maxlen:
            del self[: len(self) - maxlen]

    def append(self, item) -> None:   # type: ignore[override]
        super().append(item)
        if len(self) > self.maxlen:
            del self[0]

_V_BASE = TRACTION_BASE_KPH * KPH_TO_MPS
_V_KNEE2 = TRACTION_KNEE2_KPH * KPH_TO_MPS
_V_DESIGN = DESIGN_MAX_KPH * KPH_TO_MPS
_ATP_OVERSPEED = ATP_OVERSPEED_KPH * KPH_TO_MPS


def _json_safe(obj):
    if isinstance(obj, float):
        if math.isinf(obj) or math.isnan(obj):
            return None
        return obj
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    return obj


def running_resistance_mps2(v: float) -> float:
    """Rolling + aerodynamic resistance at speed v (m/s), as a deceleration."""
    kph = v * MPS_TO_KPH
    return RESIST_A_MPS2 + RESIST_B_MPS2_PER_KPH * kph + RESIST_C_MPS2_PER_KPH2 * kph * kph


def traction_limit_mps2(v: float) -> float:
    """Max net acceleration at speed v (m/s): constant torque, then constant power, then the
    motors' natural characteristic (∝ 1/v²), less running resistance."""
    if v >= _V_DESIGN:
        return 0.0
    if v <= _V_BASE:
        tractive = TRACTION_MAX_MPS2
    elif v <= _V_KNEE2:
        tractive = TRACTION_MAX_MPS2 * _V_BASE / v
    else:
        tractive = TRACTION_MAX_MPS2 * _V_BASE / _V_KNEE2 * (_V_KNEE2 / v) ** 2
    return max(0.0, tractive - running_resistance_mps2(v))


def atp_stopping_distance_m(v: float, a: float) -> float:
    """Worst-case distance to stop if the EB were commanded now (IEEE 1474-style):
    the train may keep accelerating at ``a`` for the reaction time, then brakes at GEBR."""
    ap = a if a > 0.0 else 0.0
    t = ATP_REACTION_S
    v1 = v + ap * t
    return v * t + 0.5 * ap * t * t + v1 * v1 / (2.0 * GEBR_MPS2)


@dataclass
class TrainCommand:
    """Narrow external command API (driver / events).  ``acceleration_level`` is advisory."""
    direction: int
    acceleration_level: float
    e_brake: bool = False


class Train:
    def __init__(
        self,
        chainage_front_m: float = 0.0,
        direction: int = 1,
        run_number: int | None = None,
        length_m: float = TRAIN_LENGTH_M,
    ) -> None:
        self.chainage_front_m = float(chainage_front_m) % ROUTE_LEN_M
        self.length_m = float(length_m)
        self.v = 0.0                    # m/s, integrated physical speed
        self.a = 0.0                    # m/s², applied (signed)
        self.a_target = 0.0             # ATO demand before jerk limiting
        self.hold_request = False       # ATO asks for the holding brake once (nearly) at rest
        self.direction = direction      # always +1 along the ring
        self.e_brake = False            # external / driver emergency brake (events)
        self.acceleration_level = 0.0
        self.run_number = run_number

        # ── ZC-issued authority ──
        self.eoa_dist_m: float = float("inf")
        self.eoa_source: str | None = None      # 'train_ahead' | 'signal' | None
        self.eoa_speed_mps: float = 0.0         # speed the EOA point moves at (leader speed)
        self.eoa_signal_id: str | None = None
        self.eoa_train_m: float = float("inf")       # leader-based component
        self.eoa_train_speed_mps: float = 0.0
        self.eoa_signal_m: float = float("inf")      # signal-based component
        self.authority_eoa_m: float | None = None
        self.leader_run_number: int | None = None
        self.gap_to_leader_m: float | None = None
        self._respected_signals: set[str] = set()
        self._committed_signals: set[str] = set()

        # ── ATP ──
        self.atp_eb = False
        self.atp_trips = 0
        self.atp_last_reason: str | None = None
        self._atp_standstill_s = 0.0
        self.required_gap_m: float = 0.0
        self.atp_slack_m: float = float("inf")

        # ── ATO / service state ──
        self.stop_idx: int | None = None        # ring index of the next platform in route order
        self.berthed_idx: int | None = None     # ring index while berthed at a platform
        self.last_target_idx: int | None = None # ATO's stop target last step (detects order changes)
        self.forced_pass_idx: int | None = None # platform to pass: target appeared too close to stop
        self.dwell_remaining_sec: float = 0.0
        self.dwell_total_sec: float = 0.0
        self.at_station_name: str = ""
        self.ato_binding: str = "line"
        self.ato_vref: float = 0.0
        self.ready_to_depart = False
        self.to_yard: str | None = None         # yard name when running out of service
        self.removed = False
        self.extra_restrictions: list[tuple[float, float, float]] = []   # (start, end, limit m/s)
        self.stationary_s = 0.0
        # Bounded recent history (memory stays flat however long the sim runs).
        self.berth_log: BoundedLog = BoundedLog(TRAIN_LOG_MAXLEN)    # (sim_t, ring_index, error_m)
        self.pass_log: BoundedLog = BoundedLog(TRAIN_LOG_MAXLEN)     # (sim_t, ring_index, why)
        self.depart_log: BoundedLog = BoundedLog(TRAIN_LOG_MAXLEN)   # (sim_t, ring_index)
        self.berth_count = 0

        # ── Operator overrides (set via /commands/train/{id}) ──
        self._op_hold: bool = False
        self._op_skip_remaining: int = 0
        self._op_express: bool = False

    # ── Back-compat accessors ───────────────────────────────────────────────
    @property
    def speed(self) -> float:
        """Speed in km/h (legacy unit used by events / ML snapshot)."""
        return self.v * MPS_TO_KPH

    @speed.setter
    def speed(self, kph: float) -> None:
        self.v = max(0.0, float(kph)) * KPH_TO_MPS

    @property
    def acceleration(self) -> float:
        return self.a

    @property
    def position(self) -> float:
        return self.chainage_front_m

    @position.setter
    def position(self, value: float) -> None:
        self.chainage_front_m = float(value) % ROUTE_LEN_M

    @property
    def stop_index(self) -> int:
        """Legacy: station stop_index (0..37) of the next stop."""
        from stations import PLATFORMS
        k = self.berthed_idx if self.berthed_idx is not None else self.stop_idx
        return PLATFORMS[k].stop_index if k is not None else 0

    @property
    def train_id(self) -> str:
        return f"T{int(self.run_number or 0):02d}"

    def apply_command(self, command: TrainCommand) -> None:
        self.direction = 1
        self.e_brake = bool(command.e_brake)
        self.acceleration_level = float(command.acceleration_level)

    # ── ATP ─────────────────────────────────────────────────────────────────
    def atp_supervise(self, dt: float) -> None:
        """Onboard ATP: EB curve to EOA, civil ceiling (+tolerance), lower limits ahead."""
        v, a = self.v, self.a
        s_stop = atp_stopping_distance_m(v, a)
        self.required_gap_m = s_stop + ZC_SAFETY_MARGIN_M
        d_eoa = self.eoa_dist_m
        self.atp_slack_m = d_eoa - s_stop
        if self.atp_eb:
            if v <= 0.0:
                self._atp_standstill_s += dt
                if self._atp_standstill_s >= ATP_EB_RESET_S:
                    self.atp_eb = False
                    self._atp_standstill_s = 0.0
            return
        if v <= 0.0:
            return
        reason = None
        if s_stop > d_eoa + 1e-6:
            reason = "eoa"
        else:
            ceiling = civil.ceiling_mps(self.chainage_front_m, self.length_m)
            if v > ceiling + _ATP_OVERSPEED:
                reason = "overspeed"
            else:
                t = ATP_REACTION_S
                ap = a if a > 0 else 0.0
                v1 = v + ap * t
                for d, lim in civil.ahead(self.chainage_front_m, self.length_m, 2000.0):
                    room = d - v * t - 0.5 * ap * t * t
                    vl = lim + _ATP_OVERSPEED
                    if v1 > vl and v1 * v1 - vl * vl > 2.0 * GEBR_MPS2 * max(room, 0.0):
                        reason = "civil_ahead"
                        break
        if reason is not None:
            self.atp_eb = True
            self.atp_trips += 1
            self.atp_last_reason = reason
            self._atp_standstill_s = 0.0

    # ── Physics ─────────────────────────────────────────────────────────────
    def integrate(self, dt: float) -> float:
        """Advance one step; returns distance travelled (m)."""
        v0 = self.v
        if self.e_brake or self.atp_eb:
            target = -EMERGENCY_BRAKE_MPS2 if v0 > 0.0 else 0.0
            step = EB_BUILDUP_MPS3 * dt
        else:
            target = self.a_target
            step = JERK_LIMIT_MPS3 * dt
        a = self.a
        if target > a + step:
            a += step
        elif target < a - step:
            a -= step
        else:
            a = target
        # Envelope: never exceed traction / service-brake limits (EB may go to EB rate).
        a_max = traction_limit_mps2(v0)
        if a > a_max:
            a = a_max
        if not (self.e_brake or self.atp_eb) and a < -SERVICE_BRAKE_MAX_MPS2:
            a = -SERVICE_BRAKE_MAX_MPS2
        v1 = v0 + a * dt
        if self.hold_request and v0 < STOP_SNAP_MPS and a <= 0.0:
            # Holding brake engages at crawl speed: the train comes to rest.
            ds = 0.5 * v0 * dt
            self.v = 0.0
            self.a = 0.0
            self.acceleration_level = 0.0
            if ds:
                self.chainage_front_m = (self.chainage_front_m + ds) % ROUTE_LEN_M
            return ds
        if v1 <= 0.0:
            # Comes to rest within the step.
            ds = (v0 * v0 / (-2.0 * a)) if a < 0.0 else 0.0
            if ds > v0 * dt:
                ds = v0 * dt
            v1 = 0.0
            a = 0.0
        else:
            ds = 0.5 * (v0 + v1) * dt
        self.v = v1
        self.a = a
        self.acceleration_level = round(3.0 * a / TRACTION_MAX_MPS2, 3)
        if ds:
            self.chainage_front_m = (self.chainage_front_m + ds) % ROUTE_LEN_M
        return ds

    def step(self, dt: float, route_len: float = ROUTE_LEN_M) -> None:
        """Standalone physics step (no ATO): keeps the current demand."""
        if dt > 0:
            self.integrate(dt)


class Line:
    def __init__(self, name: str, trains: list[Train]) -> None:
        self.name = name
        self.trains = trains


def getState() -> str:
    """Legacy JSON dump of raw train state (not used by /state any more)."""
    states = []
    for line in lines:
        states.append({
            "name": line.name,
            "trains": [
                {
                    "chainage_front_m": t.chainage_front_m,
                    "position": t.chainage_front_m,
                    "length_m": t.length_m,
                    "speed": t.speed,
                    "acceleration": t.a,
                    "acceleration_level": t.acceleration_level,
                    "direction": t.direction,
                    "e_brake": t.e_brake,
                    "run_number": t.run_number,
                    "leader_run_number": t.leader_run_number,
                    "gap_to_leader_m": t.gap_to_leader_m,
                    "required_gap_m": t.required_gap_m,
                    "atp_slack_m": t.atp_slack_m,
                    "authority_eoa_m": t.authority_eoa_m,
                    "dwell_remaining_sec": t.dwell_remaining_sec,
                    "at_station_name": t.at_station_name,
                    "stop_index": t.stop_index,
                    "op_hold": t._op_hold,
                    "op_express": t._op_express,
                    "op_skip_remaining": t._op_skip_remaining,
                }
                for t in line.trains
            ],
        })
    return json.dumps(_json_safe(states))


# The process-wide line list.  sim.Simulation() populates it with the opening roster.
lines: list[Line] = [Line("YUS", [])]
