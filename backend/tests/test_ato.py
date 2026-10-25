"""ATO: profile tracking, precise stops, dispatcher orders (skip / express / hold).

Replaces the old tests that encoded overshoot-latching and a wrapping outbound-only stop
index (the root cause of trains running the inbound leg without stopping).
"""

from __future__ import annotations

import commands
import train as trainmod
from ato import effective_stop, will_stop
from ma_constants import STOP_TOLERANCE_M
from route_geom import ROUTE_LEN_M
from sim import DT
from stations import N_PLATFORMS, PLATFORMS, platform_by
from simhelpers import lone_train_sim


def _run_until(s, pred, max_s):
    for _ in range(int(max_s / DT)):
        s.step(DT)
        if pred():
            return True
    return False


def test_lone_train_from_cruise_stops_precisely_at_next_platform():
    p = platform_by("Eglinton West", "ob")
    s, _line, tr = lone_train_sim(p.chainage_m - 850.0, v_mps=21.0)
    assert PLATFORMS[tr.stop_idx].name == "Eglinton West"
    assert _run_until(s, lambda: tr.berthed_idx is not None, 300)
    assert tr.berthed_idx == p.ring_index
    assert abs(tr.berth_log[-1][2]) <= STOP_TOLERANCE_M
    assert tr.at_station_name == "Eglinton West"
    assert s.train_payload(tr)["station_name"] == "Eglinton West"


def test_inbound_platforms_are_stop_targets():
    """The old ATO only knew outbound berths.  A train on the inbound leg must target the
    next inbound platform."""
    p = platform_by("Lawrence", "ib")
    s, _line, tr = lone_train_sim(p.chainage_m - 900.0, v_mps=15.0)
    assert PLATFORMS[tr.stop_idx] == p
    assert _run_until(s, lambda: tr.berthed_idx is not None, 300)
    assert PLATFORMS[tr.berthed_idx] == p


def test_departure_goes_to_the_next_platform_in_ring_order():
    p = platform_by("North York Ctr", "ob")
    s, _line, tr = lone_train_sim(p.chainage_m - 600.0, v_mps=12.0)
    seen = []
    for _ in range(int(900 / DT)):
        s.step(DT)
        if tr.berth_log and (not seen or seen[-1] != tr.berth_log[-1][1]):
            seen.append(tr.berth_log[-1][1])
        if len(seen) >= 4:
            break
    names = [(PLATFORMS[k].name, PLATFORMS[k].role) for k in seen]
    assert names == [("North York Ctr", "through"), ("Finch", "arrival"),
                     ("Finch", "departure"), ("North York Ctr", "through")]
    assert PLATFORMS[seen[-1]].leg == "ib"


def test_constant_speed_cruise_holds_steady():
    # Long run with no stop for a while: Eglinton → Lawrence (≈2.4 km) on the ob leg.
    p = platform_by("Eglinton", "ob")
    s, _line, tr = lone_train_sim(p.chainage_m + 5.0, v_mps=0.0)
    vs, acc = [], []
    for _ in range(int(120 / DT)):
        s.step(DT)
        # Cruise = the flat line-speed limit is the reference (not yet blending into a stop).
        if tr.ato_binding == "line" and abs(tr.ato_vref - (80.0 / 3.6 - 0.3)) < 1e-9:
            vs.append(tr.v * 3.6)
            acc.append(tr.a)
    settled = [v for v in vs if abs(v - 78.9) < 0.3]
    assert len(settled) > 50
    i0 = vs.index(settled[0])
    tail = vs[i0:]
    assert max(tail) - min(tail) <= 0.6
    flips = sum(1 for a, b in zip(acc[i0:], acc[i0 + 1:]) if (a > 0.01 and b < -0.01) or (a < -0.01 and b > 0.01))
    assert flips <= 1


