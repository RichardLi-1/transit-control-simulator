"""Onboard ATP: emergency brake on an EOA overrun risk or overspeed; never in normal running."""

from ma_constants import ATP_REACTION_S, GEBR_MPS2
from train import Train, atp_stopping_distance_m, traction_limit_mps2


def test_stopping_distance_model():
    v = 20.0
    d = atp_stopping_distance_m(v, 0.0)
    assert abs(d - (v * ATP_REACTION_S + v * v / (2 * GEBR_MPS2))) < 1e-9
    assert atp_stopping_distance_m(v, 0.8) > d      # still accelerating during reaction time


def test_atp_trips_when_eoa_too_close():
    t = Train(chainage_front_m=1000.0)
    t.v = 20.0
    t.eoa_dist_m = atp_stopping_distance_m(20.0, 0.0) - 5.0
    t.atp_supervise(0.2)
    assert t.atp_eb and t.atp_trips == 1 and t.atp_last_reason == "eoa"
    # EB decelerates at the EB rate and resets after standstill.
    for _ in range(200):
        t.integrate(0.2)
        t.atp_supervise(0.2)
    assert t.v == 0.0 and not t.atp_eb


def test_atp_quiet_with_room():
    t = Train(chainage_front_m=1000.0)
    t.v = 20.0
    t.eoa_dist_m = atp_stopping_distance_m(20.0, 0.0) + 50.0
    t.atp_supervise(0.2)
    assert not t.atp_eb
    assert t.atp_slack_m > 0


def test_atp_overspeed():
    t = Train(chainage_front_m=1000.0)
    t.v = 90.0 / 3.6     # line speed is 80
    t.eoa_dist_m = 10_000.0
    t.atp_supervise(0.2)
    assert t.atp_eb and t.atp_last_reason == "overspeed"


def test_traction_curve_falls_off_with_speed():
    kph = [0, 20, 35, 50, 60, 70, 80, 87]
    a = [traction_limit_mps2(k / 3.6) for k in kph]
    assert all(x > y for x, y in zip(a, a[1:]))
    assert 1.0 < a[0] <= 1.05                   # constant-torque start, less resistance
    assert 0.65 < a[3] < 0.75                   # ~0.7 m/s² at 50 km/h
    assert 0.40 < a[4] < 0.50                   # natural characteristic + resistance above 50
    assert 0.18 < a[6] < 0.26                   # little left near line speed
    assert traction_limit_mps2(25.0) == 0.0     # above 88 km/h design max


def test_zero_to_line_speed_takes_realistic_time():
    """Full traction from rest, ignoring jerk: 0→50 km/h ≈ 15 s, 0→80 km/h ≈ 35–45 s."""
    v, t, t50 = 0.0, 0.0, None
    while v < 80 / 3.6:
        v += traction_limit_mps2(v) * 0.05
        t += 0.05
        if t50 is None and v >= 50 / 3.6:
            t50 = t
    assert 12.0 < t50 < 18.0
    assert 35.0 < t < 45.0
