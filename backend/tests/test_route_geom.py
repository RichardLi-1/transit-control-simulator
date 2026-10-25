"""Chainage / edge mapping on the real-metre ring."""

import topology
from route_geom import ROUTE_LEN_M, chainage_to_edge, forward_distance, wrap_chainage


def test_wrap_chainage():
    assert wrap_chainage(0) == 0.0
    assert abs(wrap_chainage(ROUTE_LEN_M) - 0.0) < 1e-6
    assert abs(wrap_chainage(-10) - (ROUTE_LEN_M - 10)) < 1e-6


def test_forward_distance_wraps():
    assert abs(forward_distance(ROUTE_LEN_M - 100, 50) - 150.0) < 1e-6
    # Forward only — a point 5 m behind is (almost) a whole lap ahead, never "passed".
    assert forward_distance(1000.0, 995.0) > ROUTE_LEN_M - 10


def test_chainage_to_edge_in_range():
    eid, off = chainage_to_edge(0.0)
    assert eid == "ob_0_1" and off == 0.0
    eid, off = chainage_to_edge(ROUTE_LEN_M - 1.0)
    assert eid == "xover_start" and 0.9 < off <= 1.0


def test_chainage_boundary_uses_next_edge():
    start = topology.SEG_START["ob_1_2"]
    eid, off = chainage_to_edge(start)
    assert eid == "ob_1_2"
    assert off < 0.01


def test_segments_are_contiguous_and_follow_route_order():
    segs = topology.YUS_TOPOLOGY["route"]["segments"]
    assert [s["edge_id"] for s in segs] == topology.YUS_TRAIN_ROUTE
    acc = 0.0
    for s in segs:
        assert abs(s["start_m"] - acc) < 0.02
        acc += s["length_m"]
    assert abs(acc - topology.YUS_TOPOLOGY["route"]["length_m"]) < 0.05
