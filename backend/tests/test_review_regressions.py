"""Regression tests for the adversarial backend review (one block per finding).

Repro scripts: scratchpad/review-backend/*.py.  Each test fails on the pre-fix code.
"""

from __future__ import annotations

import json
import math
import time

import pytest
from fastapi.testclient import TestClient

import commands
import dispatch_live
import main
import topology
import train as trainmod
from dispatch_live import LiveDispatchBridge
from events import EventRegistry, InjectedIncident, registry
from route_geom import ROUTE_LEN_M
from sim import DT, SPAWN_CHAINAGE_M, Simulation, _wrap_round
from stations import PLATFORMS, platform_by
from simhelpers import lone_train_sim, make_sim

client = TestClient(main.app, raise_server_exceptions=False)
_L = ROUTE_LEN_M


def _strict_json(body: bytes):
    def bad(c):
        raise ValueError(f"non-JSON constant {c}")
    return json.loads(body, parse_constant=bad)


# ── 1. a bad incident / ML reply / step can't kill the sim ──────────────────
@pytest.mark.parametrize("starts_in", [0, 1])
def test_signal_fail_with_unknown_signal_is_rejected_before_storing(starts_in):
    r = client.post("/events/inject", json={"kind": "signal_fail", "target_signal_id": "sig_ob_3_4_1",
                                            "duration_s": 30, "starts_in_s": starts_in})
    assert r.status_code == 400
    assert registry._incidents == {}
    r = client.post("/events/inject", json={"kind": "emergency_brake", "target_train_id": "T999", "duration_s": 5})
    assert r.status_code == 400
    r = client.post("/events/inject", json={"kind": "station_hold", "duration_s": 5})   # no target
    assert r.status_code == 400


def test_a_broken_incident_is_dropped_not_fatal():
    s, line = make_sim(seed=41)
    # Smuggle an invalid incident past validation (as the old code allowed).
    registry._incidents["evt_bad"] = InjectedIncident(id="evt_bad", kind="signal_fail", duration_s=30,
                                                      remaining_s=30, starts_in_s=0.4,
                                                      target_signal_id="bogus")
    s.run(5)                                   # must not raise
    assert "evt_bad" not in registry._incidents
    assert any("dropped" in r["message"] for r in registry.recent_log())


@pytest.mark.parametrize("reply", [
    {"headway_bias_sec": None}, {"headway_bias_sec": float("nan")}, {"dwell_bias_sec": "x"},
    {"headway_bias_sec": float("inf")}, ["not", "a", "dict"],
])
def test_malformed_ml_reply_never_raises(reply):
    s, line = make_sim(seed=42)
    bridge = s.dispatch
    bridge.headway_bias_sec = 7.0
    bridge._recompute()
    with bridge._lock:
        bridge._pending = ("ok", reply)
    s.step(DT)                                  # must not raise
    assert bridge.last_error and "bad ML reply" in bridge.last_error
    assert math.isfinite(bridge.effective_headway_sec) and bridge.effective_headway_sec >= 60.0
    assert s.step_errors == 0


def test_sim_thread_survives_a_failing_step_and_health_reports_it(monkeypatch):
    sim = main.simulation
    real_step = sim.step
    calls = {"n": 0}

    def flaky(dt=DT):
        calls["n"] += 1
        if calls["n"] == 3:
            raise RuntimeError("boom")
        return real_step(dt)

    monkeypatch.setattr(sim, "step", flaky)
    sim.speed = 20.0
    sim.paused = False
    main._loop_state.update(errors=0, last_error=None)
    main.start_sim_thread()
    try:
        t0 = sim._sim_time_s
        deadline = time.time() + 5.0
        while sim._sim_time_s - t0 < 10.0 and time.time() < deadline:
            time.sleep(0.05)
        assert main._thread.is_alive()
        assert sim._sim_time_s - t0 >= 10.0          # kept stepping after the exception
        h = client.get("/health")
        body = h.json()
        assert h.status_code == 200 and body["ok"] is True
        assert body["sim_thread_alive"] is True and body["step_errors"] >= 1
        assert "boom" in body["last_error"]
        assert body["sim_time_s"] > t0
    finally:
        main._stop.set()
        main._thread.join(timeout=2.0)
        main._loop_state["started"] = False
        sim.speed = 1.0


