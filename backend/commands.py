"""Manual switch/signal overrides from the dispatch UI (until operations DB exists)."""

from __future__ import annotations

from typing import Literal

import topology
import train as _train_mod

SwitchState = Literal["normal", "reverse"]
SignalAspect = Literal["red", "yellow", "green"]
DispatchAction = Literal["hold", "express", "skip", "release"]

_switch_overrides: dict[str, SwitchState] = {}
_signal_overrides: dict[str, SignalAspect] = {}


def set_switch(switch_id: str, state: str) -> None:
    """Operator points control.  'normal' / 'reverse' hold the points there (routes that need
    the other position cannot be set); 'auto' hands them back to the interlocking."""
    if state not in ("normal", "reverse", "auto"):
        raise ValueError(f"invalid switch state: {state!r}")
    sw = next((s for s in topology.YUS_TOPOLOGY["switches"] if s["id"] == switch_id), None)
    if sw is None:
        raise KeyError(f"unknown switch_id: {switch_id!r}")
    if state == "auto":
        _switch_overrides.pop(switch_id, None)
        sw["state"] = "normal"
        return
    _switch_overrides[switch_id] = state  # type: ignore[assignment]
    sw["state"] = state


def set_signal(signal_id: str, aspect: str) -> None:
    """Operator signal control.  'red' = hold at stop; 'green'/'yellow' = call-on (moving
    block still protects); 'auto' = clear the override."""
    if aspect not in ("red", "yellow", "green", "auto"):
        raise ValueError(f"invalid signal aspect: {aspect!r}")
    sig = next((s for s in topology.YUS_TOPOLOGY["signals"] if s["id"] == signal_id), None)
    if sig is None:
        raise KeyError(f"unknown signal_id: {signal_id!r}")
    if aspect == "auto":
        clear_signal_override(signal_id)
        return
    if sig.get("kind") == "yard_exit" and aspect in ("green", "yellow"):
        # A yard-exit signal only clears when the dispatcher inserts a train (there is no
        # train waiting on the lead to call on).  Holding it at red is allowed.
        raise ValueError("yard exit signals clear only for a train entering service; use 'red' or 'auto'")
    _signal_overrides[signal_id] = aspect  # type: ignore[assignment]
    sig["aspect"] = aspect


def switch_state(switch_id: str, default: str) -> str:
    return _switch_overrides.get(switch_id, default)


def signal_aspect(signal_id: str, computed: str) -> str:
    return _signal_overrides.get(signal_id, computed)


def clear_signal_override(signal_id: str) -> None:
    _signal_overrides.pop(signal_id, None)
    for sig in topology.YUS_TOPOLOGY["signals"]:
        if sig["id"] == signal_id:
            sig["aspect"] = "red"      # interlocking signals are normally at stop
            break


def reset_overrides() -> None:
    """Drop every operator override (tests / sim reset)."""
    _signal_overrides.clear()
    _switch_overrides.clear()
    for sw in topology.YUS_TOPOLOGY["switches"]:
        sw["state"] = "normal"
    for sig in topology.YUS_TOPOLOGY["signals"]:
        sig["aspect"] = "red"


def _find_train(train_id: str):
    """Resolve a 'T01'-style id to its Train instance, or None."""
    if not train_id or not train_id.startswith("T"):
        return None
    try:
        run = int(train_id[1:])
    except ValueError:
        return None
    for line in _train_mod.lines:
        for tr in line.trains:
            if tr.run_number == run:
                return tr
    return None


def set_train_dispatch(train_id: str, action: str, count: int = 1) -> None:
    """Service-regulation moves Transit Control issues to a single train.

    hold    — keep dwelling at the platform until released (close the gap behind)
    express — run non-stop past every station until released
    skip    — pass the next `count` stops, then resume normal stopping
    release — clear all overrides, back to normal ATO stopping
    """
    tr = _find_train(train_id)
    if tr is None:
        raise KeyError(f"unknown train_id: {train_id!r}")
    if action == "hold":
        tr._op_hold = True
        tr._op_express = False
        tr._op_skip_remaining = 0
    elif action == "express":
        tr._op_express = True
        tr._op_hold = False
        tr._op_skip_remaining = 0
    elif action == "skip":
        tr._op_skip_remaining = max(1, int(count))
        tr._op_express = False
        tr._op_hold = False
    elif action == "release":
        tr._op_hold = False
        tr._op_express = False
        tr._op_skip_remaining = 0
    else:
        raise ValueError(f"invalid dispatch action: {action!r}")
