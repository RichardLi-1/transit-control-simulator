"""Platforms (stopping points) around the revenue ring and the dwell-time model.

Every station has a platform on BOTH legs.  Terminals are modelled as an arrival platform
(alight / start changing ends) and a departure platform on the other track (board / wait
for the regulated departure), joined by the terminal crossover.  This keeps two-platform
terminal throughput inside the ring abstraction.
"""

from __future__ import annotations

import random
from bisect import bisect_left
from dataclasses import dataclass

import topology
from route_geom import ROUTE_LEN_M


@dataclass(frozen=True)
class Platform:
    ring_index: int
    name: str
    code: str
    stop_index: int       # 0 = Vaughan MC … 37 = Finch
    leg: str              # 'ob' (towards Finch) | 'ib' (towards Vaughan MC)
    node_id: str
    chainage_m: float     # stopping point of the train nose
    role: str             # 'through' | 'arrival' | 'departure'
    terminal: bool
    destination: str      # terminal a train at this platform is heading to

    # Back-compat with the old StationBerth
    @property
    def chainage(self) -> float:
        return self.chainage_m


PLATFORMS: list[Platform] = [
    Platform(p['ring_index'], p['name'], p['code'], p['stop_index'], p['leg'], p['node_id'],
             float(p['chainage_m']), p['role'], bool(p['terminal']), p['destination'])
    for p in topology.PLATFORMS
]
N_PLATFORMS = len(PLATFORMS)
_CHAINAGES = [p.chainage_m for p in PLATFORMS]
FINCH = topology.STOP_NAMES[-1]
VAUGHAN = topology.STOP_NAMES[0]

# Busy stations (APPROX — major interchanges / terminals): longer dwells.
BUSY_STATIONS = frozenset({
    "Union", "Bloor–Yonge", "St George", "Eglinton", "Sheppard–Yonge", "Finch", "Vaughan MC", "Spadina",
})

# Dwell model (APPROX).  Seconds, before random variation and dispatcher bias.
DWELL_ORDINARY_S = 24.0
DWELL_BUSY_S = 40.0
DWELL_TERMINAL_ARRIVAL_S = 45.0     # alight + crew starts changing ends
DWELL_TERMINAL_DEPARTURE_S = 35.0   # board; then the starter clears at the regulated time
PEAK_FACTOR_ORDINARY = 1.15
PEAK_FACTOR_BUSY = 1.25
DWELL_JITTER = 0.15                 # ± uniform fraction, from the sim's seeded RNG
DWELL_MIN_S = 15.0


def next_ring_index(k: int) -> int:
    return (k + 1) % N_PLATFORMS


def first_platform_ahead(chainage_m: float, min_distance_m: float = 0.0) -> int:
    """Ring index of the first platform whose stop point is at least ``min_distance_m`` ahead."""
    c = (chainage_m + min_distance_m) % ROUTE_LEN_M
    i = bisect_left(_CHAINAGES, c)
    return i % N_PLATFORMS


def platform_by(name: str, leg: str, role: str | None = None) -> Platform:
    for p in PLATFORMS:
        if p.name == name and p.leg == leg and (role is None or p.role == role):
            return p
    raise KeyError((name, leg, role))


def nominal_dwell_s(p: Platform, peak: bool) -> float:
    if p.terminal:
        return DWELL_TERMINAL_ARRIVAL_S if p.role == 'arrival' else DWELL_TERMINAL_DEPARTURE_S
    busy = p.name in BUSY_STATIONS
    base = DWELL_BUSY_S if busy else DWELL_ORDINARY_S
    if peak:
        base *= PEAK_FACTOR_BUSY if busy else PEAK_FACTOR_ORDINARY
    return base


def dwell_s(p: Platform, peak: bool, rng: random.Random | None, bias_s: float = 0.0) -> float:
    """Dwell for one stop: nominal × seeded jitter + dispatcher (live_dispatch) bias."""
    base = nominal_dwell_s(p, peak)
    jitter = 1.0
    if rng is not None:
        jitter = 1.0 + rng.uniform(-DWELL_JITTER, DWELL_JITTER)
    d = base * jitter
    if not p.terminal:
        d += bias_s
    return max(DWELL_MIN_S if not p.terminal else 20.0, d)


# ── Back-compat aliases ───────────────────────────────────────────────────────
StationBerth = Platform
YUS_PLATFORMS = PLATFORMS