# ── 2. /sim/control must reject non-finite and clamp speed ──────────────────
def test_sim_control_rejects_nan_and_clamps_speed():
    sim = main.simulation
    r = client.post("/sim/control", content=b'{"speed": NaN}', headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert client.post("/sim/control", content=b'{"speed": Infinity}',
                       headers={"content-type": "application/json"}).status_code == 422
    assert math.isfinite(sim.speed)
    assert client.post("/sim/control", json={"speed": 1000}).json()["speed"] == 20.0
    assert client.post("/sim/control", json={"speed": 0.001}).json()["speed"] == 0.1
    assert client.post("/sim/control", json={"speed": -1}).status_code == 400
    client.post("/sim/control", json={"speed": 1})
    assert client.get("/state").status_code == 200


# ── 3. non-finite event fields; snapshot can't emit NaN ─────────────────────
def test_non_finite_event_fields_rejected():
    tid = trainmod.lines[0].trains[0].train_id
    for raw in (b'{"kind":"station_hold","target_train_id":"%s","duration_s":1e999}' % tid.encode(),
                b'{"kind":"slow_speed","target_train_id":"%s","duration_s":30,"speed_limit_kph":Infinity}' % tid.encode()):
        r = client.post("/events/inject", content=raw, headers={"content-type": "application/json"})
        assert r.status_code == 422
    assert registry._incidents == {}
    reg = EventRegistry()
    with pytest.raises(ValueError):
        reg.inject(lines=trainmod.lines, kind="slow_speed", sim_time_s=0, duration_s=10,
                   target_train_id=tid, speed_limit_kph=float("nan"))
    with pytest.raises(ValueError):
        reg.inject(lines=trainmod.lines, kind="door_fault", sim_time_s=0, duration_s=float("inf"),
                   target_train_id=tid)
    assert client.get("/state").status_code == 200


def test_snapshot_json_never_emits_nan():
    s, line = make_sim(seed=43)
    s.step(DT)
    line.trains[0].gap_to_leader_m = float("nan")
    line.trains[1].atp_slack_m = float("-inf")
    s.touch()
    body = s.snapshot_json()
    data = _strict_json(body)
    assert data["trains"][0]["gap_to_leader_m"] is None


# ── 4. injected incidents stay visible in ops.event_log ─────────────────────
def test_event_log_merges_before_slicing():
    s, line = make_sim(seed=44)
    for i in range(50):
        s.event_log_extra.appendleft({"severity": "info", "kind": "SIM", "message": f"yard move {i}",
                                      "source": "sim", "sim_t": float(i)})
    s._sim_time_us = 100 * 10**6
    s._sim_time_s = 100.0
    registry.inject(lines=s.lines, kind="station_hold", sim_time_s=100.0, duration_s=60,
                    target_train_id=line.trains[0].train_id)
    log = s.snapshot()["ops"]["event_log"]
    assert len(log) == 50
    assert any("station_hold" in r["message"] for r in log)
    assert [r["sim_t"] for r in log] == sorted((r["sim_t"] for r in log), reverse=True)


# ── 5. emergency_brake_release overrides an active emergency_brake ─────────
def test_emergency_brake_release_ends_active_eb():
    s, line, tr = lone_train_sim(30_500.0, v_mps=20.0)
    registry.inject(lines=s.lines, kind="emergency_brake", sim_time_s=0.0, duration_s=30.0,
                    target_train_id=tr.train_id)
    s.run(10)
    assert tr.e_brake
    registry.inject(lines=s.lines, kind="emergency_brake_release", sim_time_s=s._sim_time_s,
                    duration_s=5.0, target_train_id=tr.train_id)
    s.run(1)
    assert not tr.e_brake
    assert not any(i.kind == "emergency_brake" for i in registry._incidents.values())
    v1 = tr.v
    s.run(8)
    assert not tr.e_brake and tr.v > v1             # driving again, not re-braked every tick


# ── 6. event ids never collide ──────────────────────────────────────────────
def test_event_ids_unique_and_duplicates_rejected():
    lines = trainmod.lines
    t1, t2, t3 = (lines[0].trains[i].train_id for i in range(3))
    a = registry.inject(lines=lines, kind="emergency_brake", sim_time_s=5.0, duration_s=30, target_train_id=t1)
    b = registry.inject(lines=lines, kind="emergency_brake", sim_time_s=5.0, duration_s=30, target_train_id=t2)
    registry.cancel(a.id, lines=lines, sim_time_s=5.0)
    c = registry.inject(lines=lines, kind="station_hold", sim_time_s=5.0, duration_s=30, target_train_id=t3)
    assert len({a.id, b.id, c.id}) == 3
    assert registry._incidents[b.id].kind == "emergency_brake"      # not overwritten
    with pytest.raises(ValueError):
        registry.inject(lines=lines, kind="station_hold", sim_time_s=5.0, duration_s=30,
                        target_train_id=t3, event_id=c.id)
    for i in list(registry._incidents):
        registry.cancel(i, lines=lines, sim_time_s=5.0)
    assert not any(t.e_brake for t in lines[0].trains[:3])


# ── 7. memory stays bounded ─────────────────────────────────────────────────
def test_history_is_bounded(monkeypatch):
    log = trainmod.BoundedLog(3)
    for i in range(10):
        log.append(i)
    assert log == [7, 8, 9] and log[-2:] == [8, 9]
    monkeypatch.setattr(trainmod, "TRAIN_LOG_MAXLEN", 4)
    s, line = make_sim(seed=45, start_clock_s=8.95 * 3600)
    s.run(45 * 60)
    for tr in line.trains + list(s.removed_trains):
        assert len(tr.berth_log) <= 4 and len(tr.depart_log) <= 4 and len(tr.pass_log) <= 4
    assert s.removed_trains.maxlen <= 64 and s.missed_stops.maxlen <= 500
    assert all(tr.berth_count >= len(tr.berth_log) for tr in line.trains)
    assert s._withdraw_count >= 1                       # withdrawn trains don't lose their ATP count
    assert s.atp_trip_count() == 0


# ── 8. releasing express/skip too close to a platform → pass it cleanly ────
@pytest.mark.parametrize("dist,berths", [(400, True), (300, True), (200, False), (60, False)])
def test_express_release_near_platform(dist, berths):
    p = platform_by("Lawrence", "ob")
    s, line, tr = lone_train_sim(p.chainage_m - 1500, v_mps=0.0)
    tr._op_express = True
    tr.stop_idx = p.ring_index
    while (p.chainage_m - tr.chainage_front_m) % _L > dist:
        s.step(DT)
    tr._op_express = False                     # operator "release"
    worst = 0.0
    for _ in range(int(90 / DT)):
        s.step(DT)
        worst = max(worst, -tr.a)
        if tr.berth_log or tr.pass_log:
            break
    assert len(s.missed_stops) == 0 and tr.atp_trips == 0
    assert worst <= 1.0
    if berths:
        assert tr.berth_log and tr.berth_log[-1][1] == p.ring_index
    else:
        assert tr.pass_log[-1][1:] == (p.ring_index, "late_release")
        s.run(240)                              # and it stops normally at the next one
        assert tr.berth_log and PLATFORMS[tr.berth_log[-1][1]].name in ("York Mills", "Sheppard–Yonge")


# ── 9. a train standing at a terminal departure platform is dispatched ─────
@pytest.mark.parametrize("offset", [0.0, 5.0])
def test_train_standing_on_departure_platform_is_dispatched(offset):
    s, line, tr = lone_train_sim(PLATFORMS[0].chainage_m + offset)
    s.run(180)
    assert tr.stationary_s < 60.0
    assert any(k == 1 for (_t, k, _e) in tr.berth_log), "should have reached Highway 407"


# ── 10. no insertion into an occupied / tight gap ───────────────────────────
def test_gap_check_sees_overlapping_bodies():
    s = Simulation(lines=[trainmod.Line("YUS", [])], populate=False, use_dispatch=False)
    j = SPAWN_CHAINAGE_M
    blocker = trainmod.Train(chainage_front_m=j + 60.0, run_number=0)      # body over the spawn body
    assert s._gap_for_insertion([blocker], j) is False
    far = trainmod.Train(chainage_front_m=(j + 20_000.0) % _L, run_number=1)
    assert s._gap_for_insertion([far], j) is True


def test_no_insertion_into_a_tight_gap_with_control():
    j = SPAWN_CHAINAGE_M

    def run(with_blocker: bool):
        trains = []
        if with_blocker:
            b = trainmod.Train(chainage_front_m=j + 60.0, run_number=0)
            b.e_brake = True
            trains.append(b)
        else:
            trains.append(trainmod.Train(chainage_front_m=(j + 30_000.0) % _L, run_number=0))
        line = trainmod.Line("YUS", trains)
        s = Simulation(lines=[line], populate=False, use_dispatch=False)
        s.run(120)
        return s, [r["message"] for r in s.event_log_extra if "from Wilson Yard" in r["message"]]

    _s, wilson = run(False)
    assert wilson, "control: with a clear lead, Wilson Yard inserts"
    s, wilson = run(True)
    assert wilson == []
    # And no two bodies ever overlap.
    trs = sorted(s.lines[0].trains, key=lambda t: t.chainage_front_m)
    for a, b in zip(trs, trs[1:] + trs[:1]):
        if a is not b:
            assert (b.chainage_front_m - b.length_m - a.chainage_front_m) % _L > 0


# ── 11. /state body encoded once per step, timestamp per request ────────────
def test_state_bytes_cached_and_invalidated_by_commands():
    sim = main.simulation
    r1 = client.get("/state")
    r2 = client.get("/state")
    assert r1.headers["content-type"].startswith("application/json")
    d1, d2 = _strict_json(r1.content), _strict_json(r2.content)
    assert d1["sim_time_s"] == d2["sim_time_s"] and "timestamp" in d1
    d1.pop("timestamp"), d2.pop("timestamp")
    assert d1 == d2
    tid = d1["trains"][0]["train_id"]
    client.post(f"/commands/train/{tid}", json={"action": "hold"})
    d3 = _strict_json(client.get("/state").content)
    assert next(t for t in d3["trains"] if t["train_id"] == tid)["dispatch_hold"] is True
    client.post(f"/commands/train/{tid}", json={"action": "release"})


# ── 12. block occupancy covers the whole body ───────────────────────────────
def test_block_occupancy_covers_short_crossover():
    c = topology.SEG_START["ib_37_36"] + 40.0       # body spans ob_36_37 → xover_end → ib_37_36
    s, line, tr = lone_train_sim(c)
    occ = {b["block_id"] for b in s.snapshot()["blocks"] if b["occupancy"] == "occupied"}
    assert {"OB_B37", "XOVER_XOVER_END", "IB_B37"} <= occ


# ── 13. ML staleness is measured in wall time ───────────────────────────────
def test_ml_answer_not_discarded_at_high_sim_speed(monkeypatch):
    monkeypatch.setattr(dispatch_live, "ML_API_BASE", "http://127.0.0.1:9")
    s, line = make_sim(seed=46)
    bridge = s.dispatch
    bridge.network_enabled = True
    bridge._apply_act_result({"headway_bias_sec": 12.0, "dwell_bias_sec": 0.0})
    s.run(60)                    # 60 sim-s in well under STALE_AFTER_WALL_S of wall time
    assert bridge.source == "ml" and bridge.headway_bias_sec == 12.0


# ── 14. override side effects ───────────────────────────────────────────────
def test_override_side_effects():
    sig = next(x for x in topology.SIGNALS if x["kind"] == "home")
    commands.set_signal(sig["id"], "green")
    assert sig["aspect"] == "green"
    commands.set_signal(sig["id"], "auto")
    assert sig["aspect"] == "red" and sig["id"] not in commands._signal_overrides
    # A signal failure restores the operator's earlier override when it clears.
    commands.set_signal(sig["id"], "green")
    reg = EventRegistry()
    reg.inject(lines=trainmod.lines, kind="signal_fail", sim_time_s=0.0, duration_s=1.0,
               target_signal_id=sig["id"])
    assert commands._signal_overrides[sig["id"]] == "red"
    reg.tick(trainmod.lines, 1.0, 1.0)
    assert commands._signal_overrides[sig["id"]] == "green"
    # Yard exits can't be called on.
    yx = next(x for x in topology.SIGNALS if x["kind"] == "yard_exit")
    assert client.post(f"/commands/signal/{yx['id']}", json={"aspect": "green"}).status_code == 400
    assert client.post(f"/commands/signal/{yx['id']}", json={"aspect": "red"}).status_code == 200


# ── 15. rounded chainages stay in [0, L) ────────────────────────────────────
def test_rounded_chainage_wraps():
    assert _wrap_round(_L - 1e-6, 3) == 0.0
    assert _wrap_round(_L - 1e-6, 2) == 0.0
    assert 0.0 <= _wrap_round(12.3456, 3) == 12.346
    s, line, tr = lone_train_sim(_L - 1e-6)
    p = s.train_payload(tr)
    assert 0.0 <= p["chainage_m"] < _L and 0.0 <= p["authority_eoa_m"] < _L


# ── 16. no clock drift ──────────────────────────────────────────────────────
def test_clock_has_no_float_drift():
    s = Simulation(lines=[trainmod.Line("YUS", [])], populate=False, spawning=False, use_dispatch=False)
    for _ in range(100_000):
        s.step(DT)
    assert s._sim_time_s == 20_000.0


# ── 17. service quality across period changes ───────────────────────────────
def test_midday_withdraws_to_target_and_keeps_headway():
    s, line = make_sim(seed=3, start_clock_s=8.85 * 3600)
    s.run(2.75 * 3600)                                   # → ~11:36
    svc = s.service_status(line)
    assert svc["period"] == "Midday"
    assert abs(svc["trains_in_service"] - svc["target_trains"]) <= 1
    assert abs(svc["mean_headway_s"] - svc["target_headway_s"]) <= 0.15 * svc["target_headway_s"]
    assert max(t.stationary_s for t in line.trains) < 150.0


def test_trains_enter_service_ahead_of_the_pm_peak():
    s, line = make_sim(seed=3, start_clock_s=14.0 * 3600)
    pm_target = s._trains_for(165.0 + (s.target_headway_s - s.base_headway_s))
    s.run(60 * 60 - DT)                                  # → 14:59:59.8
    assert s.period_name == "Midday"
    assert s.in_service(line) >= pm_target - 3


# ── 18. a committed train that later slows must respect the signal ──────────
def test_committed_train_that_slows_respects_the_red():
    from interlocking import Interlocking
    from zone_controller import ZoneController
    il = Interlocking(use_overrides=False)
    sig = next(x for x in il.signals if x.kind == "home")
    t = trainmod.Train(chainage_front_m=sig.ch - 50.0, run_number=0)
    t.v = 20.0
    blocker = trainmod.Train(chainage_front_m=sig.ch + sig.span + 50.0, run_number=1)   # keeps it red
    order = sorted([t, blocker], key=lambda x: x.chainage_front_m)
    zc = ZoneController(_L)
    il.update(order, [x.chainage_front_m for x in order])
    zc.update(order, il, order)
    assert sig.id in t._committed_signals and t.eoa_source == "train_ahead"
    t.v = 0.0                                    # e.g. stopped short behind something else
    zc.update(order, il, order)
    assert sig.id not in t._committed_signals
    assert t.eoa_source == "signal" and t.eoa_signal_id == sig.id


# ── 19. a hold cancels a set departure route; release re-requests it ───────
def test_hold_cancels_departure_route_and_release_reregulates():
    dep = platform_by("Finch", "ib", "departure")
    s, line, tr = lone_train_sim(dep.chainage_m)
    starter = next(x for x in s.interlocking.signals if x.role == "terminal_departure" and x.interlocking == "Finch")
    # A leader just beyond the starter's route: the route can be set, but the train can't leave
    # yet (too little authority) — so it stands ready with the route set.
    leader = trainmod.Train(chainage_front_m=starter.ch + starter.span + 5.0 + 138.0, run_number=2)
    leader.e_brake = True
    line.trains.append(leader)
    s._prime()
    for _ in range(int(120 / DT)):
        s.step(DT)
        if starter.locked is tr:
            break
    assert starter.locked is tr and tr.berthed_idx == dep.ring_index and tr.ready_to_depart
    tr._op_hold = True
    s.run(10)
    assert starter.locked is None and s.interlocking.aspects[starter.id] == "red"
    # Release: the route has to be requested again (through departure regulation).
    s._terminal_last_dep["Finch"] = s._sim_time_s          # pretend a train just left
    leader.e_brake = False
    tr._op_hold = False
    s.run(5)
    assert tr.berthed_idx == dep.ring_index, "regulation must hold it after the release"
    s.run(240)
    assert any(k == dep.ring_index for (_t, k) in tr.depart_log)


def test_held_train_at_station_gets_no_starter_route():
    p = platform_by("Spadina", "ob")
    s, line, tr = lone_train_sim(p.chainage_m)
    starter = next(x for x in s.interlocking.signals if x.role == "mid_starter" and x.leg == "ob"
                   and x.interlocking == "Spadina")
    tr._op_hold = True
    s.run(60)
    assert tr.berthed_idx == p.ring_index and s.interlocking.aspects[starter.id] == "red"
    tr._op_hold = False
    s.run(40)
    assert tr.berthed_idx is None


def test_slow_speed_zero_stops_the_train_then_resumes():
    s, line, tr = lone_train_sim(30_500.0, v_mps=15.0)
    registry.inject(lines=s.lines, kind="slow_speed", sim_time_s=0.0, duration_s=60.0,
                    target_train_id=tr.train_id, speed_limit_kph=0.0)
    s.run(45)
    assert tr.v == 0.0 and tr.atp_trips == 0          # holding brake: a genuine standstill
    s.run(40)                                          # restriction expired
    assert tr.v > 1.0
