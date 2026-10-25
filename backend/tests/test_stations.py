"""Platforms around the ring: every station on both legs, terminals as arrival/departure."""

from route_geom import ROUTE_LEN_M
from stations import FINCH, N_PLATFORMS, PLATFORMS, VAUGHAN, dwell_s, first_platform_ahead, nominal_dwell_s
import topology


def test_both_directions_have_all_38_stations():
    names = topology.STOP_NAMES
    assert len(names) == 38
    for leg in ("ob", "ib"):
        served = {p.stop_index for p in PLATFORMS if p.leg == leg}
        assert served == set(range(38)), leg
    assert N_PLATFORMS == 76


def test_platforms_in_ring_order_with_terminal_stages():
    ch = [p.chainage_m for p in PLATFORMS]
    assert all(0.0 < c < ROUTE_LEN_M for c in ch)
    assert ch == sorted(ch) and len(set(ch)) == len(ch)
    assert (PLATFORMS[0].name, PLATFORMS[0].role, PLATFORMS[0].leg) == (VAUGHAN, "departure", "ob")
    assert (PLATFORMS[37].name, PLATFORMS[37].role) == (FINCH, "arrival")
    assert (PLATFORMS[38].name, PLATFORMS[38].role, PLATFORMS[38].leg) == (FINCH, "departure", "ib")
    assert (PLATFORMS[-1].name, PLATFORMS[-1].role) == (VAUGHAN, "arrival")
    # Destinations flip at the terminals.
    assert {p.destination for p in PLATFORMS[:38]} == {FINCH}
    assert {p.destination for p in PLATFORMS[38:]} == {VAUGHAN}


def test_interstation_spacing_is_real_metres():
    ob = [p for p in PLATFORMS if p.leg == "ob" and p.role == "through"]
    gaps = [b.chainage_m - a.chainage_m for a, b in zip(ob, ob[1:])]
    assert 950 <= sum(gaps) / len(gaps) <= 1150      # Line 1 averages ~1 km between stations
    assert min(gaps) > 350 and max(gaps) < 2700


def test_first_platform_ahead():
    p = PLATFORMS[10]
    assert first_platform_ahead(p.chainage_m - 5.0) == 10
    assert first_platform_ahead(p.chainage_m + 1.0) == 11
    assert first_platform_ahead(ROUTE_LEN_M - 1.0) == 0


def test_dwell_model():
    union = next(p for p in PLATFORMS if p.name == "Union")
    dupont = next(p for p in PLATFORMS if p.name == "Dupont")
    assert nominal_dwell_s(union, peak=False) > nominal_dwell_s(dupont, peak=False)
    assert nominal_dwell_s(dupont, peak=True) > nominal_dwell_s(dupont, peak=False)
    assert 20 <= nominal_dwell_s(dupont, peak=False) <= 30
    assert 35 <= nominal_dwell_s(union, peak=True) <= 50
    assert dwell_s(dupont, False, None, bias_s=5.0) == nominal_dwell_s(dupont, False) + 5.0
