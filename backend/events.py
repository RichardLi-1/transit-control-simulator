"""Injected incidents — timed effects on trains / wayside (see docs/PROJECT.md narrow API)."""

from __future__ import annotations

import itertools
import logging
import math
from dataclasses import dataclass, field
from typing import Any, Literal

import commands as cmd_api
import topology
import train
from train import Train, TrainCommand

EventKind = Literal[
    "emergency_brake",
    "emergency_brake_release",
    "slow_speed",
    "door_fault",
    "signal_fail",
    "station_hold",
    "operator_note",
]

VALID_KINDS = frozenset(
    {
        "emergency_brake",
        "emergency_brake_release",
        "slow_speed",
        "door_fault",
        "signal_fail",
        "station_hold",
        "operator_note",
    }
)


@dataclass
class InjectedIncident:
    id: str
    kind: str
    duration_s: float
    remaining_s: float
    starts_in_s: float = 0.0
    target_train_id: str | None = None
    target_signal_id: str | None = None
    target_switch_id: str | None = None
    speed_limit_kph: float | None = None
    note: str = ""
    source: str = "manual"
    created_sim_t: float = 0.0
    active: bool = False
    _released_eb: bool = field(default=False, repr=False)
    _prev_override: str | None = field(default=None, repr=False)


def _train_by_id(lines: list[train.Line], train_id: str) -> Train | None:
    if not train_id or not train_id.startswith("T"):
        return None
    try:
        run = int(train_id[1:])
    except ValueError:
        return None
    for line in lines:
        for tr in line.trains:
            if tr.run_number == run:
                return tr
    return None


TRAIN_KINDS = frozenset({"emergency_brake", "emergency_brake_release", "slow_speed", "door_fault", "station_hold"})
MAX_DURATION_S = 24 * 3600.0
MAX_STARTS_IN_S = 24 * 3600.0
SPEED_LIMIT_RANGE_KPH = (0.0, 88.0)   # 0 = "stop where you are"
_TRAIN_ATTR = {"slow_speed": "_speed_cap_kph", "door_fault": "_door_interlock", "station_hold": "_station_hold"}

log = logging.getLogger("cbtc.events")


def _finite(name: str, value: float | None, lo: float, hi: float, *, allow_none: bool = False) -> float | None:
    if value is None:
        if allow_none:
            return None
        raise ValueError(f"{name} is required")
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number") from None
    if not math.isfinite(v) or not (lo <= v <= hi):
        raise ValueError(f"{name} must be a finite number in [{lo:g}, {hi:g}]")
    return v


