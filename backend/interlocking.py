"""Interlockings: route setting, locking and signal aspects (CBTC era).

Signals exist only at interlockings (see topology._build_signals for siting rules).  Each
signal protects a *route section* from the signal to the route exit (past the points / to the
next platform end).  Behaviour, per signal, every sim step:

* A signal is normally at STOP.  The nearest train approaching it (within APPROACH_M)
  requests the route automatically (ATS auto-routing).
* The route is SET and LOCKED for that train only if: the section is clear of every train,
  the points can be set/locked for the route (not held against it by an operator), there is
  no operator stop override / signal failure, and — kind-specific — the terminal departure
  time has been reached (headway regulation) or a yard insertion has been requested.
  Then the signal shows PROCEED (green, or yellow if the next signal beyond is at stop).
* As the train's nose passes, the signal is replaced to STOP behind it; the route stays
  locked until the train's tail clears the section, then releases.

The zone controller (zone_controller.py) turns signals at stop into movement-authority
limits.  Operator overrides come from commands.py.
"""

from __future__ import annotations

from bisect import bisect_left
from typing import Callable

import commands as cmd_api
import topology
from route_geom import ROUTE_LEN_M

APPROACH_M = 1800.0        # auto-route request distance
YELLOW_LOOKAHEAD_M = 600.0
_L = ROUTE_LEN_M
_TERMINAL_SWITCHES = frozenset({'sw_start', 'sw_end'})


def _held_at_platform(tr) -> bool:
    """Berthed and held by the dispatcher / an incident (hold, station hold, door fault)."""
    return tr.berthed_idx is not None and bool(
        tr._op_hold or getattr(tr, "_station_hold", False) or getattr(tr, "_door_interlock", False))


class SignalState:
    __slots__ = ('id', 'name', 'ch', 'span', 'kind', 'role', 'switch_id', 'yard', 'leg',
                 'locked', 'aspect', 'route_set', 'interlocking')

    def __init__(self, doc: dict) -> None:
        self.id: str = doc['id']
        self.name: str = doc['name']
        self.ch: float = float(doc['chainage_m'])
        self.span: float = float(doc['route_len_m'])
        self.kind: str = doc['kind']
        self.role: str = doc['role']
        self.switch_id: str | None = doc.get('switch_id')
        self.yard: str | None = doc.get('yard')
        self.leg: str = doc['leg']
        self.interlocking: str = doc['interlocking']
        self.locked = None          # Train the route is locked for (or a yard token)
        self.aspect = 'red'
        self.route_set = False


