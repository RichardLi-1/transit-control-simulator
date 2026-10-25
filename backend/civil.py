"""Civil speed limits along the ring (line speed + permanent restrictions from topology).

A restriction applies to the whole train: from when the nose enters until the tail leaves.
"""

from __future__ import annotations

import topology
from ma_constants import KPH_TO_MPS, LINE_SPEED_KPH
from route_geom import ROUTE_LEN_M

LINE_SPEED_MPS = LINE_SPEED_KPH * KPH_TO_MPS
_L = ROUTE_LEN_M

# (start_m, span_m, limit_mps) — merged so a split-at-origin restriction is one span.
RESTRICTIONS: list[tuple[float, float, float]] = []


def _load() -> None:
    raw = sorted(topology.SPEED_RESTRICTIONS, key=lambda r: r['start_m'])
    spans: list[list[float]] = [[r['start_m'], r['end_m'], r['limit_kph'] * KPH_TO_MPS] for r in raw]
    # Re-join the piece that was split at the ring origin.
    if len(spans) >= 2:
        first, last = spans[0], spans[-1]
        if first[0] <= 1e-6 and abs(last[1] - _L) <= 1e-6 and abs(first[2] - last[2]) < 1e-9:
            last[1] = _L + first[1]
            spans.pop(0)
    for s, e, lim in spans:
        RESTRICTIONS.append((s, e - s, lim))


_load()


def ceiling_mps(nose: float, length: float, extra=()) -> float:
    """Most restrictive civil limit over the train body [nose-length, nose]."""
    lim = LINE_SPEED_MPS
    for start, span, l in RESTRICTIONS:
        if l < lim and (nose - start) % _L < span + length:
            lim = l
    for start, end, l in extra:
        if l < lim and (nose - start) % _L < ((end - start) % _L) + length:
            lim = l
    return lim


def ahead(nose: float, length: float, lookahead: float, extra=()):
    """Yield (distance_to_start, limit_mps) for restrictions starting ahead within lookahead
    that the train is not already inside."""
    for start, span, l in RESTRICTIONS:
        d = (start - nose) % _L
        if d < lookahead and (nose - start) % _L >= span + length:
            yield d, l
    for start, end, l in extra:
        d = (start - nose) % _L
        if d < lookahead and (nose - start) % _L >= ((end - start) % _L) + length:
            yield d, l


def limit_at_kph(c: float) -> float:
    """Civil limit at a single point (km/h)."""
    lim = LINE_SPEED_MPS
    for start, span, l in RESTRICTIONS:
        if (c - start) % _L < span:
            lim = min(lim, l)
    return lim / KPH_TO_MPS
