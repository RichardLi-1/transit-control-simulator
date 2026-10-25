"""Simulation orchestration: interlocking → zone controller (EOA) → ATO → ATP → physics.

Also owns the service plan: time-of-day headways, trains in service, the opening roster, yard
insertions/withdrawals, terminal departure regulation and headway statistics.

Sim time 0 corresponds to ``start_clock_s`` (06:00 by default).
"""

from __future__ import annotations

import json
import logging
import math
import random
import threading
from collections import deque

import topology
import train
from ato import AtoController, effective_stop
from dispatch_live import LiveDispatchBridge, live_dispatch
from events import registry as event_registry
from interlocking import Interlocking
from ma_constants import ATO_STOP_DECEL_MPS2, KPH_TO_MPS, TRAIN_LENGTH_M
from route_geom import ROUTE_LEN_M, chainage_to_edge, edges_spanned, forward_distance
from stations import FINCH, PLATFORMS, VAUGHAN, nominal_dwell_s, platform_by
from zone_controller import ZoneController

log = logging.getLogger("cbtc.sim")

DT = 0.2                         # sim integration step (s)
MAX_IN_SERVICE = 66              # of ~76 TR trainsets (rest: spares / maintenance)
SPAWN_MIN_INTERVAL_S = 60.0
SPAWN_LEADER_CLEAR_M = 400.0     # inserted train needs this much clear track ahead
SPAWN_FOLLOWER_EXTRA_M = 450.0   # follower must be its braking distance + this away
YARD_EXIT_NOSE_M = 150.0         # inserted train appears with its nose this far past the junction
YARD_ENTRY_KPH = 25.0
WITHDRAW_START_SURPLUS = 2       # start withdrawing at this surplus …
WITHDRAW_STOP_SURPLUS = 0        # … and keep going until the surplus is gone
PLAN_LOOKAHEAD_S = 40 * 60.0     # insert trains ahead of a busier period
REMOVED_KEEP = 32                # withdrawn trains kept for inspection (bounded)
MISSED_KEEP = 200
DEFAULT_SEED = 20261023
HEADWAY_WINDOW_S = 1200.0

# Service periods (APPROX, shaped like a TTC weekday): (start_h, end_h, name, headway_s, peak)
PERIODS = [
    (0.0, 1.5, "Late evening", 330.0, False),
    (1.5, 5.0, "Overnight (sim keeps running)", 360.0, False),
    (5.0, 6.0, "Early morning", 240.0, False),
    (6.0, 9.0, "AM peak", 150.0, True),
    (9.0, 15.0, "Midday", 240.0, False),
    (15.0, 19.0, "PM peak", 165.0, True),
    (19.0, 22.0, "Early evening", 270.0, False),
    (22.0, 24.0, "Late evening", 330.0, False),
]

YARDS = topology.YARDS
SPAWN_CHAINAGE_M = next(y['chainage_m'] for y in YARDS if y['name'] == 'Wilson Yard')
SPAWN_STOP_INDEX = platform_by('Wilson', 'ob').stop_index


def _wilson_yard_chainage() -> tuple[float, int]:
    """Back-compat: (Wilson Yard junction chainage, stop_index of the first stop after it)."""
    return SPAWN_CHAINAGE_M, SPAWN_STOP_INDEX


def period_at(clock_s: float) -> tuple[str, float, bool]:
    h = (clock_s / 3600.0) % 24.0
    for a, b, name, hw, peak in PERIODS:
        if a <= h < b:
            return name, hw, peak
    return PERIODS[-1][2], PERIODS[-1][3], PERIODS[-1][4]


def format_clock(clock_s: float) -> str:
    s = int(clock_s) % 86400
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


# ── Reference run: one train alone round the loop (nominal dwells) ─────────
_REFERENCE: tuple[float, list[tuple]] | None = None


