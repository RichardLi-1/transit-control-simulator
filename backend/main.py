"""FastAPI surface: topology + live sim state + manual commands.

The simulation runs on a background thread started with the app (not at import, so tests and
tools can import this module without a racing sim).  Every endpoint that reads or mutates sim
state holds ``simulation.lock``, so /state is a consistent snapshot.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import commands as cmd_api
import topology
import train
from dispatch_live import live_dispatch
from events import registry as event_registry
from sim import DT, simulation

MAX_STEPS_PER_WAKE = 200        # bound lock hold / catch-up work per loop iteration
MAX_BACKLOG_WALL_S = 1.0        # if we fall further behind than this, drop the backlog
SPEED_MIN, SPEED_MAX = 0.1, 20.0  # public endpoint: any visitor can set it
STALL_AFTER_S = 10.0            # /health: no step for this long while running → unhealthy

log = logging.getLogger("cbtc.main")

_stop = threading.Event()
_thread: threading.Thread | None = None
_loop_state = {"last_step_wall": None, "errors": 0, "last_error": None, "started": False}


def _sim_loop() -> None:
    """Drift-free real-time loop: sim time tracks wall time × speed (anchored, so compute time
    and sleep jitter don't accumulate).  Re-anchors on pause/resume/speed change, and drops
    backlog if the host can't keep up."""
    anchor_wall = time.monotonic()
    anchor_sim = simulation._sim_time_s
    last_speed = simulation.speed
    was_paused = simulation.paused
    while not _stop.is_set():
        speed = float(simulation.speed)
        if not math.isfinite(speed) or speed <= 0:
            speed = simulation.speed = 1.0
        paused = simulation.paused
        if paused or speed != last_speed or paused != was_paused:
            anchor_wall = time.monotonic()
            anchor_sim = simulation._sim_time_s
            last_speed, was_paused = speed, paused
            if paused:
                time.sleep(0.05)
                continue
        target = anchor_sim + (time.monotonic() - anchor_wall) * speed
        n = 0
        while simulation._sim_time_s + DT * 0.5 <= target and n < MAX_STEPS_PER_WAKE:
            try:
                with simulation.lock:
                    simulation.step(DT)
                _loop_state["last_step_wall"] = time.monotonic()
            except Exception as exc:     # one bad tick must never kill the sim thread
                _loop_state["errors"] += 1
                _loop_state["last_error"] = f"{type(exc).__name__}: {exc}"[:300]
                log.exception("sim step failed (continuing)")
                time.sleep(0.05)
                break
            n += 1
        behind = target - simulation._sim_time_s
        if behind > MAX_BACKLOG_WALL_S * speed:
            anchor_wall = time.monotonic()
            anchor_sim = simulation._sim_time_s
            behind = 0.0
        # Sleep until the next step is due.
        wait = (simulation._sim_time_s + DT - target) / speed
        time.sleep(min(max(wait, 0.001), 0.1))


def start_sim_thread() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _loop_state["started"] = True
    _loop_state["last_step_wall"] = time.monotonic()
    _thread = threading.Thread(target=_sim_loop, name="sim-loop", daemon=True)
    _thread.start()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("SIM_AUTOSTART", "1") not in ("0", "false", "no"):
        start_sim_thread()
    yield
    _stop.set()


app = FastAPI(lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def _validation_error(_request, exc: RequestValidationError):
    """422 with the offending input sanitised: the default handler echoes the input back and
    crashes (500) when it is NaN / Infinity, which are not valid JSON."""
    return JSONResponse(status_code=422, content={"detail": train._json_safe(jsonable_encoder_safe(exc.errors()))})


def jsonable_encoder_safe(obj):
    if isinstance(obj, dict):
        return {str(k): jsonable_encoder_safe(v) for k, v in obj.items() if k != "ctx"}
    if isinstance(obj, (list, tuple)):
        return [jsonable_encoder_safe(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SwitchCommandBody(BaseModel):
    state: str


class SignalCommandBody(BaseModel):
    aspect: str


class TrainDispatchBody(BaseModel):
    action: str  # hold | express | skip | release
    count: int = 1


class DispatchPolicyBody(BaseModel):
    mode: str  # rule | ppo


class SimControlBody(BaseModel):
    action: Optional[str] = None  # "pause" | "resume"
    # wall-clock multiplier; must be finite (NaN/Infinity → 422); clamped to [0.1, 20]
    speed: Optional[float] = Field(default=None, allow_inf_nan=False)


class InjectEventBody(BaseModel):
    kind: str = Field(max_length=40)
    duration_s: float = Field(default=30.0, ge=0.0, le=86_400.0, allow_inf_nan=False)
    starts_in_s: float = Field(default=0.0, ge=0.0, le=86_400.0, allow_inf_nan=False)
    target_train_id: Optional[str] = Field(default=None, max_length=16)
    target_signal_id: Optional[str] = Field(default=None, max_length=64)
    target_switch_id: Optional[str] = Field(default=None, max_length=64)
    speed_limit_kph: Optional[float] = Field(default=None, ge=0.0, le=88.0, allow_inf_nan=False)
    note: str = Field(default="", max_length=200)


@app.get("/health")
def health():
    """Liveness of the API *and* the sim thread.  503 if the thread was started but died or
    has stopped stepping while not paused."""
    alive = _thread is not None and _thread.is_alive()
    last = _loop_state["last_step_wall"]
    age = None if last is None else round(time.monotonic() - last, 2)
    started = _loop_state["started"]
    healthy = (not started) or (alive and (simulation.paused or age is None or age < STALL_AFTER_S))
    body = {
        "ok": healthy,
        "lines": len(train.lines),
        "sim_thread_started": started,
        "sim_thread_alive": alive,
        "sim_time_s": simulation._sim_time_s,
        "last_step_age_s": age,
        "paused": simulation.paused,
        "speed": simulation.speed,
        "step_errors": _loop_state["errors"] + simulation.step_errors,
        "last_error": _loop_state["last_error"],
    }
    return JSONResponse(body, status_code=200 if healthy else 503)


@app.get("/topology")
def get_topology():
    return topology.get_topology_document("YUS")


@app.get("/sim")
def get_sim():
    """Read simulation lifecycle: paused flag, speed multiplier, sim clock."""
    return {
        "paused": simulation.paused,
        "speed": simulation.speed,
        "sim_time_s": simulation._sim_time_s,
        "step_s": DT,
    }


@app.post("/sim/control")
def post_sim_control(body: SimControlBody):
    """Drive the simulation: pause, resume, or change the speed multiplier."""
    if body.action is not None:
        if body.action == "pause":
            simulation.paused = True
        elif body.action == "resume":
            simulation.paused = False
        else:
            raise HTTPException(status_code=400, detail="action must be 'pause' or 'resume'")
    if body.speed is not None:
        if not math.isfinite(body.speed) or body.speed <= 0:
            raise HTTPException(status_code=400, detail="speed must be a finite number > 0")
        simulation.speed = float(min(max(body.speed, SPEED_MIN), SPEED_MAX))
    with simulation.lock:
        simulation.touch()
    return {"ok": True, "paused": simulation.paused, "speed": simulation.speed}


@app.post("/ops/dispatch/policy")
def post_dispatch_policy(body: DispatchPolicyBody):
    try:
        status = live_dispatch.set_mode(body.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"ok": True, **status}


@app.get("/ops/dispatch/policy")
def get_dispatch_policy():
    return live_dispatch.status_payload()


@app.post("/commands/switch/{switch_id}")
def post_switch_command(switch_id: str, body: SwitchCommandBody):
    try:
        with simulation.lock:
            cmd_api.set_switch(switch_id, body.state)
            simulation.touch()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "switch_id": switch_id, "state": body.state}


@app.post("/events/inject")
def post_inject_event(body: InjectEventBody):
    try:
        with simulation.lock:
            inc = event_registry.inject(
                lines=train.lines,
                kind=body.kind,
                sim_time_s=simulation._sim_time_s,
                duration_s=body.duration_s,
                starts_in_s=body.starts_in_s,
                target_train_id=body.target_train_id,
                target_signal_id=body.target_signal_id,
                target_switch_id=body.target_switch_id,
                speed_limit_kph=body.speed_limit_kph,
                note=body.note,
                source="manual",
            )
            simulation.touch()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "event": {
            "id": inc.id,
            "kind": inc.kind,
            "target_train_id": inc.target_train_id,
            "target_signal_id": inc.target_signal_id,
            "duration_s": inc.duration_s,
            "remaining_s": inc.remaining_s,
            "starts_in_s": inc.starts_in_s,
            "active": inc.active,
        },
    }


@app.delete("/events/{event_id}")
def delete_event(event_id: str):
    try:
        with simulation.lock:
            event_registry.cancel(event_id, lines=train.lines, sim_time_s=simulation._sim_time_s)
            simulation.touch()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/commands/train/{train_id}")
def post_train_command(train_id: str, body: TrainDispatchBody):
    try:
        with simulation.lock:
            cmd_api.set_train_dispatch(train_id, body.action, body.count)
            simulation.touch()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "train_id": train_id, "action": body.action, "count": body.count}


@app.post("/commands/signal/{signal_id}")
def post_signal_command(signal_id: str, body: SignalCommandBody):
    try:
        with simulation.lock:
            cmd_api.set_signal(signal_id, body.aspect)
            simulation.touch()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "signal_id": signal_id, "aspect": body.aspect}


def get_state() -> dict:
    """/state payload as a dict (tests / tools)."""
    with simulation.lock:
        payload = simulation.snapshot()
    payload["timestamp"] = time.time()
    return payload


@app.get("/state")
def get_state_http() -> Response:
    """Polled by every visitor at ~5 Hz: the body is encoded once per sim step (cached bytes),
    only the wall-clock timestamp is appended per request."""
    with simulation.lock:
        body = simulation.snapshot_json()
    body = body[:-1] + b',"timestamp":' + repr(time.time()).encode() + b"}"
    return Response(content=body, media_type="application/json")