class Interlocking:
    def __init__(self, use_overrides: bool = True) -> None:
        self.use_overrides = use_overrides
        self.signals: list[SignalState] = [SignalState(d) for d in topology.SIGNALS]
        self.signals.sort(key=lambda s: s.ch)
        # Yard exits are evaluated first: granting one may cancel a main-line home route.
        self._eval_order = sorted(self.signals, key=lambda s: s.kind != 'yard_exit')
        self.by_id = {s.id: s for s in self.signals}
        self.stop_signals: list[tuple[float, str]] = []   # (chainage, id) of signals at stop, sorted
        self.aspects: dict[str, str] = {s.id: 'red' for s in self.signals}
        self.switch_states: dict[str, str] = {sw['id']: 'normal' for sw in topology.YUS_TOPOLOGY['switches']}
        # Hooks set by the simulation:
        self.departure_ok: Callable[[object, SignalState], bool] = lambda train, sig: True
        self.yard_requests: set[str] = set()
        self.yard_granted: set[str] = set()

    # ── helpers ─────────────────────────────────────────────────────────────
    def _override(self, sid: str) -> str | None:
        if not self.use_overrides:
            return None
        return cmd_api._signal_overrides.get(sid)

    def _switch_override(self, swid: str) -> str | None:
        if not self.use_overrides:
            return None
        return cmd_api._switch_overrides.get(swid)

    def _switch_allows(self, sig: SignalState) -> bool:
        sw = sig.switch_id
        if not sw:
            return True
        ov = self._switch_override(sw)
        if ov is None:
            return True
        if sw in _TERMINAL_SWITCHES:
            return ov == 'reverse'        # turnback route needs the crossover
        return ov == 'normal'             # through route needs the points normal

    @staticmethod
    def _section_occupied(sig: SignalState, noses: list[float], trains: list, max_len: float) -> bool:
        """Any train body overlapping [sig.ch, sig.ch + span]?"""
        n = len(noses)
        if n == 0:
            return False
        lo = sig.ch
        reach = sig.span + max_len
        i = bisect_left(noses, lo)
        for k in range(n):
            j = (i + k) % n
            tr = trains[j]
            rel = (tr.chainage_front_m - lo) % _L
            if rel >= reach:
                break
            if rel < sig.span + tr.length_m:
                return True
        return False

    # ── main update ─────────────────────────────────────────────────────────
    def update(self, trains_sorted: list, noses_sorted: list[float]) -> None:
        n = len(trains_sorted)
        max_len = max((t.length_m for t in trains_sorted), default=0.0)
        self.yard_granted = set()
        for sig in self._eval_order:
            ov = self._override(sig.id)
            failed = ov == 'red'
            proceed = False
            if sig.kind == 'yard_exit':
                if sig.locked is not None:
                    # Released once the inserted train's tail clears the section.
                    tr = sig.locked if not isinstance(sig.locked, str) else None
                    if tr is None or tr.removed or (tr.chainage_front_m - sig.ch) % _L >= sig.span + tr.length_m:
                        sig.locked = None
                elif sig.yard in self.yard_requests and not failed and \
                        not self._section_occupied(sig, noses_sorted, trains_sorted, max_len) and \
                        self._release_yard_home(sig.yard):
                    sig.locked = 'pending'
                    self.yard_granted.add(sig.yard)
                    proceed = True
                sig.route_set = sig.locked is not None
                sig.aspect = 'green' if proceed else 'red'
                continue

            # Locked route: keep / replace / release.
            if sig.locked is not None:
                tr = sig.locked
                if tr.removed:
                    sig.locked = None
                else:
                    rel = (tr.chainage_front_m - sig.ch) % _L
                    if rel < sig.span + tr.length_m:
                        proceed = False                  # replaced to stop behind the train
                    elif rel < _L * 0.5:
                        sig.locked = None                # tail cleared: route released
                    elif _held_at_platform(tr) or (sig.role == 'terminal_departure'
                                                    and tr.berthed_idx is not None and not tr.ready_to_depart):
                        # A train standing at the platform that has been held (or is no longer
                        # ready) gets its route cancelled; on release it must request it again
                        # (and pass departure regulation at a terminal).
                        sig.locked = None
                        proceed = False
                    else:
                        # Still approaching: route held, unless an operator has since put the
                        # signal to stop or thrown the points against it (the zone controller
                        # then decides whether the train can still stop — approach locking).
                        proceed = not failed and self._switch_allows(sig)
            if sig.locked is None and n:
                # Auto-route for the nearest approaching train.
                i = bisect_left(noses_sorted, sig.ch) - 1
                cand = trains_sorted[i % n]
                d = (sig.ch - cand.chainage_front_m) % _L
                if 0.0 < d <= APPROACH_M and not failed and self._switch_allows(sig) \
                        and not _held_at_platform(cand) \
                        and not self._section_occupied(sig, noses_sorted, trains_sorted, max_len) \
                        and not (sig.role == 'yard_home' and self._yard_exit_locked(sig.yard)) \
                        and (sig.role != 'terminal_departure' or self.departure_ok(cand, sig)):
                    sig.locked = cand
                    proceed = True
            sig.route_set = sig.locked is not None
            sig.aspect = 'green' if proceed else 'red'
            if ov in ('green', 'yellow'):
                sig.aspect = ov                          # operator call-on

        # Yellow = proceed, but the next signal beyond (same direction) is at stop.
        m = len(self.signals)
        for idx, sig in enumerate(self.signals):
            if sig.aspect != 'green' or sig.kind == 'yard_exit':
                continue
            for k in range(1, m):
                nxt = self.signals[(idx + k) % m]
                if nxt.kind == 'yard_exit':
                    continue
                if (nxt.ch - sig.ch) % _L > sig.span + YELLOW_LOOKAHEAD_M:
                    break
                if nxt.aspect == 'red':
                    sig.aspect = 'yellow'
                break

        self.aspects = {s.id: s.aspect for s in self.signals}
        self.stop_signals = [(s.ch, s.id) for s in self.signals if s.aspect == 'red' and s.kind != 'yard_exit']

        # Points positions as reported to clients.
        for sw in self.switch_states:
            ov = self._switch_override(sw)
            if sw in _TERMINAL_SWITCHES:
                busy = any(s.switch_id == sw and s.role == 'terminal_turnback' and s.locked is not None
                           for s in self.signals)
                self.switch_states[sw] = ov if ov is not None else ('reverse' if busy else 'normal')
            else:
                self.switch_states[sw] = ov if ov is not None else 'normal'

    def _yard_exit_locked(self, yard: str | None) -> bool:
        return any(s.kind == 'yard_exit' and s.yard == yard and s.locked is not None for s in self.signals)

    def _release_yard_home(self, yard: str | None) -> bool:
        """Can the yard-exit route be set?  The main-line home route over the junction
        conflicts.  If it is locked for a train that is still approaching and can stop for the
        home signal at service rate, cancel it (approach locking allows that); if the train is
        inside the junction or too close to stop, refuse."""
        for s in self.signals:
            if s.role != 'yard_home' or s.yard != yard or s.locked is None:
                continue
            tr = s.locked
            if tr.removed:
                s.locked = None
                continue
            rel = (tr.chainage_front_m - s.ch) % _L
            if rel < _L * 0.5:
                return False                       # passed the home: in the junction
            d = _L - rel
            v = tr.v
            if d - 1.0 < v * 1.0 + v * v / (2.0 * 1.0):
                return False                       # committed: cannot stop for the home
            s.locked = None
            s.aspect = 'red'
        return True

    def mark_yard_train(self, yard: str, train) -> None:
        for s in self.signals:
            if s.kind == 'yard_exit' and s.yard == yard:
                s.locked = train

    def signals_payload(self) -> list[dict]:
        return [{'signal_id': s.id, 'aspect': self.aspects.get(s.id, 'red')} for s in self.signals]