def reference_cycle() -> tuple[float, list[tuple]]:
    """(round-trip seconds, per-step samples) for a lone train starting berthed at the
    Vaughan MC departure platform.  Cached.  Used to size and place the opening roster."""
    global _REFERENCE
    if _REFERENCE is not None:
        return _REFERENCE
    t = train.Train(chainage_front_m=PLATFORMS[0].chainage_m, run_number=0)
    sim = Simulation(lines=[train.Line("ref", [t])], populate=False, spawning=False,
                     use_events=False, use_dispatch=False, use_overrides=False)
    sim.ato.rng = None
    if t.berthed_idx is None:            # (construction already berths a train on a stop point)
        sim.ato.berth_now(t, 0, 0.0)
    # Nominal (un-jittered) dwell for the reference.
    t.dwell_remaining_sec = t.dwell_total_sec = nominal_dwell_s(PLATFORMS[0], peak=True)
    first = t.berth_count
    samples: list[tuple] = []
    T = None
    for _ in range(int(4 * 3600 / DT)):
        samples.append((sim._sim_time_s, t.chainage_front_m, t.v, t.a, t.a_target, t.stop_idx,
                        t.berthed_idx, t.dwell_remaining_sec, t.dwell_total_sec, t.ready_to_depart))
        sim.step(DT)
        if t.berth_count > first and t.berth_log[-1][1] == 0:
            T = t.berth_log[-1][0]
            break
    if T is None:
        raise RuntimeError("reference run did not complete a round trip")
    _REFERENCE = (T, samples)
    return _REFERENCE


