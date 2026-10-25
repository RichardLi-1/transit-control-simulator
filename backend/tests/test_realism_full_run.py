"""End-to-end realism guards over a full simulated service period.

One session-scoped run: 06:00 → 08:15 sim time (2 h 15 min), opening roster + yard
insertions, ML dispatch service unreachable (rule fallback).  Metrics are recorded every step
for EVERY train, then each test asserts one property.

These tests would have caught the original bug: under the old ATO, trains reaching North
York Ctr wrapped their stop index to Vaughan's outbound berth, saw it as "passed" by the
short way round the ring, and ran the entire inbound leg without stopping.
"""

from __future__ import annotations

from collections import defaultdict

import pytest

import civil
from ma_constants import (
    JERK_LIMIT_MPS3,
    SERVICE_BRAKE_MAX_MPS2,
    STOP_TOLERANCE_M,
    TRACTION_MAX_MPS2,
    ZC_SAFETY_MARGIN_M,
)
from stations import BUSY_STATIONS, N_PLATFORMS, PLATFORMS
from simhelpers import make_sim

RUN_S = 2.25 * 3600
SEED = 7


class _Recorder:
    def __init__(self) -> None:
        self.prev_a: dict[int, float] = {}
        self.prev_v: dict[int, float] = {}
        self.prev_eb: dict[int, bool] = {}
        self.max_jerk = 0.0
        self.max_jerk_ctx = None
        self.max_accel = 0.0
        self.max_service_decel = 0.0
        self.max_decel_ctx = None
        self.max_speed_kph = 0.0
        self.max_civil_excess_kph = 0.0
        self.min_gap = float("inf")
        self.max_stationary = 0.0
        self.first_stop: dict[int, int] = {}
        # cruise windows: run -> [vref, settled, vmin, vmax, last_sign, flips, t0, t_last]
        self.cruise: dict[int, list] = {}
        self.cruise_done: list[tuple] = []
        # stop approaches: run -> [onset_seen, v_prev, ok]
        self.approach: dict[int, list] = {}
        self.approach_results: list[tuple] = []
        self.samples = 0

    def __call__(self, s) -> None:
        t = s._sim_time_s
        for tr in s.lines[0].trains:
            rn = tr.run_number
            self.samples += 1
            if rn not in self.first_stop:
                self.first_stop[rn] = tr.stop_idx
            v, a = tr.v, tr.a
            eb = tr.e_brake or tr.atp_eb
            self.max_speed_kph = max(self.max_speed_kph, v * 3.6)
            ceil = civil.ceiling_mps(tr.chainage_front_m, tr.length_m)
            self.max_civil_excess_kph = max(self.max_civil_excess_kph, (v - ceil) * 3.6)
            if not eb and not self.prev_eb.get(rn, False):
                self.max_accel = max(self.max_accel, a)
                if -a > self.max_service_decel:
                    self.max_service_decel = -a
                    self.max_decel_ctx = (t, tr.train_id, tr.ato_binding, round(v, 2), tr.eoa_source,
                                          round(tr.eoa_dist_m, 1), tr.stop_idx)
                pa = self.prev_a.get(rn)
                if pa is not None:
                    j = abs(a - pa) / 0.2
                    if j > self.max_jerk:
                        self.max_jerk = j
                        self.max_jerk_ctx = (t, tr.train_id, tr.ato_binding, v, pa, a)
            self.prev_a[rn] = a
            self.prev_eb[rn] = eb
            if tr.gap_to_leader_m is not None:
                self.min_gap = min(self.min_gap, tr.gap_to_leader_m)
            self.max_stationary = max(self.max_stationary, tr.stationary_s)

            # Cruise windows: flat limit binding with a constant reference.
            b = tr.ato_binding
            w = self.cruise.get(rn)
            if b in ("line", "civil") and tr.berthed_idx is None:
                if w is None or abs(w[0] - tr.ato_vref) > 1e-9:
                    if w is not None:
                        self.cruise_done.append(tuple(w))
                    w = [tr.ato_vref, False, v, v, 0, 0, t, t]
                    self.cruise[rn] = w
                if not w[1] and abs(v - w[0]) * 3.6 < 0.3:
                    w[1] = True
                    w[2] = w[3] = v
                    w[6] = t
                if w[1]:
                    w[2] = min(w[2], v)
                    w[3] = max(w[3], v)
                    sign = 1 if a > 0.01 else (-1 if a < -0.01 else 0)
                    if sign != 0 and w[4] != 0 and sign != w[4]:
                        w[5] += 1
                    if sign != 0:
                        w[4] = sign
                    w[7] = t
            elif w is not None:
                self.cruise_done.append(tuple(w))
                self.cruise.pop(rn, None)

            # Station approaches: from brake onset (first a <= 0 under 'stop' binding) to berth,
            # speed must never increase.
            ap = self.approach.get(rn)
            if b == "stop" and tr.berthed_idx is None and v > 0.0:
                if ap is None:
                    ap = [False, v, True, t]
                    self.approach[rn] = ap
                if not ap[0] and a <= 0.0:
                    ap[0] = True
                    ap[1] = v
                elif ap[0]:
                    if v > ap[1] + 1e-9:
                        ap[2] = False
                    ap[1] = v
            elif ap is not None:
                if tr.berthed_idx is not None and ap[0]:
                    self.approach_results.append((rn, ap[3], ap[2]))
                self.approach.pop(rn, None)
            self.prev_v[rn] = v


