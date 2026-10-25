"""GET /state includes headway dispatch telemetry and the service plan."""

import main
from sim import DT
from simhelpers import make_sim


def test_state_includes_dispatch_and_service_ops():
    payload = main.get_state()
    ops = payload["ops"]
    d = ops["dispatch"]
    for k in ("count", "next_due_in_s", "blocked", "max_trains", "target_headway_sec",
              "policy_mode", "effective_headway_sec", "effective_dwell_sec"):
        assert k in d
    svc = ops["service"]
    for k in ("trains_in_service", "target_headway_s", "mean_headway_s", "period"):
        assert k in svc
    assert svc["period"] == "AM peak"            # sim starts at 06:00
    assert svc["trains_in_service"] == len(payload["trains"])


def test_dispatch_count_and_headway_stats_progress():
    s, line = make_sim(seed=5)
    n0 = len(line.trains)
    s.run(900)
    assert s.mean_headway_s() is not None
    assert len(line.trains) >= n0                   # bias may add trains from the yard
    st = s.dispatch_status(line)
    assert st["count"] == s._dispatch_count
