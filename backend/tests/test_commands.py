"""Manual command API."""

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client():
    return TestClient(main.app)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_switch_command(client):
    r = client.post("/commands/switch/sw_start", json={"state": "reverse"})
    assert r.status_code == 200
    assert r.json()["state"] == "reverse"
    assert client.post("/commands/switch/nope", json={"state": "reverse"}).status_code == 404
    assert client.post("/commands/switch/sw_start", json={"state": "sideways"}).status_code == 400


def test_signal_command(client):
    sig_id = main.topology.YUS_TOPOLOGY["signals"][0]["id"]
    r = client.post(f"/commands/signal/{sig_id}", json={"aspect": "red"})
    assert r.status_code == 200
    assert r.json()["aspect"] == "red"
    assert client.post(f"/commands/signal/{sig_id}", json={"aspect": "auto"}).status_code == 200
    assert client.post("/commands/signal/sig_nope", json={"aspect": "red"}).status_code == 404


def test_train_command(client):
    tid = main.train.lines[0].trains[0].train_id
    assert client.post(f"/commands/train/{tid}", json={"action": "skip", "count": 2}).status_code == 200
    assert client.post(f"/commands/train/{tid}", json={"action": "release"}).status_code == 200
    assert client.post("/commands/train/T999", json={"action": "hold"}).status_code == 404


def test_sim_control(client):
    r = client.post("/sim/control", json={"action": "pause", "speed": 4})
    assert r.json() == {"ok": True, "paused": True, "speed": 4.0}
    r = client.post("/sim/control", json={"action": "resume", "speed": 1})
    assert r.json()["paused"] is False
    assert client.post("/sim/control", json={"speed": 0}).status_code == 400
