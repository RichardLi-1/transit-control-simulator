"""Zone controller: EOA = leader tail − margin, or a signal at stop; no braking distance added."""

from interlocking import Interlocking
from ma_constants import SIGNAL_EOA_OFFSET_M, ZC_SAFETY_MARGIN_M
from route_geom import ROUTE_LEN_M
from train import Train
from zone_controller import ZoneController, required_follower_gap_m


def test_required_gap_increases_with_speed():
    assert required_follower_gap_m(60.0) > required_follower_gap_m(10.0) > ZC_SAFETY_MARGIN_M


def test_eoa_is_leader_tail_minus_margin_independent_of_speed():
    a = Train(chainage_front_m=1000.0, run_number=0)
    b = Train(chainage_front_m=2000.0, run_number=1)
    zc = ZoneController(ROUTE_LEN_M)
    for v in (0.0, 10.0, 22.0):
        a.v = v
        zc.update([a, b])
        tail = 2000.0 - b.length_m
        assert abs(a.eoa_dist_m - (tail - 1000.0 - ZC_SAFETY_MARGIN_M)) < 1e-9
        assert abs(a.authority_eoa_m - (tail - ZC_SAFETY_MARGIN_M)) < 1e-9
        assert a.eoa_source == "train_ahead" and a.leader_run_number == 1
    assert b.leader_run_number == 0          # ring: the front train's leader is the rear one
    assert a.gap_to_leader_m == 2000.0 - b.length_m - 1000.0


def test_signal_at_stop_limits_authority():
    il = Interlocking(use_overrides=False)
    sig = next(s for s in il.signals if s.kind == "home")
    t = Train(chainage_front_m=sig.ch - 700.0, run_number=0)
    far = Train(chainage_front_m=(sig.ch + 20_000.0) % ROUTE_LEN_M, run_number=1)
    order = sorted([t, far], key=lambda x: x.chainage_front_m)
    # Occupy the route section so the route can't be set: the signal stays at stop.
    blocker = Train(chainage_front_m=sig.ch + sig.span + 50.0, run_number=2)   # tail inside the section
    order = sorted([t, far, blocker], key=lambda x: x.chainage_front_m)
    il.update(order, [x.chainage_front_m for x in order])
    assert il.aspects[sig.id] == "red"
    ZoneController(ROUTE_LEN_M).update(order, il, order)
    assert t.eoa_signal_m == 700.0 - SIGNAL_EOA_OFFSET_M
    assert t.eoa_source == "signal" and t.eoa_signal_id == sig.id


def test_route_sets_for_approaching_train_when_clear():
    il = Interlocking(use_overrides=False)
    sig = next(s for s in il.signals if s.role == "mid_home")
    t = Train(chainage_front_m=sig.ch - 800.0, run_number=0)
    il.update([t], [t.chainage_front_m])
    assert il.aspects[sig.id] in ("green", "yellow")
    # Once the train passes, the signal is replaced to stop behind it …
    t.chainage_front_m = sig.ch + 20.0
    il.update([t], [t.chainage_front_m])
    assert il.aspects[sig.id] == "red" and sig.locked is t
    # … and the route releases when its tail clears the section.
    t.chainage_front_m = sig.ch + sig.span + t.length_m + 1.0
    il.update([t], [t.chainage_front_m])
    assert sig.locked is None