@pytest.fixture(scope="module")
def run():
    s, line = make_sim(seed=SEED)
    rec = _Recorder()
    s.run(RUN_S, on_step=rec)
    trains = line.trains + list(s.removed_trains)
    return s, line, trains, rec


# ── Stops ──────────────────────────────────────────────────────────────────────
def test_every_train_stops_at_every_platform_in_order(run):
    s, line, trains, rec = run
    assert len(trains) >= 50
    for tr in trains:
        seq = [k for (_t, k, _e) in tr.berth_log]
        assert len(seq) >= 40, f"{tr.train_id} only berthed {len(seq)} times"
        assert seq[0] == rec.first_stop[tr.run_number], f"{tr.train_id} skipped its first stop"
        for a, b in zip(seq, seq[1:]):
            assert b == (a + 1) % N_PLATFORMS, (
                f"{tr.train_id}: {PLATFORMS[a].name}({PLATFORMS[a].leg}) -> "
                f"{PLATFORMS[b].name}({PLATFORMS[b].leg}) skips platforms")
        assert len(tr.pass_log) == 0, f"{tr.train_id} passed platforms without an order: {list(tr.pass_log)[:3]}"
    assert len(s.missed_stops) == 0 and s.missed_stop_count == 0


def test_both_directions_and_terminals_served(run):
    _s, _line, trains, _rec = run
    served = {k for tr in trains for (_t, k, _e) in tr.berth_log}
    assert served == set(range(N_PLATFORMS))
    # A train that ran the whole inbound leg stopped at all 38 inbound platforms in order.
    full_ib = 0
    fin_dep = next(p.ring_index for p in PLATFORMS if p.name == "Finch" and p.role == "departure")
    vmc_arr = N_PLATFORMS - 1
    for tr in trains:
        seq = [k for (_t, k, _e) in tr.berth_log]
        if fin_dep in seq and vmc_arr in seq[seq.index(fin_dep):]:
            i = seq.index(fin_dep)
            j = seq.index(vmc_arr, i)
            assert seq[i:j + 1] == list(range(fin_dep, vmc_arr + 1))
            full_ib += 1
    assert full_ib >= 10


def test_stop_precision(run):
    _s, _line, trains, _rec = run
    errs = [abs(e) for tr in trains for (_t, _k, e) in tr.berth_log]
    assert len(errs) > 3000
    assert max(errs) <= STOP_TOLERANCE_M


# ── Safety ─────────────────────────────────────────────────────────────────────
def test_moving_block_separation_never_violated(run):
    _s, _line, _trains, rec = run
    assert rec.min_gap >= ZC_SAFETY_MARGIN_M - 1e-6


def test_atp_never_intervenes_in_normal_operation(run):
    s, _line, _trains, _rec = run
    assert s.atp_trip_count() == 0


# ── Liveness ───────────────────────────────────────────────────────────────────
def test_no_train_stuck_outside_a_platform(run):
    s, line, _trains, rec = run
    assert rec.max_stationary <= 180.0
    # No deadlock: every train in service kept making progress until the end.
    end = s._sim_time_s
    for tr in line.trains:
        last = tr.berth_log[-1][0] if tr.berth_log else 0.0
        assert end - last < 900.0, f"{tr.train_id} has not berthed for {end - last:.0f} s"


# ── Dynamics ───────────────────────────────────────────────────────────────────
def test_speed_accel_jerk_within_rolling_stock_limits(run):
    _s, _line, _trains, rec = run
    assert rec.max_speed_kph <= 80.0 + 1e-6
    assert rec.max_accel <= TRACTION_MAX_MPS2 + 1e-9
    assert rec.max_service_decel <= 1.0, ("ATO braking should stay at comfort levels", rec.max_decel_ctx)
    assert rec.max_service_decel <= SERVICE_BRAKE_MAX_MPS2
    assert rec.max_jerk <= JERK_LIMIT_MPS3 + 1e-6, rec.max_jerk_ctx


