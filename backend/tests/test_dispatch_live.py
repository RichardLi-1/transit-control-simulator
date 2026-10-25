"""Live dispatch bridge: snapshot shape, policy endpoints, ML-down resilience."""

import time

import dispatch_live
import train
from dispatch_live import LiveDispatchBridge, live_dispatch
from main import get_dispatch_policy, get_state, post_dispatch_policy
from sim import DT, simulation
from simhelpers import make_sim


def test_build_snapshot_from_sim():
    line = train.lines[0]
    snap = LiveDispatchBridge.build_snapshot(simulation, line)
    assert snap["trains"] and snap["route_len_m"] > 70_000
    t0 = snap["trains"][0]
    assert set(t0) == {"chainage_front_m", "speed_kph", "atp_slack_m", "acceleration_level"}


def test_dispatch_policy_handlers():
    body = get_dispatch_policy()
    assert body["policy_mode"] in ("rule", "ppo")
    out = post_dispatch_policy(type("B", (), {"mode": "rule"})())
    assert out["ok"] is True
    assert out["policy_mode"] == "rule"


def test_state_includes_live_dispatch_fields():
    payload = get_state()
    dispatch = payload["ops"]["dispatch"]
    assert dispatch["policy_mode"] in ("rule", "ppo")
    assert "effective_headway_sec" in dispatch
    assert live_dispatch.effective_headway_sec >= 60.0


def test_ml_service_down_never_breaks_the_sim(monkeypatch):
    """Point the bridge at a closed port with networking ON: the sim keeps stepping at full
    speed (calls are off-thread), errors are recorded and the rule fallback drives the bias."""
    monkeypatch.setattr(dispatch_live, "ML_API_BASE", "http://127.0.0.1:9")
    s, line = make_sim(seed=9)
    bridge = s.dispatch
    bridge.network_enabled = True
    t0 = time.time()
    s.run(60)
    assert time.time() - t0 < 10.0
    for _ in range(50):              # let the worker thread report back
        if bridge.last_error:
            break
        time.sleep(0.05)
        s.step(DT)
    assert bridge.last_error
    assert bridge.source == "fallback"
    assert bridge.effective_headway_sec >= 60.0
    assert s.atp_trip_count() == 0


def test_ml_result_applies_bias(monkeypatch):
    bridge = LiveDispatchBridge()
    bridge.base_headway_sec = 150.0
    bridge._apply_act_result({"headway_bias_sec": 12.0, "dwell_bias_sec": 3.0, "policy_ready": True})
    assert bridge.effective_headway_sec == 162.0
    assert bridge.dwell_bias_sec == 3.0 and bridge.source == "ml"
