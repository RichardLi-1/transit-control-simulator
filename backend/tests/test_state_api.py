"""/topology and /state contract fields (v2, additive) and snapshot consistency."""

from __future__ import annotations

from fastapi.testclient import TestClient

import main
from route_geom import ROUTE_LEN_M
from sim import DT
from simhelpers import make_sim

client = TestClient(main.app)

TRAIN_FIELDS_V1 = ("train_id", "label", "edge_id", "offset", "speed", "state", "station_name",
                   "dwell_remaining_sec", "safe_zone_front", "safe_zone_rear", "atp_slack_m",
                   "authority_eoa_m", "fleet", "passengers", "passenger_capacity", "load_pct",
                   "dispatch_hold", "dispatch_express", "dispatch_skip_remaining")
TRAIN_FIELDS_V2 = ("chainage_m", "length_m", "accel_mps2", "stop_reason", "next_station_name",
                   "destination", "gap_to_leader_m")


def test_topology_contract():
    doc = client.get("/topology").json()
    for k in ("nodes", "edges", "switches", "crossovers", "signals", "bounds",
              "route", "stations", "speed_restrictions", "yards"):
        assert k in doc
    assert all("length_m" in e and "length" in e for e in doc["edges"])
    assert doc["route"]["segments"][0] == {"edge_id": "ob_0_1", "start_m": 0.0,
                                           "length_m": doc["route"]["segments"][0]["length_m"]}
    assert all("chainage_m" in s for s in doc["signals"])


def test_state_contract():
    st = client.get("/state").json()
    for k in ("trains", "blocks", "switches", "signals", "ops", "sim_time_s", "timestamp",
              "sim_speed", "paused", "step_s"):
        assert k in st
    assert st["step_s"] == DT
    assert st["ops"]["service"]["period"]
    sig_ids = {s["id"] for s in main.topology.YUS_TOPOLOGY["signals"]}
    assert {s["signal_id"] for s in st["signals"]} == sig_ids
    for t in st["trains"]:
        for f in TRAIN_FIELDS_V1 + TRAIN_FIELDS_V2:
            assert f in t, f
        assert t["state"] in ("running", "arriving", "dwelling", "stopped")
        assert t["stop_reason"] in (None, "train_ahead", "signal", "emergency_brake",
                                    "dispatcher_hold", "turnback")
        assert t["destination"] in ("Finch", "Vaughan MC", "Wilson Yard")
        assert 0.0 <= t["chainage_m"] < ROUTE_LEN_M
        assert t["length_m"] == 138.0
        assert 0.0 <= t["authority_eoa_m"] < ROUTE_LEN_M
        if t["state"] == "dwelling":
            assert t["station_name"]
        else:
            assert t["station_name"] is None
        assert t["speed"] >= 0.0


def test_published_speed_is_the_integrated_physical_speed():
    s, line = make_sim(seed=21)
    s.run(30)
    prev = {t.run_number: (t.chainage_front_m, s.train_payload(t)["speed"]) for t in line.trains}
    s.step(DT)
    for t in line.trains:
        if t.run_number not in prev:
            continue
        c0, v0 = prev[t.run_number]
        v1 = s.train_payload(t)["speed"]
        moved = (t.chainage_front_m - c0) % ROUTE_LEN_M
        if t.v > 0 and v0 > 0:
            assert abs(moved - 0.5 * (v0 + v1) * DT) < 1e-6


def test_snapshot_is_consistent_under_concurrent_stepping():
    import threading
    s, line = make_sim(seed=22)
    stop = threading.Event()

    def stepper():
        while not stop.is_set():
            with s.lock:
                s.step(DT)

    th = threading.Thread(target=stepper)
    th.start()
    try:
        for _ in range(20):
            with s.lock:
                snap = s.snapshot()
            ids = [t["train_id"] for t in snap["trains"]]
            assert len(ids) == len(set(ids))
            assert snap["ops"]["service"]["trains_in_service"] == len(ids)
    finally:
        stop.set()
        th.join()


def test_deterministic_per_seed_and_seed_varies_dwell():
    a, la = make_sim(seed=31)
    b, lb = make_sim(seed=31)
    c, lc = make_sim(seed=32)
    for s in (a, b, c):
        s.run(600)
    sig = lambda line: [(t.run_number, round(t.chainage_front_m, 6)) for t in line.trains]
    assert sig(la) == sig(lb)
    assert sig(la) != sig(lc)