class Simulation:
    def __init__(
        self,
        lines: list[train.Line] | None = None,
        route_len_m: float = ROUTE_LEN_M,
        *,
        seed: int = DEFAULT_SEED,
        start_clock_s: float = 6 * 3600.0,
        populate: bool | None = None,
        spawning: bool = True,
        use_events: bool = True,
        use_dispatch: bool = True,
        use_overrides: bool = True,
        dispatch: LiveDispatchBridge | None = None,
    ) -> None:
        self.lock = threading.RLock()
        self.lines = lines if lines is not None else train.lines
        # The process-wide sim (driving train.lines) uses the global bridge the API talks to;
        # any other Simulation gets its own, so runs are independent and deterministic.
        self.dispatch = dispatch if dispatch is not None else (live_dispatch if lines is None else LiveDispatchBridge())
        self.route_len_m = route_len_m
        self.seed = seed
        self.rng = random.Random(seed)
        self.start_clock_s = float(start_clock_s)
        self.spawning = spawning
        self.use_events = use_events
        self.use_dispatch = use_dispatch
        self.zone = ZoneController(route_len_m)
        self.interlocking = Interlocking(use_overrides=use_overrides)
        self.interlocking.departure_ok = self._departure_ok
        self.ato = AtoController(self.rng)
        self.ato.on_depart = self._on_depart
        self.ato.on_pass = self._on_pass
        self._sim_time_us = 0            # integer clock: no float drift over long runs
        self._sim_time_s = 0.0
        self.paused = False
        self.speed = 1.0
        self.version = 0                 # bumps on every step / API mutation (snapshot cache key)
        self._json_cache: tuple[int, bytes] | None = None
        self._withdrawing = False
        self._max_run = -1
        self._removed_atp_trips = 0
        self.missed_stop_count = 0
        self.step_errors = 0

        self._dispatch_count = 0
        self._withdraw_count = 0
        self._last_dispatch_s: float | None = None
        self._last_spawn: dict[str, float] = {}
        self._last_withdraw: dict[str, float] = {}
        self._last_dispatch_blocked = False
        self._insert_pending = False
        self._last_dep: dict[int, float] = {}
        self._terminal_last_dep: dict[str, float] = {}
        self._headways: deque[tuple[float, float]] = deque(maxlen=800)
        self.removed_trains: train.BoundedLog = train.BoundedLog(REMOVED_KEEP)
        self.missed_stops: train.BoundedLog = train.BoundedLog(MISSED_KEEP)
        self.event_log_extra: deque[dict] = deque(maxlen=50)
        self._order: list[train.Train] = []
        self.period_name, self.base_headway_s, self.peak = period_at(self.start_clock_s)
        if use_dispatch:
            self.dispatch.base_headway_sec = self.base_headway_s
            self.dispatch._recompute()
        # The reference run itself is a Simulation with populate=False, spawning=False.
        self.round_trip_s = reference_cycle()[0] if (spawning or populate is not False) else None

        line = self.lines[0] if self.lines else None
        if populate is None:
            populate = lines is None and line is not None and not line.trains
        if populate and line is not None:
            self._populate_opening_roster(line)
        for ln in self.lines:
            for tr in ln.trains:
                self._max_run = max(self._max_run, int(tr.run_number or 0))
        self._prime()

    def touch(self) -> None:
        """Mark state as changed outside a step (API commands) so /state re-encodes."""
        self.version += 1

    # ── clock / service plan ────────────────────────────────────────────────
    @property
    def clock_s(self) -> float:
        return self.start_clock_s + self._sim_time_s

    @property
    def target_headway_s(self) -> float:
        if self.use_dispatch:
            return float(self.dispatch.effective_headway_sec)
        return self.base_headway_s

    def _trains_for(self, headway_s: float) -> int:
        T = self.round_trip_s or reference_cycle()[0]
        return max(1, min(MAX_IN_SERVICE, math.ceil(T / max(headway_s, 30.0))))

    def target_trains(self) -> int:
        """Trains needed for the current target headway."""
        return self._trains_for(self.target_headway_s)

    def planned_trains(self) -> int:
        """Trains wanted now, looking ahead PLAN_LOOKAHEAD_S so trains enter service before a
        busier period starts (and are not withdrawn just before one)."""
        bias = self.target_headway_s - self.base_headway_s
        best = self.target_trains()
        for k in range(1, 9):
            _n, hw, _p = period_at(self.clock_s + PLAN_LOOKAHEAD_S * k / 8)
            best = max(best, self._trains_for(max(60.0, hw + bias)))
        return best

    def regulated_headway_s(self) -> float:
        """Headway terminal departures are spaced to: the target, unless the trains actually in
        service can't sustain it (then round trip / trains) — holding to an unattainable
        headway only builds queues at the terminal home signals."""
        T = self.round_trip_s or reference_cycle()[0]
        n = max(1, self.in_service(self.lines[0]) if self.lines else 1)
        return min(self.target_headway_s, T / n)

    def in_service(self, line: train.Line) -> int:
        return sum(1 for t in line.trains if not t.to_yard)

    def _populate_opening_roster(self, line: train.Line) -> None:
        T, samples = reference_cycle()
        self.round_trip_s = T
        n = max(1, min(MAX_IN_SERVICE, math.ceil(T / self.base_headway_s)))
        line.trains.clear()
        for k in range(n):
            t_k = (k + 0.37) * T / n
            s = samples[min(len(samples) - 1, int(round(t_k / DT)))]
            _t, c, v, a, a_tgt, stop_idx, berthed, dwell_rem, dwell_tot, ready = s
            tr = train.Train(chainage_front_m=c, run_number=k)
            tr.v, tr.a, tr.a_target = v, a, a_tgt
            tr.stop_idx = stop_idx
            tr.berthed_idx = berthed
            if berthed is not None:
                tr.at_station_name = PLATFORMS[berthed].name
                tr.dwell_total_sec = dwell_tot
                tr.dwell_remaining_sec = dwell_rem
                tr.ready_to_depart = ready
            line.trains.append(tr)
        line.trains.sort(key=lambda t: t.run_number)

    def _prime(self) -> None:
        for line in self.lines:
            for tr in line.trains:
                self.ato.ensure_train_state(tr)
            order = sorted(line.trains, key=lambda t: t.chainage_front_m)
            self.interlocking.update(order, [t.chainage_front_m for t in order])
            self.zone.update(line.trains, self.interlocking, order)
            self._order = order

    # ── hooks ───────────────────────────────────────────────────────────────
    def _departure_ok(self, tr: train.Train, sig) -> bool:
        now = self._sim_time_s
        if tr.berthed_idx is None:
            # Recovery: a train standing (not berthed) just past the departure stopping point
            # (e.g. a small overrun) is let go after a minimum dwell instead of waiting forever.
            past = (tr.chainage_front_m - (sig.ch - 10.0)) % ROUTE_LEN_M
            return tr.v == 0.0 and past <= 25.0 and tr.stationary_s >= 30.0
        if not tr.ready_to_depart:
            return False
        last = self._terminal_last_dep.get(sig.interlocking)
        if last is None:
            return True
        h = self.regulated_headway_s()
        ready_since = getattr(tr, "_ready_since", now)
        if now >= last + 0.97 * h:
            return True
        # Don't let a regulating hold block the turnback of the train behind.
        if self._turnback_waiting(sig.interlocking):
            return now - ready_since >= 15.0
        return now - ready_since >= 0.35 * h

    def _turnback_waiting(self, terminal: str) -> bool:
        arr = next(p.ring_index for p in PLATFORMS if p.name == terminal and p.role == "arrival")
        for tr in self.lines[0].trains:
            if tr.berthed_idx == arr and tr.ready_to_depart:
                return True
        return False

    def _on_depart(self, tr: train.Train, k: int, t: float) -> None:
        last = self._last_dep.get(k)
        if last is not None:
            self._headways.append((t, t - last))
        self._last_dep[k] = t
        p = PLATFORMS[k]
        if p.terminal and p.role == "departure":
            self._terminal_last_dep[p.name] = t
            if tr.to_yard is None and self.spawning:
                self._maybe_withdraw(tr, p.name)

    def _on_pass(self, tr: train.Train, k: int, why: str, t: float) -> None:
        p = PLATFORMS[k]
        if why == "overrun":
            self.missed_stops.append((t, tr.train_id, k))
            self.missed_stop_count += 1
            self._log("warn", f"{tr.train_id} overran {p.name} ({p.leg})")
        elif why == "late_release":
            self._log("info", f"{tr.train_id} released too close to {p.name} to stop — passing it")

    def _log(self, severity: str, message: str) -> None:
        self.event_log_extra.appendleft({"severity": severity, "kind": "SIM", "message": message,
                                         "source": "sim", "sim_t": self._sim_time_s})

    # ── yard moves ──────────────────────────────────────────────────────────
    # Trains leaving Vaughan MC run out of service to Wilson Yard (after Sheppard West); trains
    # leaving Finch to Davisville Yard (after Eglinton).  Both directions thin out together.
    _WITHDRAW_YARD = {VAUGHAN: 'Wilson Yard', FINCH: 'Davisville Yard'}

    def _maybe_withdraw(self, tr: train.Train, terminal: str) -> None:
        line = self.lines[0]
        surplus = self.in_service(line) - self.planned_trains()
        if not self._withdrawing and surplus >= WITHDRAW_START_SURPLUS:
            self._withdrawing = True
        if self._withdrawing and surplus <= WITHDRAW_STOP_SURPLUS:
            self._withdrawing = False
        if not self._withdrawing:
            return
        yard = self._WITHDRAW_YARD.get(terminal)
        if yard is None:
            return
        # Withdraw every other departure from each terminal so the gaps stay even.
        last = self._last_withdraw.get(terminal, -1e9)
        if self._sim_time_s - last < 1.5 * self.target_headway_s:
            return
        y = next(y for y in YARDS if y['name'] == yard)
        j = y['chainage_m']
        tr.to_yard = y['name']
        tr._withdraw_t = self._sim_time_s
        self._last_withdraw[terminal] = self._sim_time_s
        tr.extra_restrictions = [((j - 220.0) % ROUTE_LEN_M, j % ROUTE_LEN_M, YARD_ENTRY_KPH * KPH_TO_MPS)]
        self._log("info", f"{tr.train_id} to run out of service to {y['name']}")

    def _gap_for_insertion(self, order: list[train.Train], j: float) -> bool:
        n = len(order)
        if n == 0:
            return True
        nose_new = j + YARD_EXIT_NOSE_M
        tail_new = nose_new - TRAIN_LENGTH_M
        # No train body may overlap the new train's body (plus the yard-exit fouling zone).
        lo = j - 20.0
        span = nose_new - lo
        for tr in order:
            if (tr.chainage_front_m - lo) % ROUTE_LEN_M < span + tr.length_m:
                return False
        # Leader: first train whose tail is ahead of the new nose.
        best_a, best_g = None, None
        follower = None
        for tr in order:
            a = (tr.chainage_front_m - tr.length_m - nose_new) % ROUTE_LEN_M
            if best_a is None or a < best_a:
                best_a = a
            g = (tail_new - tr.chainage_front_m) % ROUTE_LEN_M
            if best_g is None or g < best_g:
                best_g, follower = g, tr
        if best_a < SPAWN_LEADER_CLEAR_M:
            return False
        v = follower.v
        need = v * v / (2.0 * ATO_STOP_DECEL_MPS2) + SPAWN_FOLLOWER_EXTRA_M
        return best_g >= need

    def _service_moves(self, line: train.Line) -> None:
        # Withdrawals: a to_yard train disappears into the lead when its nose reaches it.
        for tr in list(line.trains):
            if tr.to_yard:
                y = next(y for y in YARDS if y['name'] == tr.to_yard)
                if (y['chainage_m'] - tr.chainage_front_m) % ROUTE_LEN_M < 2.0 or \
                        (tr.chainage_front_m - y['chainage_m']) % ROUTE_LEN_M < 30.0:
                    tr.removed = True
                    line.trains.remove(tr)
                    self.removed_trains.append(tr)
                    self._removed_atp_trips += tr.atp_trips
                    self._withdraw_count += 1
                    self._log("info", f"{tr.train_id} entered {tr.to_yard} (out of service)")
        if not self.spawning:
            return
        need = self.planned_trains() - self.in_service(line)
        self._insert_pending = need > 0
        self.interlocking.yard_requests.clear()
        if need <= 0:
            self._last_dispatch_blocked = False
            return
        blocked = True
        for y in YARDS:
            if self._sim_time_s - self._last_spawn.get(y['name'], -1e9) < SPAWN_MIN_INTERVAL_S:
                continue
            if self._gap_for_insertion(self._order, y['chainage_m']):
                self.interlocking.yard_requests.add(y['name'])
                blocked = False
                break
        self._last_dispatch_blocked = blocked

    def _spawn(self, line: train.Line, yard: dict) -> train.Train:
        self._max_run += 1
        run = self._max_run
        tr = train.Train(chainage_front_m=yard['chainage_m'] + YARD_EXIT_NOSE_M, run_number=run)
        self.ato.ensure_train_state(tr)
        line.trains.append(tr)
        self.interlocking.mark_yard_train(yard['name'], tr)
        self._dispatch_count += 1
        self._last_dispatch_s = self._sim_time_s
        self._last_spawn[yard['name']] = self._sim_time_s
        self._log("info", f"{tr.train_id} entered service from {yard['name']}")
        return tr

    # ── stepping ────────────────────────────────────────────────────────────
    def step(self, dt: float = DT) -> None:
        self._sim_time_us += int(round(dt * 1e6))
        self._sim_time_s = self._sim_time_us / 1e6
        self.version += 1
        t = self._sim_time_s
        self.period_name, self.base_headway_s, self.peak = period_at(self.clock_s)
        if self.use_dispatch:
            self.dispatch.base_headway_sec = self.base_headway_s
            self.ato.dwell_bias_s = float(self.dispatch.dwell_bias_sec)
        self.ato.peak = self.peak
        if self.use_events:
            try:
                event_registry.tick(self.lines, dt, t)
            except Exception:              # incidents must never stop the railway
                self.step_errors += 1
                log.exception("event tick failed")
        for line in self.lines:
            trains = line.trains
            order = sorted(trains, key=lambda tr: tr.chainage_front_m)
            noses = [tr.chainage_front_m for tr in order]
            il = self.interlocking
            il.update(order, noses)
            if il.yard_granted:
                for y in YARDS:
                    if y['name'] in il.yard_granted and self._gap_for_insertion(order, y['chainage_m']):
                        self._spawn(line, y)
                il.yard_requests.clear()
                order = sorted(trains, key=lambda tr: tr.chainage_front_m)
            self.zone.update(trains, il, order)
            ato = self.ato
            for tr in order:
                was_ready = tr.ready_to_depart
                ato.control(tr, dt, t)
                if tr.ready_to_depart and not was_ready:
                    tr._ready_since = t
                tr.atp_supervise(dt)
                before = tr.chainage_front_m
                ds = tr.integrate(dt)
                ato.post_move(tr, before, ds, t)
                if tr.v <= 0.0 and tr.berthed_idx is None:
                    tr.stationary_s += dt
                else:
                    tr.stationary_s = 0.0
            self._order = order
            self._service_moves(line)
            if self.use_dispatch:
                try:
                    self.dispatch.tick(self, line, dt)
                except Exception:          # a bad ML reply must never stop the railway
                    self.step_errors += 1
                    log.exception("dispatch tick failed")

    def run(self, seconds: float, dt: float = DT, on_step=None) -> None:
        for _ in range(int(round(seconds / dt))):
            self.step(dt)
            if on_step is not None:
                on_step(self)

    # ── telemetry ───────────────────────────────────────────────────────────
    def atp_trip_count(self) -> int:
        return sum(t.atp_trips for line in self.lines for t in line.trains) + self._removed_atp_trips

    def mean_headway_s(self) -> float | None:
        cutoff = self._sim_time_s - HEADWAY_WINDOW_S
        hs = [h for (t, h) in self._headways if t >= cutoff]
        return sum(hs) / len(hs) if hs else None

    def service_status(self, line: train.Line) -> dict:
        mh = self.mean_headway_s()
        return {
            "trains_in_service": self.in_service(line),
            "target_headway_s": round(self.target_headway_s, 1),
            "mean_headway_s": round(mh, 1) if mh is not None else None,
            "period": self.period_name,
            "base_headway_s": self.base_headway_s,
            "target_trains": self.target_trains(),
            "round_trip_s": round(self.round_trip_s, 1) if self.round_trip_s else None,
            "clock": format_clock(self.clock_s),
            "withdrawn": self._withdraw_count,
        }

    def dispatch_status(self, line: train.Line) -> dict:
        target_hw = self.target_headway_s
        out = {
            "count": self._dispatch_count,
            "last_dispatch_sim_t": self._last_dispatch_s,
            "next_due_in_s": 0.0 if self._insert_pending else None,
            "blocked": bool(self._insert_pending and self._last_dispatch_blocked),
            "max_trains": MAX_IN_SERVICE,
            "target_headway_sec": target_hw,
        }
        out.update(self.dispatch.status_payload())
        return out

    def _yard_occupied(self, line: train.Line) -> bool:
        j = SPAWN_CHAINAGE_M
        for tr in line.trains:
            rel = (tr.chainage_front_m - (j - 20.0)) % ROUTE_LEN_M
            if rel < YARD_EXIT_NOSE_M + 40.0 + tr.length_m:
                return True
        return False

    # ── /state payload ──────────────────────────────────────────────────────
    def train_payload(self, tr: train.Train) -> dict:
        eid, offset = chainage_to_edge(tr.chainage_front_m)
        berthed = tr.berthed_idx is not None
        eb = tr.e_brake or tr.atp_eb
        held = bool(tr._op_hold or getattr(tr, "_station_hold", False) or getattr(tr, "_door_interlock", False))
        reason = None
        if berthed:
            state = "dwelling"
            p = PLATFORMS[tr.berthed_idx]
            if eb:
                reason = "emergency_brake"
            elif held:
                reason = "dispatcher_hold"
            elif p.terminal:
                reason = "turnback"
            elif tr.ready_to_depart:
                reason = tr.eoa_source
        elif tr.v <= 0.0:
            state = "stopped"
            if eb:
                reason = "emergency_brake"
            elif tr.ato_binding == "eoa":
                reason = tr.eoa_source
            elif tr.ato_binding == "stop" and tr.eoa_source and tr.eoa_dist_m < 20.0:
                reason = tr.eoa_source
        else:
            state = "arriving" if tr.ato_binding == "stop" else "running"
            if eb:
                reason = "emergency_brake"
        # Next station / destination
        k_here = tr.berthed_idx if berthed else (tr.stop_idx if tr.stop_idx is not None else 0)
        leg = PLATFORMS[k_here].leg
        destination = tr.to_yard if tr.to_yard else PLATFORMS[k_here].destination
        nxt = None
        if tr.stop_idx is not None:
            k = effective_stop(tr)
            if berthed and PLATFORMS[k].name == tr.at_station_name:
                save = tr.stop_idx
                tr.stop_idx = (k + 1) % len(PLATFORMS)
                k = effective_stop(tr)
                tr.stop_idx = save
            nxt = PLATFORMS[k].name
            if tr.to_yard:
                y = next(y for y in YARDS if y['name'] == tr.to_yard)
                if forward_distance(tr.chainage_front_m, y['chainage_m']) < forward_distance(tr.chainage_front_m, PLATFORMS[k].chainage_m):
                    nxt = None
        v = tr.v
        clock_h = (self.clock_s / 3600.0) % 24.0
        peak = math.exp(-((clock_h - 8.0) ** 2) / 1.5) + 0.85 * math.exp(-((clock_h - 17.5) ** 2) / 2.0)
        run_num = int(tr.run_number or 0)
        base_load = 0.18 + 0.65 * min(1.0, peak)
        jitter = (math.sin(run_num * 1.7) + 1.0) * 0.06
        load_pct = 0.0 if tr.to_yard and not berthed else max(0.0, min(1.0, base_load + jitter - 0.08))
        capacity = 1100
        slack = tr.atp_slack_m
        eoa = tr.authority_eoa_m
        return {
            "train_id": tr.train_id,
            "label": f"Run {run_num}",
            "edge_id": eid,
            "offset": offset,
            "speed": v,
            "state": state,
            "station_name": tr.at_station_name if berthed else None,
            "dwell_remaining_sec": round(tr.dwell_remaining_sec, 2) if berthed else 0.0,
            "safe_zone_front": round(tr.required_gap_m, 2),
            "safe_zone_rear": tr.length_m,
            "atp_slack_m": round(slack, 2) if math.isfinite(slack) else None,
            "authority_eoa_m": _wrap_round(eoa, 2) if eoa is not None else None,
            "fleet": "Bombardier TR",
            "passengers": int(round(capacity * load_pct)),
            "passenger_capacity": capacity,
            "load_pct": round(load_pct, 3),
            "dispatch_hold": bool(tr._op_hold),
            "dispatch_express": bool(tr._op_express),
            "dispatch_skip_remaining": int(tr._op_skip_remaining),
            # v2 additions
            "chainage_m": _wrap_round(tr.chainage_front_m, 3),
            "length_m": tr.length_m,
            "accel_mps2": round(tr.a, 4),
            "stop_reason": reason,
            "next_station_name": nxt,
            "destination": destination,
            "gap_to_leader_m": round(tr.gap_to_leader_m, 2) if tr.gap_to_leader_m is not None else None,
            "leader_id": f"T{int(tr.leader_run_number):02d}" if tr.leader_run_number is not None else None,
            "leg": leg,
            "e_brake": bool(eb),
            "in_service": not bool(tr.to_yard),
        }

    def snapshot(self) -> dict:
        """Consistent /state payload.  Caller should hold ``self.lock``."""
        line0 = self.lines[0] if self.lines else None
        trains_out = [self.train_payload(t) for line in self.lines for t in line.trains]
        occupied: set[str] = set()
        edges = topology.EDGES
        for line in self.lines:
            for tr in line.trains:
                # Every edge the body covers (a train can straddle a short crossover).
                for eid in edges_spanned(tr.chainage_front_m - tr.length_m, tr.chainage_front_m):
                    occupied.add(edges[eid]["block_id"])
        blocks = [{"block_id": bid, "occupancy": "occupied" if bid in occupied else "clear"}
                  for bid in _ALL_BLOCKS]
        switches = [{"switch_id": sw, "state": st} for sw, st in self.interlocking.switch_states.items()]
        ops: dict = {}
        if line0 is not None:
            ops["dispatch"] = self.dispatch_status(line0)
            ops["service"] = self.service_status(line0)
        ops["injected_events"] = event_registry.active_payload()
        # Merge, newest first, THEN cut — so injected-incident rows are never crowded out by
        # routine yard-move rows.
        merged = list(self.event_log_extra) + event_registry.recent_log()
        merged.sort(key=lambda r: -float(r.get("sim_t", 0.0)))
        ops["event_log"] = merged[:50]
        return {
            "trains": trains_out,
            "blocks": blocks,
            "switches": switches,
            "signals": self.interlocking.signals_payload(),
            "ops": ops,
            "sim_time_s": self._sim_time_s,
            "clock": format_clock(self.clock_s),
            "sim_speed": self.speed,
            "paused": self.paused,
            "step_s": DT,
        }


    def snapshot_json(self) -> bytes:
        """/state body as JSON bytes, encoded once per sim step / API mutation and cached.
        Never emits NaN/Infinity (non-finite floats become null).  Caller holds ``self.lock``."""
        cache = self._json_cache
        if cache is not None and cache[0] == self.version:
            return cache[1]
        snap = self.snapshot()
        try:
            body = json.dumps(snap, allow_nan=False, separators=(",", ":")).encode()
        except ValueError:
            log.warning("non-finite value in /state payload; sanitising")
            body = json.dumps(train._json_safe(snap), allow_nan=False, separators=(",", ":")).encode()
        self._json_cache = (self.version, body)
        return body


def _wrap_round(c: float, nd: int) -> float:
    """Round a chainage and keep it in [0, L) (rounding can produce exactly L)."""
    r = round(c % ROUTE_LEN_M, nd)
    return 0.0 if r >= round(ROUTE_LEN_M, nd) else r


_ALL_BLOCKS = sorted({e["block_id"] for e in topology.YUS_TOPOLOGY["edges"]})

simulation = Simulation()