def test_civil_limits_respected(run):
    _s, _line, _trains, rec = run
    assert rec.max_civil_excess_kph <= 0.5


def test_cruise_is_steady_no_oscillation(run):
    """While cruising under a constant limit, after settling: speed within ±0.3 km/h and
    acceleration changes sign at most once per 30 s (no traction/brake hunting)."""
    _s, _line, _trains, rec = run
    windows = [w for w in rec.cruise_done if w[1] and w[7] - w[6] >= 10.0]
    assert len(windows) > 500
    for vref, _settled, vmin, vmax, _ls, flips, t0, t1 in windows:
        assert (vmax - vref) * 3.6 <= 0.3 and (vref - vmin) * 3.6 <= 0.3, (vref * 3.6, vmin * 3.6, vmax * 3.6)
        assert flips <= 1 + (t1 - t0) / 30.0, (flips, t1 - t0)


def test_station_approach_speed_is_monotonic(run):
    _s, _line, _trains, rec = run
    assert len(rec.approach_results) > 2000
    bad = [r for r in rec.approach_results if not r[2]]
    assert bad == []


# ── Service ────────────────────────────────────────────────────────────────────
def test_end_to_end_trip_time_is_realistic(run):
    _s, _line, trains, _rec = run
    finch_arr = next(p.ring_index for p in PLATFORMS if p.name == "Finch" and p.role == "arrival")
    trips = []
    for tr in trains:
        log = list(tr.berth_log)
        for i, (t, k, _e) in enumerate(log):
            if k == 0:
                later = [x for (x, kk, _) in log[i:] if kk == finch_arr]
                if later:
                    trips.append(later[0] - t)
    assert len(trips) >= 10
    # Real Line 1 Vaughan MC → Finch is roughly 65–75 min.
    assert all(60 * 60 <= x <= 76 * 60 for x in trips), (min(trips) / 60, max(trips) / 60)


def test_terminal_turnbacks(run):
    _s, _line, trains, _rec = run
    for term in ("Finch", "Vaughan MC"):
        arr = next(p.ring_index for p in PLATFORMS if p.name == term and p.role == "arrival")
        dep = next(p.ring_index for p in PLATFORMS if p.name == term and p.role == "departure")
        durations = []
        for tr in trains:
            arrivals = [t for (t, k, _e) in tr.berth_log if k == arr]
            departs = [t for (t, k) in tr.depart_log if k == dep]
            for ta in arrivals:
                later = [td for td in departs if td > ta]
                if later:
                    durations.append(later[0] - ta)
        assert len(durations) >= 10, term
        # arrive → (alight, change ends) → crossover → board → regulated departure
        assert all(110.0 <= d <= 300.0 for d in durations), (term, min(durations), max(durations))


def test_dwell_times_vary_and_busy_stations_dwell_longer(run):
    _s, _line, trains, _rec = run
    dwell = defaultdict(list)
    for tr in trains:
        for (tb, kb, _e) in tr.berth_log:
            p = PLATFORMS[kb]
            if p.terminal:
                continue
            nxt = [td for (td, kd) in tr.depart_log if kd == kb and td > tb]
            if nxt:
                dwell["busy" if p.name in BUSY_STATIONS else "ordinary"].append(nxt[0] - tb)
    ordinary, busy = dwell["ordinary"], dwell["busy"]
    mean_o = sum(ordinary) / len(ordinary)
    mean_b = sum(busy) / len(busy)
    assert 20.0 <= mean_o <= 35.0
    assert 35.0 <= mean_b <= 60.0
    assert max(ordinary) - min(ordinary) > 5.0   # seeded variation, not a constant


def test_headway_and_trains_in_service(run):
    s, line, _trains, _rec = run
    svc = s.service_status(line)
    assert svc["period"] == "AM peak"
    assert svc["mean_headway_s"] is not None
    assert abs(svc["mean_headway_s"] - svc["target_headway_s"]) <= 0.15 * svc["target_headway_s"]
    assert abs(svc["trains_in_service"] - svc["target_trains"]) <= 2
    assert s._dispatch_count >= 1, "yard insertions should have happened"


def test_dispatch_works_with_ml_down(run):
    s, line, _trains, _rec = run
    status = s.dispatch_status(line)
    assert status["bias_source"] == "fallback"
    assert status["effective_headway_sec"] >= 60.0
