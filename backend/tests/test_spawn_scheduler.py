"""Yard moves: trains enter service from Wilson Yard only into a safe gap, and surplus trains
run out of service to the yard when the timetable thins out."""

import sim as simmod
import train as trainmod
from route_geom import ROUTE_LEN_M
from sim import DT, SPAWN_CHAINAGE_M, SPAWN_STOP_INDEX, YARDS, Simulation
from stations import N_PLATFORMS, PLATFORMS, platform_by
from simhelpers import make_sim


def test_wilson_yard_lead_between_sheppard_west_and_wilson():
    shw = platform_by("Sheppard West", "ob").chainage_m
    wil = platform_by("Wilson", "ob")
    assert shw < SPAWN_CHAINAGE_M < wil.chainage_m
    assert SPAWN_STOP_INDEX == wil.stop_index
    assert simmod._wilson_yard_chainage() == (SPAWN_CHAINAGE_M, SPAWN_STOP_INDEX)


def test_insertion_when_below_target_and_gap_is_safe():
    t = trainmod.Train(chainage_front_m=(SPAWN_CHAINAGE_M + ROUTE_LEN_M / 2) % ROUTE_LEN_M, run_number=0)
    line = trainmod.Line("YUS", [t])
    s = Simulation(lines=[line], populate=False, use_dispatch=False)
    for _ in range(int(130 / DT)):
        s.step(DT)
    assert len(line.trains) >= 3                       # 1 per yard per minute
    assert s._dispatch_count == len(line.trains) - 1
    for tr in line.trains[1:]:
        # Inserted trains enter at a yard junction and their first stop is the next platform.
        assert tr.berth_log or tr.stop_idx is not None
        first = tr.berth_log[0][1] if tr.berth_log else tr.stop_idx
        assert PLATFORMS[first].name in {y["first_stop"] for y in YARDS}


def test_no_insertion_into_a_tight_gap():
    # A train sitting right at the junction blocks the yard exit.
    j = SPAWN_CHAINAGE_M
    blocker = trainmod.Train(chainage_front_m=j + 60.0, run_number=0)
    blocker.e_brake = True
    line = trainmod.Line("YUS", [blocker])
    s = Simulation(lines=[line], populate=False, use_dispatch=False)
    for _ in range(int(30 / DT)):
        s.step(DT)
    spawned_wilson = [tr for tr in line.trains if tr is not blocker
                      and abs((tr.chainage_front_m - j) % ROUTE_LEN_M) < 400]
    assert spawned_wilson == []


def test_midday_surplus_trains_run_to_the_yard_in_order():
    s, line = make_sim(start_clock_s=8.9 * 3600, seed=3)
    s.run(70 * 60)
    assert s.period_name == "Midday"
    assert s._withdraw_count >= 3
    assert {t.to_yard for t in s.removed_trains} == {"Wilson Yard", "Davisville Yard"}
    for tr in s.removed_trains:
        seq = [k for (_t, k, _e) in tr.berth_log]
        assert all(b == (a + 1) % N_PLATFORMS for a, b in zip(seq, seq[1:]))
        # Last stop before the yard lead: Sheppard West (ob) for Wilson, Eglinton (ib) for Davisville.
        expected = {"Wilson Yard": ("Sheppard West", "ob"), "Davisville Yard": ("Eglinton", "ib")}[tr.to_yard]
        assert (PLATFORMS[seq[-1]].name, PLATFORMS[seq[-1]].leg) == expected
        assert len(tr.pass_log) == 0
    assert s.atp_trip_count() == 0
