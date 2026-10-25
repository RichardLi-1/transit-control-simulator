"""Chainage helpers on the revenue ring, in REAL metres.

There is deliberately no "short-arc" helper here any more: deciding whether a train has
"passed" a point by taking the shorter way round the ring is what made trains skip the
whole inbound leg.  Progress is tracked with forward distances only (see ato.py).
"""

from __future__ import annotations

from bisect import bisect_right

import topology

ROUTE_SEGMENTS: list[tuple[str, float]] = [(eid, length) for eid, _s, length in topology.ROUTE_SEGMENTS_M]
ROUTE_LEN_M: float = topology.ROUTE_LENGTH_M
_STARTS = [s for _eid, s, _l in topology.ROUTE_SEGMENTS_M]


def wrap_chainage(s: float, route_len: float = ROUTE_LEN_M) -> float:
    """Map an arbitrary chainage to [0, route_len)."""
    r = s % route_len
    return float(r + route_len if r < -1e-12 else r)


def forward_distance(chainage_from: float, chainage_to: float, route_len: float = ROUTE_LEN_M) -> float:
    """Distance travelling forward along the ring from chainage_from to chainage_to, in [0, L)."""
    d = (chainage_to - chainage_from) % route_len
    return float(d)


def chainage_to_edge(chainage: float, route_len: float = ROUTE_LEN_M) -> tuple[str, float]:
    """Map a chainage (m) to (edge_id, fraction along that edge in [0, 1]).

    Segment boundaries belong to the *next* edge (offset 0)."""
    if route_len != ROUTE_LEN_M:   # foreign ring (tests) — scale onto ours
        chainage = chainage / route_len * ROUTE_LEN_M
    c = chainage % ROUTE_LEN_M
    i = bisect_right(_STARTS, c) - 1
    eid, start, length = topology.ROUTE_SEGMENTS_M[max(i, 0)]
    return eid, min(1.0, max(0.0, (c - start) / length))


def edges_spanned(c_from: float, c_to: float) -> list[str]:
    """Edge ids covered going forward from chainage c_from to c_to (e.g. tail → nose)."""
    L = ROUTE_LEN_M
    a = c_from % L
    span = (c_to - c_from) % L
    segs = topology.ROUTE_SEGMENTS_M
    i = max(bisect_right(_STARTS, a) - 1, 0)
    out = [segs[i][0]]
    covered = segs[i][1] + segs[i][2] - a        # distance from a to the end of edge i
    n = len(segs)
    while covered < span - 1e-9 and len(out) < n:
        i = (i + 1) % n
        out.append(segs[i][0])
        covered += segs[i][2]
    return out
