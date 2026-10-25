"""Injected incidents: timing, train effects, signal override lifecycle."""

from __future__ import annotations

import train
from events import EventRegistry
from train import Line, Train, TrainCommand


def _line() -> Line:
    t = Train(chainage_front_m=500.0, direction=1, run_number=1, length_m=138.0)
    t.speed = 40.0
    return Line("L1", [t])


def test_emergency_brake_and_release():
    reg = EventRegistry()
    lines = [_line()]
    tr = lines[0].trains[0]

    reg.inject(lines=lines, kind="emergency_brake", sim_time_s=0.0, duration_s=5.0, target_train_id="T01")
    assert tr.e_brake is True

    reg.tick(lines, 5.0, 5.0)
    assert tr.e_brake is False


def test_slow_speed_cap_sets_restriction_without_clamping():
    reg = EventRegistry()
    lines = [_line()]
    tr = lines[0].trains[0]
    tr.speed = 50.0

    reg.inject(
        lines=lines,
        kind="slow_speed",
        sim_time_s=0.0,
        duration_s=10.0,
        target_train_id="T01",
        speed_limit_kph=20.0,
    )
    assert getattr(tr, "_speed_cap_kph", None) == 20.0
    # No teleport in speed: the ATO brakes to the cap (see test_interlocking_scenarios).
    assert abs(tr.speed - 50.0) < 1e-9

    reg.tick(lines, 10.0, 10.0)
    assert not hasattr(tr, "_speed_cap_kph")


def test_scheduled_then_active():
    reg = EventRegistry()
    lines = [_line()]
    tr = lines[0].trains[0]

    reg.inject(
        lines=lines,
        kind="emergency_brake",
        sim_time_s=0.0,
        duration_s=2.0,
        starts_in_s=3.0,
        target_train_id="T01",
    )
    assert tr.e_brake is False
    reg.tick(lines, 3.0, 3.0)
    assert tr.e_brake is True


def test_signal_fail_clears_override():
    import commands as cmd_api
    import topology

    reg = EventRegistry()
    lines = [_line()]
    sig_id = topology.YUS_TOPOLOGY["signals"][0]["id"]
    reg.inject(
        lines=lines,
        kind="signal_fail",
        sim_time_s=0.0,
        duration_s=1.0,
        target_signal_id=sig_id,
    )
    assert cmd_api.signal_aspect(sig_id, "green") == "red"

    reg.tick(lines, 1.0, 1.0)
    assert cmd_api.signal_aspect(sig_id, "green") == "green"


def test_cancel_clears_train_effects():
    reg = EventRegistry()
    lines = [_line()]
    tr = lines[0].trains[0]

    inc = reg.inject(
        lines=lines,
        kind="station_hold",
        sim_time_s=0.0,
        duration_s=60.0,
        target_train_id="T01",
    )
    assert getattr(tr, "_station_hold", False) is True
    reg.cancel(inc.id, lines=lines, sim_time_s=1.0)
    assert not hasattr(tr, "_station_hold")