class EventRegistry:
    def __init__(self) -> None:
        self._incidents: dict[str, InjectedIncident] = {}
        self._log: list[dict[str, Any]] = []
        self._max_log = 50
        self._seq = itertools.count(1)

    def _log_event(self, *, severity: str, kind: str, message: str, source: str, sim_t: float) -> None:
        row = {
            "severity": severity,
            "kind": kind,
            "message": message,
            "source": source,
            "sim_t": sim_t,
        }
        self._log.insert(0, row)
        self._log = self._log[: self._max_log]

    def inject(
        self,
        *,
        lines: list[train.Line],
        kind: str,
        sim_time_s: float,
        duration_s: float = 30.0,
        starts_in_s: float = 0.0,
        target_train_id: str | None = None,
        target_signal_id: str | None = None,
        target_switch_id: str | None = None,
        speed_limit_kph: float | None = None,
        note: str = "",
        source: str = "manual",
        event_id: str | None = None,
    ) -> InjectedIncident:
        """Validate everything BEFORE storing: a bad incident must never reach ``tick``."""
        if kind not in VALID_KINDS:
            raise ValueError(f"unknown event kind: {kind!r}")
        if kind == "operator_note":
            duration_s = 0.0
            starts_in_s = 0.0
        else:
            duration_s = _finite("duration_s", duration_s, 1e-3, MAX_DURATION_S)
            starts_in_s = _finite("starts_in_s", starts_in_s, 0.0, MAX_STARTS_IN_S)
        if kind in TRAIN_KINDS:
            if not target_train_id:
                raise ValueError(f"{kind} needs target_train_id")
            if _train_by_id(lines, target_train_id) is None:
                raise ValueError(f"unknown target_train_id: {target_train_id!r}")
        elif target_train_id and _train_by_id(lines, target_train_id) is None:
            raise ValueError(f"unknown target_train_id: {target_train_id!r}")
        signal_ids = {sg["id"] for sg in topology.YUS_TOPOLOGY["signals"]}
        if kind == "signal_fail" and not target_signal_id:
            raise ValueError("signal_fail needs target_signal_id")
        if target_signal_id is not None and target_signal_id not in signal_ids:
            raise ValueError(f"unknown target_signal_id: {target_signal_id!r}")
        if target_switch_id is not None and target_switch_id not in {sw["id"] for sw in topology.YUS_TOPOLOGY["switches"]}:
            raise ValueError(f"unknown target_switch_id: {target_switch_id!r}")
        if kind == "slow_speed":
            speed_limit_kph = _finite("speed_limit_kph", speed_limit_kph, *SPEED_LIMIT_RANGE_KPH)
        elif speed_limit_kph is not None:
            speed_limit_kph = _finite("speed_limit_kph", speed_limit_kph, *SPEED_LIMIT_RANGE_KPH)
        if event_id is not None and event_id in self._incidents:
            raise ValueError(f"duplicate event id: {event_id!r}")

        eid = event_id or f"evt_{next(self._seq):05d}"
        while eid in self._incidents:      # paranoia: never overwrite a live incident
            eid = f"evt_{next(self._seq):05d}"
        inc = InjectedIncident(
            id=eid,
            kind=kind,
            duration_s=float(duration_s),
            remaining_s=float(duration_s),
            starts_in_s=float(starts_in_s),
            target_train_id=target_train_id,
            target_signal_id=target_signal_id,
            target_switch_id=target_switch_id,
            speed_limit_kph=speed_limit_kph,
            note=(note or "").strip()[:200],
            source=source,
            created_sim_t=sim_time_s,
            active=starts_in_s <= 0,
        )
        self._incidents[eid] = inc

        if inc.active:
            self._activate(inc, lines, sim_time_s=sim_time_s)
            if inc.kind == "operator_note":
                self._incidents.pop(eid, None)

        when = "now" if inc.active else f"in ~{inc.starts_in_s:.0f}s"
        self._log_event(
            severity="info",
            kind="INJT",
            source=source,
            sim_t=sim_time_s,
            message=f"scheduled {kind} {when}" + (f" → {target_train_id}" if target_train_id else "")
            + (f" → {target_signal_id}" if target_signal_id else "")
            + (f" ({inc.note})" if inc.note else ""),
        )
        return inc

    def cancel(self, event_id: str, *, lines: list[train.Line], sim_time_s: float) -> None:
        inc = self._incidents.pop(event_id, None)
        if inc is None:
            raise KeyError(event_id)
        if inc.active:
            self._clear_effects(inc, lines)
        self._deactivate(inc, sim_time_s=sim_time_s, reason="cancelled")

    def tick(self, lines: list[train.Line], dt: float, sim_time_s: float) -> None:
        expired: list[InjectedIncident] = []
        for inc in list(self._incidents.values()):
            if inc.id not in self._incidents:      # ended by another incident this tick
                continue
            try:
                if not inc.active:
                    inc.starts_in_s = max(0.0, inc.starts_in_s - dt)
                    if inc.starts_in_s <= 0:
                        inc.active = True
                        self._activate(inc, lines=lines, sim_time_s=sim_time_s)
                    continue
                if inc.kind == "operator_note":
                    continue
                inc.remaining_s = max(0.0, inc.remaining_s - dt)
                self._apply_active(inc, lines)
                if inc.remaining_s <= 0:
                    expired.append(inc)
            except Exception as exc:   # one bad incident must never stop the simulation
                log.exception("dropping incident %s (%s)", inc.id, inc.kind)
                self._incidents.pop(inc.id, None)
                self._log_event(severity="error", kind="INJT", source=inc.source, sim_t=sim_time_s,
                                message=f"{inc.kind} dropped: {exc}")

        for inc in expired:
            if self._incidents.pop(inc.id, None) is None:
                continue
            try:
                self._clear_effects(inc, lines)
            except Exception:
                log.exception("clearing incident %s", inc.id)
            self._deactivate(inc, sim_time_s=sim_time_s, reason="expired")

    def _others_active(self, inc: InjectedIncident) -> bool:
        return any(o is not inc and o.active and o.kind == inc.kind and o.target_train_id == inc.target_train_id
                   and o.target_signal_id == inc.target_signal_id for o in self._incidents.values())

    def _clear_effects(self, inc: InjectedIncident, lines: list[train.Line]) -> None:
        tr = _train_by_id(lines, inc.target_train_id) if inc.target_train_id else None
        if self._others_active(inc):
            return          # another incident of the same kind still holds this effect
        if inc.kind == "emergency_brake" and tr is not None and not inc._released_eb:
            tr.apply_command(TrainCommand(tr.direction, 0.0, e_brake=False))
        if inc.kind == "signal_fail" and inc.target_signal_id:
            # Restore whatever the operator had set before the failure (or clear).
            if inc._prev_override is None:
                cmd_api.clear_signal_override(inc.target_signal_id)
            else:
                cmd_api.set_signal(inc.target_signal_id, inc._prev_override)
        attr = _TRAIN_ATTR.get(inc.kind)
        if tr is not None and attr and hasattr(tr, attr):
            delattr(tr, attr)

    def _activate(self, inc: InjectedIncident, lines: list[train.Line] | None, sim_time_s: float) -> None:
        if lines is None:
            return
        if inc.kind == "signal_fail" and inc.target_signal_id:
            prev = cmd_api._signal_overrides.get(inc.target_signal_id)
            inc._prev_override = None if self._others_active(inc) else prev
            cmd_api.set_signal(inc.target_signal_id, "red")
        if inc.kind == "emergency_brake_release" and inc.target_train_id:
            # Releasing ends any active emergency-brake incident on that train.
            for other in list(self._incidents.values()):
                if other.kind == "emergency_brake" and other.target_train_id == inc.target_train_id:
                    other._released_eb = True
                    self._incidents.pop(other.id, None)
                    self._deactivate(other, sim_time_s=sim_time_s, reason="released")
        self._apply_active(inc, lines)
        self._log_event(
            severity="warn" if inc.kind in ("emergency_brake", "signal_fail") else "info",
            kind="INJT",
            source=inc.source,
            sim_t=sim_time_s,
            message=f"active {inc.kind}"
            + (f" → {inc.target_train_id}" if inc.target_train_id else "")
            + (f" → {inc.target_signal_id}" if inc.target_signal_id else "")
            + (f" ({inc.remaining_s:.0f}s left)" if inc.duration_s > 0 else ""),
        )

    def _deactivate(self, inc: InjectedIncident, *, sim_time_s: float, reason: str) -> None:
        self._log_event(
            severity="info",
            kind="INJT",
            source=inc.source,
            sim_t=sim_time_s,
            message=f"{inc.kind} {reason}" + (f" → {inc.target_train_id}" if inc.target_train_id else ""),
        )

    def _apply_active(self, inc: InjectedIncident, lines: list[train.Line]) -> None:
        tr = _train_by_id(lines, inc.target_train_id) if inc.target_train_id else None

        if inc.kind == "emergency_brake" and tr is not None and not inc._released_eb:
            tr.apply_command(TrainCommand(tr.direction, 0.0, e_brake=True))

        if inc.kind == "emergency_brake_release" and tr is not None:
            tr.apply_command(TrainCommand(tr.direction, 0.0, e_brake=False))
            inc._released_eb = True

        # Speed restriction for one train: goes into the ATO profile (the train brakes to it at
        # service rate).  No hard clamp on the integrated speed.
        if inc.kind == "slow_speed" and tr is not None and inc.speed_limit_kph is not None:
            setattr(tr, "_speed_cap_kph", float(inc.speed_limit_kph))

        # Door fault: doors won't prove closed, so a train at a platform cannot depart; a train
        # in motion is affected at its next stop.  (Never freezes a moving train.)
        if inc.kind == "door_fault" and tr is not None:
            setattr(tr, "_door_interlock", True)

        # Station hold: keep the train at its current / next platform until released.
        if inc.kind == "station_hold" and tr is not None:
            setattr(tr, "_station_hold", True)

        if inc.kind == "signal_fail" and inc.target_signal_id:
            if cmd_api._signal_overrides.get(inc.target_signal_id) != "red":
                cmd_api.set_signal(inc.target_signal_id, "red")

    def active_payload(self) -> list[dict[str, Any]]:
        out = []
        for inc in self._incidents.values():
            out.append(
                {
                    "id": inc.id,
                    "kind": inc.kind,
                    "target_train_id": inc.target_train_id,
                    "target_signal_id": inc.target_signal_id,
                    "target_switch_id": inc.target_switch_id,
                    "duration_s": inc.duration_s,
                    "remaining_s": inc.remaining_s,
                    "starts_in_s": inc.starts_in_s,
                    "speed_limit_kph": inc.speed_limit_kph,
                    "note": inc.note,
                    "source": inc.source,
                    "active": inc.active,
                    "created_sim_t": inc.created_sim_t,
                }
            )
        return out

    def recent_log(self) -> list[dict[str, Any]]:
        return list(self._log)


registry = EventRegistry()