def test_skip_order_passes_next_stations_then_stops():
    p = platform_by("Dupont", "ob")
    s, _line, tr = lone_train_sim(p.chainage_m - 1200.0, v_mps=20.0)
    tr._op_skip_remaining = 2
    assert PLATFORMS[effective_stop(tr)].name == "St George"
    assert _run_until(s, lambda: tr.berthed_idx is not None, 400)
    assert PLATFORMS[tr.berthed_idx].name == "St George"
    assert [PLATFORMS[k].name for (_t, k, why) in tr.pass_log] == ["Dupont", "Spadina"]
    assert all(why == "skip" for (_t, _k, why) in tr.pass_log)
    assert tr._op_skip_remaining == 0


def test_express_never_skips_a_terminal():
    p = platform_by("Sheppard–Yonge", "ob")
    s, _line, tr = lone_train_sim(p.chainage_m - 500.0, v_mps=15.0)
    tr._op_express = True
    assert _run_until(s, lambda: tr.berthed_idx is not None, 600)
    assert PLATFORMS[tr.berthed_idx].name == "Finch"
    assert PLATFORMS[tr.berthed_idx].role == "arrival"
    assert [PLATFORMS[k].name for (_t, k, _w) in tr.pass_log] == ["Sheppard–Yonge", "North York Ctr"]


def test_hold_keeps_train_at_platform_until_released():
    p = platform_by("Queen", "ob")
    s, _line, tr = lone_train_sim(p.chainage_m - 300.0, v_mps=8.0)
    tr._op_hold = True
    assert _run_until(s, lambda: tr.berthed_idx is not None, 300)
    _run_until(s, lambda: False, 180)
    assert tr.berthed_idx == p.ring_index and tr.v == 0.0
    payload = s.train_payload(tr)
    assert payload["state"] == "dwelling" and payload["stop_reason"] == "dispatcher_hold"
    tr._op_hold = False
    assert _run_until(s, lambda: tr.berthed_idx is None, 60)
    assert tr.depart_log[-1][1] == p.ring_index


def test_dispatch_commands_api_drives_orders():
    import sim  # noqa: F401  (global roster populated on import; the API looks trains up there)
    tr = trainmod.lines[0].trains[0]
    commands.set_train_dispatch(tr.train_id, "skip", 3)
    assert tr._op_skip_remaining == 3
    commands.set_train_dispatch(tr.train_id, "express")
    assert tr._op_express and tr._op_skip_remaining == 0
    commands.set_train_dispatch(tr.train_id, "release")
    assert not tr._op_express and not tr._op_hold and tr._op_skip_remaining == 0


def test_will_stop_and_effective_stop_consistency():
    tr = trainmod.Train(chainage_front_m=10.0)
    tr.stop_idx = 1
    assert effective_stop(tr) == 1
    tr._op_skip_remaining = 3
    assert effective_stop(tr) == 4
    tr._op_skip_remaining = 0
    tr._op_express = True
    tr.stop_idx = 30
    k = effective_stop(tr)
    assert PLATFORMS[k].terminal and will_stop(tr, PLATFORMS[k])
    assert 0 < k < N_PLATFORMS


def test_stopped_train_does_not_inch_forward():
    """A train held behind its EOA restarts only when it gains enough room (no creeping)."""
    p = platform_by("Glencairn", "ob")
    s, line, tr = lone_train_sim(p.chainage_m - 700.0, v_mps=0.0)
    blocker = trainmod.Train(chainage_front_m=(p.chainage_m - 300.0) % ROUTE_LEN_M, run_number=2)
    blocker.berthed_idx = None
    blocker._op_hold = True
    line.trains.append(blocker)
    blocker.stop_idx = p.ring_index
    blocker.e_brake = True          # pinned in place
    s._prime()
    _run_until(s, lambda: False, 90)
    pos = tr.chainage_front_m
    moves = 0
    for _ in range(int(60 / DT)):
        s.step(DT)
        if abs(tr.chainage_front_m - pos) > 1e-9:
            moves += 1
            pos = tr.chainage_front_m
    assert tr.v == 0.0 and moves == 0
    payload = s.train_payload(tr)
    assert payload["state"] == "stopped" and payload["stop_reason"] == "train_ahead"
