"""Operator / incident scenarios on a full roster: trains respond smoothly, ATP stays quiet."""

from __future__ import annotations

import commands
from events import registry
from ma_constants import SIGNAL_EOA_OFFSET_M
from route_geom import ROUTE_LEN_M
from sim import DT
from simhelpers import lone_train_sim, make_sim

_L = ROUTE_LEN_M


def _approaching(s, sig, lo=900.0, hi=1700.0):
    best = None
    for tr in s.lines[0].trains:
        d = (sig.ch - tr.chainage_front_m) % _L
        if lo <= d <= hi and (best is None or d < best[0]):
            best = (d, tr)
    return best[1] if best else None


def _max_decel_and_trips(s, trains, seconds):
    worst = 0.0
    for _ in range(int(seconds / DT)):
        s.step(DT)
        for tr in trains:
            if not (tr.e_brake or tr.atp_eb):
                worst = max(worst, -tr.a)
    return worst


def test_operator_red_signal_stops_next_train_smoothly_then_releases():
    s, line = make_sim(seed=11)
    sig = next(x for x in s.interlocking.signals if x.role == "mid_home")
    tr = None
    for _ in range(int(600 / DT)):
        tr = _approaching(s, sig)
        if tr is not None and tr.berthed_idx is None and tr.v > 15.0:
            break
        s.step(DT)
    assert tr is not None
    commands.set_signal(sig.id, "red")
    worst = _max_decel_and_trips(s, [tr], 150)
    assert tr.v == 0.0 and tr.berthed_idx is None
    d = (sig.ch - tr.chainage_front_m) % _L
    assert SIGNAL_EOA_OFFSET_M <= d <= 15.0          # stopped just short of the signal
    assert worst <= 1.0
    assert s.train_payload(tr)["stop_reason"] == "signal"
    assert s.interlocking.aspects[sig.id] == "red"
    commands.set_signal(sig.id, "auto")
    for _ in range(int(60 / DT)):
        s.step(DT)
    assert (tr.chainage_front_m - sig.ch) % _L < _L / 2   # passed the signal
    assert s.atp_trip_count() == 0


def test_signal_fail_event_holds_trains_then_clears():
    s, line = make_sim(seed=12)
    sig = next(x for x in s.interlocking.signals if x.role == "terminal_home" and x.interlocking == "Finch")
    inc = registry.inject(lines=s.lines, kind="signal_fail", sim_time_s=s._sim_time_s,
                          duration_s=240.0, target_signal_id=sig.id)
    s.run(200)
    assert s.interlocking.aspects[sig.id] == "red"
    stopped = [t for t in line.trains if t.v == 0.0 and t.berthed_idx is None
               and (sig.ch - t.chainage_front_m) % _L < 20.0]
    assert stopped, "next train should be waiting at the failed signal"
    s.run(240)
    assert inc.id not in registry._incidents
    assert all(t.stationary_s < 60.0 for t in line.trains)
    assert s.atp_trip_count() == 0


def test_reversed_mid_crossover_blocks_through_routes():
    s, line = make_sim(seed=13)
    commands.set_switch("sw_mid_27", "reverse")
    s.run(240)
    protecting = [x for x in s.interlocking.signals if x.switch_id == "sw_mid_27"]
    assert len(protecting) == 2
    assert all(s.interlocking.aspects[x.id] == "red" for x in protecting)
    assert s.interlocking.switch_states["sw_mid_27"] == "reverse"
    for x in protecting:
        # On each track the next train is waiting just short of the protecting signal
        # (at the platform for a starter, in the tunnel for a home signal).
        waiting = [t for t in line.trains
                   if (x.ch - t.chainage_front_m) % _L <= 20.0 and t.v == 0.0]
        assert len(waiting) == 1, x.name
        reason = s.train_payload(waiting[0])["stop_reason"]
        assert reason == "signal", (x.name, reason)
    commands.set_switch("sw_mid_27", "normal")
    s.run(300)
    assert all(t.stationary_s < 90.0 for t in line.trains)
    assert s.atp_trip_count() == 0


def test_emergency_brake_event_follower_stops_smoothly():
    s, line = make_sim(seed=14)
    s.run(60)
    leader = next(t for t in line.trains if t.v > 18.0 and t.berthed_idx is None)
    follower = next(t for t in line.trains if t.leader_run_number == leader.run_number)
    registry.inject(lines=s.lines, kind="emergency_brake", sim_time_s=s._sim_time_s,
                    duration_s=180.0, target_train_id=leader.train_id)
    s.run(30)
    assert leader.v == 0.0
    assert s.train_payload(leader)["stop_reason"] == "emergency_brake"
    worst = _max_decel_and_trips(s, [follower], 150)
    assert worst <= 1.0
    assert follower.gap_to_leader_m >= 15.0
    assert follower.atp_trips == 0
    s.run(240)        # EB released: leader resumes
    assert leader.v > 0.0 or leader.berthed_idx is not None


def test_slow_speed_event_brakes_smoothly_to_cap():
    p_ch = 30_500.0     # Eglinton → Lawrence, long plain-line run on the ob leg
    s, line, tr = lone_train_sim(p_ch, v_mps=21.9)
    registry.inject(lines=s.lines, kind="slow_speed", sim_time_s=0.0, duration_s=120.0,
                    target_train_id=tr.train_id, speed_limit_kph=30.0)
    worst = 0.0
    prev = tr.v
    for _ in range(int(40 / DT)):
        s.step(DT)
        assert prev - tr.v <= 1.1 * DT + 1e-9      # no jumps in integrated speed
        prev = tr.v
        worst = max(worst, -tr.a)
    assert tr.v * 3.6 <= 30.0 + 0.3
    assert worst <= 1.1


def test_station_hold_and_door_fault_hold_at_platform_never_freeze_a_moving_train():
    from stations import platform_by
    p = platform_by("College", "ob")
    for kind in ("station_hold", "door_fault"):
        registry._incidents.clear()
        s, line, tr = lone_train_sim(p.chainage_m - 350.0, v_mps=12.0)
        registry.inject(lines=s.lines, kind=kind, sim_time_s=0.0, duration_s=150.0,
                        target_train_id=tr.train_id)
        s.step(DT)
        assert tr.v > 11.0                               # still moving
        s.run(100)
        assert tr.berthed_idx == p.ring_index           # held at the platform …
        s.run(100)
        assert tr.berthed_idx is None or tr.depart_log  # … released after the incident
        assert tr.depart_log and tr.depart_log[-1][1] == p.ring_index
