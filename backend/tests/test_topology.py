"""Topology contract: real metres, stations, interlocking-only signals, civil limits, yards."""

from __future__ import annotations

import statistics
from collections import Counter

import topology
from route_geom import ROUTE_LEN_M

DOC = topology.YUS_TOPOLOGY


def test_total_length_matches_real_line_1():
    one_way = sum(e["length_m"] for e in DOC["edges"] if e["id"].startswith("ob_"))
    assert abs(one_way - 38_400.0) / 38_400.0 < 0.03         # published ~38.4 km
    assert abs(ROUTE_LEN_M - 76_800.0) / 76_800.0 < 0.03      # ~77 km loop
    assert DOC["route"]["length_m"] == round(ROUTE_LEN_M, 2)


def test_every_edge_has_metres_and_pixels():
    for e in DOC["edges"]:
        assert e["length_m"] > 0 and e["length"] > 0
        assert len(e["points"]) >= 2


def test_stations_document():
    st = DOC["stations"]
    assert len(st) == 38
    assert [s["stop_index"] for s in st] == list(range(38))
    for s in st:
        legs = {p["leg"] for p in s["platforms"]}
        assert legs == {"ob", "ib"}, s["name"]
        for p in s["platforms"]:
            assert 0 <= p["chainage_m"] < ROUTE_LEN_M
            assert p["node_id"] in {n["id"] for n in DOC["nodes"]}


def test_speed_restrictions_shape():
    rs = DOC["speed_restrictions"]
    assert 6 <= len(rs) <= 20
    reasons = " ".join(r["reason"] for r in rs)
    for needle in ("terminal crossover", "Union", "Museum"):
        assert needle in reasons
    for r in rs:
        assert 0 <= r["start_m"] < r["end_m"] <= ROUTE_LEN_M
        assert 10 <= r["limit_kph"] < 80


def test_yards():
    names = {y["name"] for y in DOC["yards"]}
    assert "Wilson Yard" in names
    for y in DOC["yards"]:
        assert 0 <= y["chainage_m"] < ROUTE_LEN_M


# ── Signals ──────────────────────────────────────────────────────────────────
SIGS = DOC["signals"]


def test_signals_only_at_interlockings():
    assert 10 <= len(SIGS) <= 60, "tens of signals, not hundreds"
    for s in SIGS:
        for f in ("id", "name", "edge_id", "offset", "position", "aspect", "block_id",
                  "chainage_m", "leg", "kind"):
            assert f in s, f
        assert s["leg"] in ("ob", "ib")
        assert s["kind"] in ("home", "starter", "yard_exit", "intermediate")
    kinds = Counter(s["kind"] for s in SIGS)
    assert kinds["home"] and kinds["starter"] and kinds["yard_exit"]
    assert len({s["id"] for s in SIGS}) == len(SIGS)
    assert len({s["name"] for s in SIGS}) == len(SIGS)


def test_signal_names_interlocking_style_with_direction_parity():
    for s in SIGS:
        code, num = s["name"].split(" ")
        assert code.isalpha() and code.isupper() and len(code) == 3
        n = int(num)
        if s["kind"] != "yard_exit":
            assert (n % 2 == 1) == (s["leg"] == "ob"), s["name"]


def test_signal_spacing_is_not_uniform_or_periodic():
    ch = sorted(s["chainage_m"] for s in SIGS)
    gaps = [b - a for a, b in zip(ch, ch[1:])] + [ch[0] + ROUTE_LEN_M - ch[-1]]
    cv = statistics.pstdev(gaps) / statistics.mean(gaps)
    assert cv > 0.5
    common = Counter(round(g, -1) for g in gaps).most_common(1)[0][1]
    assert common <= max(2, len(gaps) // 5), "a single spacing value dominates"
    # And the siting distance before each protected feature varies too.
    homes = [s for s in SIGS if s["kind"] == "home"]
    dists = {round(_nearest_feature_ahead(s["chainage_m"], kinds=("points", "yard_lead", "platform_end")), 0)
             for s in homes}
    assert len(dists) >= 4


def _nearest_feature_ahead(c: float, kinds) -> float:
    best = float("inf")
    for f in topology.TRACK_FEATURES:
        if f["kind"] in kinds:
            best = min(best, (f["chainage_m"] - c) % ROUTE_LEN_M)
    return best


def _nearest_feature(c: float) -> float:
    best = float("inf")
    for f in topology.TRACK_FEATURES:
        d = abs(f["chainage_m"] - c)
        best = min(best, d, ROUTE_LEN_M - d)
    return best


def test_every_signal_sits_near_a_track_feature():
    for s in SIGS:
        assert _nearest_feature(s["chainage_m"]) <= 300.0, s["name"]
        if s["kind"] == "home":
            # A home signal protects points / a platform track / a yard junction ahead of it.
            assert _nearest_feature_ahead(s["chainage_m"], ("points", "yard_lead", "platform_end")) <= 300.0, s["name"]


def test_each_mid_crossover_and_terminal_is_protected_on_both_tracks():
    by_il = Counter((s["interlocking"], s["leg"]) for s in SIGS if s["kind"] != "yard_exit")
    for idx in topology.MID_XOVER_STOPS:
        name = topology.STOP_NAMES[idx]
        assert by_il[(name, "ob")] >= 1 and by_il[(name, "ib")] >= 1, name
    assert by_il[("Finch", "ob")] == 2 and by_il[("Finch", "ib")] == 1
    assert by_il[("Vaughan MC", "ib")] == 2 and by_il[("Vaughan MC", "ob")] == 1
