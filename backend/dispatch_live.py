"""Live dispatch: ML service (rule / PPO) → headway & dwell biases applied in the sim.

* The sim calls ``tick`` every step.  Every ACT_INTERVAL_S of sim time it builds a snapshot
  and hands it to a background worker that POSTs it to the ML API — the sim thread never
  blocks on the network.  Results are applied on a later tick.
* If the ML service is down / slow (or networking is disabled, e.g. in tests), a local rule
  fallback runs instead, so dispatch always works.
* effective_headway_sec = service-plan headway for the time of day + headway bias.
  effective_dwell_sec   = ordinary-station base dwell + dwell bias (informational; the sim
  adds ``dwell_bias_sec`` to every station dwell).
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sim import Simulation
    import train

ML_API_BASE = os.environ.get("ML_API_BASE", "http://127.0.0.1:8001").rstrip("/")
ACT_INTERVAL_S = float(os.environ.get("DISPATCH_ACT_INTERVAL_S", "2.0"))
HTTP_TIMEOUT_S = float(os.environ.get("DISPATCH_HTTP_TIMEOUT_S", "3.0"))
DEFAULT_HEADWAY_S = 150.0
MIN_HEADWAY_S = 60.0
DEFAULT_DWELL_S = 24.0
STALE_AFTER_WALL_S = 15.0   # wall seconds without a valid ML answer → use the fallback
MIN_SEND_WALL_S = 0.5       # don't post more often than this (wall clock), whatever the sim speed
HEADWAY_BIAS_RANGE = (-90.0, 180.0)
DWELL_BIAS_RANGE = (-15.0, 30.0)


def _num(result: dict, key: str, lo: float, hi: float, default: float = 0.0) -> float:
    """A finite number in range from an ML reply, else ValueError (malformed reply)."""
    v = result.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"ML reply field {key!r} is not a number: {v!r}")
    v = float(v)
    if not math.isfinite(v):
        raise ValueError(f"ML reply field {key!r} is not finite")
    return min(hi, max(lo, v))


def _rule_fallback_action(mean_slack_norm: float, headway_std_norm: float) -> tuple[float, float]:
    headway_cmd = 0.0
    if mean_slack_norm < 0.05:
        headway_cmd = 0.8
    elif mean_slack_norm > 0.4:
        headway_cmd = -0.3
    dwell_cmd = min(0.5, headway_std_norm)
    return headway_cmd, dwell_cmd


class LiveDispatchBridge:
    def __init__(self) -> None:
        self.mode = "rule"
        self.network_enabled = os.environ.get("DISPATCH_ML_DISABLED", "") not in ("1", "true", "yes")
        self.base_headway_sec = DEFAULT_HEADWAY_S
        self.headway_bias_sec = 0.0
        self.dwell_bias_sec = 0.0
        self.effective_headway_sec = DEFAULT_HEADWAY_S
        self.effective_dwell_sec = DEFAULT_DWELL_S
        self.shield_intervened = False
        self.shield_reason: str | None = None
        self.policy_ready = False
        self.last_error: str | None = None
        self.source = "fallback"
        self._accum_s = 0.0
        self._last_ml_wall = -1e9
        self._last_send_wall = -1e9
        self._sim_t = 0.0
        self._lock = threading.Lock()
        self._inflight = False
        self._pending: tuple[str, Any] | None = None   # ('ok', result) | ('err', message)

    def reset(self) -> None:
        """Forget biases / ML results (tests, sim reset)."""
        with self._lock:
            self._pending = None
        self.headway_bias_sec = 0.0
        self.dwell_bias_sec = 0.0
        self.base_headway_sec = DEFAULT_HEADWAY_S
        self.shield_intervened = False
        self.shield_reason = None
        self.last_error = None
        self.source = "fallback"
        self._accum_s = 0.0
        self._last_ml_wall = -1e9
        self._last_send_wall = -1e9
        self._recompute()

    # ── API used by main.py ─────────────────────────────────────────────────
    def set_mode(self, mode: str) -> dict[str, Any]:
        if mode not in ("rule", "ppo"):
            raise ValueError("mode must be 'rule' or 'ppo'")
        self.mode = mode
        if self.network_enabled:
            try:
                remote = self._post_json("/ml/dispatch/live/mode", {"mode": mode})
                if "policy_ready" in remote:
                    self.policy_ready = bool(remote["policy_ready"])
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                if mode == "ppo":
                    raise
        return self.status_payload()

    def status_payload(self) -> dict[str, Any]:
        return {
            "policy_mode": self.mode,
            "policy_ready": self.policy_ready,
            "headway_bias_sec": self.headway_bias_sec,
            "dwell_bias_sec": self.dwell_bias_sec,
            "effective_headway_sec": self.effective_headway_sec,
            "effective_dwell_sec": self.effective_dwell_sec,
            "base_headway_sec": self.base_headway_sec,
            "shield_intervened": self.shield_intervened,
            "shield_reason": self.shield_reason,
            "ml_error": self.last_error,
            "bias_source": self.source,
        }

    # ── internals ───────────────────────────────────────────────────────────
    def _post_json(self, path: str, payload: dict) -> dict[str, Any]:
        url = f"{ML_API_BASE}{path}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _recompute(self) -> None:
        self.effective_headway_sec = max(MIN_HEADWAY_S, self.base_headway_sec + self.headway_bias_sec)
        self.effective_dwell_sec = max(5.0, DEFAULT_DWELL_S + self.dwell_bias_sec)

    def _apply_act_result(self, result: dict[str, Any]) -> None:
        """Apply an ML answer.  Validated first: a malformed reply raises ValueError and changes
        nothing (the caller records the error and the rule fallback stays in charge)."""
        if not isinstance(result, dict):
            raise ValueError(f"ML reply is not an object: {type(result).__name__}")
        hw = _num(result, "headway_bias_sec", *HEADWAY_BIAS_RANGE)
        dw = _num(result, "dwell_bias_sec", *DWELL_BIAS_RANGE)
        reason = result.get("shield_reason")
        self.headway_bias_sec = hw
        self.dwell_bias_sec = dw
        self.shield_intervened = bool(result.get("shield_intervened", False))
        self.shield_reason = reason if isinstance(reason, str) or reason is None else str(reason)[:80]
        self.policy_ready = bool(result.get("policy_ready", False))
        self.last_error = None
        self.source = "ml"
        self._last_ml_wall = time.monotonic()
        self._recompute()

    def _fallback_act(self, snapshot: dict[str, Any]) -> None:
        trains = snapshot.get("trains") or []
        slacks = [float(t.get("atp_slack_m", 500.0)) for t in trains if math.isfinite(float(t.get("atp_slack_m", 500.0)))]
        mean_slack = sum(slacks) / max(len(slacks), 1) if slacks else 500.0
        mean_slack_norm = mean_slack / 500.0
        hw, dwell = _rule_fallback_action(mean_slack_norm, 0.0)
        self.headway_bias_sec = hw * 30.0
        self.dwell_bias_sec = dwell * 10.0
        self.shield_intervened = False
        self.shield_reason = "ml_unreachable"
        self.source = "fallback"
        self._recompute()

    def _worker(self, snapshot: dict, mode: str) -> None:
        try:
            result = self._post_json("/ml/dispatch/live/act", {"snapshot": snapshot, "mode": mode})
            out = ("ok", result)
        except Exception as exc:   # down, timeout, bad JSON …
            out = ("err", str(exc))
        with self._lock:
            self._pending = out
            self._inflight = False

    @staticmethod
    def build_snapshot(simulation: "Simulation", line: "train.Line") -> dict[str, Any]:
        trains = []
        slacks: list[float] = []
        for tr in line.trains:
            slack = float(tr.atp_slack_m)
            if math.isfinite(slack):
                slacks.append(slack)
            trains.append(
                {
                    "chainage_front_m": float(tr.chainage_front_m),
                    "speed_kph": float(tr.speed),
                    "atp_slack_m": slack if math.isfinite(slack) else 500.0,
                    "acceleration_level": float(tr.acceleration_level),
                }
            )
        return {
            "sim_time_s": float(simulation._sim_time_s),
            "route_len_m": float(simulation.route_len_m),
            "trains": trains,
            "yard_occupied": simulation._yard_occupied(line),
            "min_slack_m": min(slacks) if slacks else 500.0,
            "headway_bias_sec": simulation.dispatch.headway_bias_sec,
            "dwell_bias_sec": simulation.dispatch.dwell_bias_sec,
            "violations": int(simulation.atp_trip_count()),
            "mean_delay_sec": 0.0,
        }

    def tick(self, simulation: "Simulation", line: "train.Line", dt: float) -> None:
        self._sim_t = float(simulation._sim_time_s)
        # Apply a finished ML call, if any.
        pending = None
        with self._lock:
            if self._pending is not None:
                pending, self._pending = self._pending, None
        if pending is not None:
            kind, payload = pending
            if kind == "ok":
                try:
                    self._apply_act_result(payload)
                except Exception as exc:
                    self.last_error = f"bad ML reply: {exc}"[:200]
            else:
                self.last_error = str(payload)[:200]
        self._recompute()   # base headway may have changed with the period

        self._accum_s += dt
        if self._accum_s < ACT_INTERVAL_S:
            return
        self._accum_s = 0.0
        snapshot = self.build_snapshot(simulation, line)
        now = time.monotonic()
        # Staleness of network answers is a wall-clock matter (at 20x sim speed a 0.3 s round
        # trip is 6 sim-seconds; measuring in sim time would discard every answer).
        ml_fresh = self.network_enabled and (now - self._last_ml_wall) <= STALE_AFTER_WALL_S
        if not ml_fresh:
            self._fallback_act(snapshot)
        if self.network_enabled and now - self._last_send_wall >= MIN_SEND_WALL_S:
            with self._lock:
                busy = self._inflight
                if not busy:
                    self._inflight = True
            if not busy:
                self._last_send_wall = now
                threading.Thread(target=self._worker, args=(snapshot, self.mode), daemon=True).start()


live_dispatch = LiveDispatchBridge()
