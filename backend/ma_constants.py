"""Rolling-stock and CBTC control constants.

APPROX: representative figures for a Toronto Rocket (TR) consist under CBTC moving block —
engineering-style values chosen to look and behave plausibly, NOT official TTC / Alstom data.
"""

from __future__ import annotations

KPH_TO_MPS = 1000.0 / 3600.0
MPS_TO_KPH = 3600.0 / 1000.0

# ── Toronto Rocket (6-car, 138 m) ────────────────────────────────────────────
TRAIN_LENGTH_M = 138.0
DESIGN_MAX_KPH = 88.0
LINE_SPEED_KPH = 80.0
TRACTION_MAX_MPS2 = 1.05        # constant-torque region
TRACTION_BASE_KPH = 35.0        # above this, constant power: a = a0 * v_base / v
TRACTION_KNEE2_KPH = 50.0       # above this, motor natural characteristic: a ∝ 1 / v²
# Davis running resistance as a deceleration, v in km/h: A + B·v + C·v²
# (≈0.04 m/s² at 50 km/h, ≈0.07 m/s² at 80 km/h).
RESIST_A_MPS2 = 0.010
RESIST_B_MPS2_PER_KPH = 2.5e-4
RESIST_C_MPS2_PER_KPH2 = 6.0e-6
SERVICE_BRAKE_MAX_MPS2 = 1.10   # full service brake
EMERGENCY_BRAKE_MPS2 = 1.40     # actual EB rate
EB_BUILDUP_MPS3 = 4.0           # EB force build-up (not jerk limited for comfort)
JERK_LIMIT_MPS3 = 0.75          # ATO comfort jerk limit (traction and brake)

# ── ATO (automatic train operation) ──────────────────────────────────────────
ATO_STOP_DECEL_MPS2 = 0.85      # planning decel for station stops
ATO_EOA_DECEL_MPS2 = 0.85       # planning decel towards end of authority
ATO_CIVIL_DECEL_MPS2 = 0.60     # planning decel towards a lower civil limit
ATO_SPEED_MARGIN_MPS = 0.30     # ATO regulates this far under the civil ceiling (~1.1 km/h)
ATO_EOA_MARGIN_M = 6.0          # ATO aims to stop this far short of the EOA
ATO_GAIN_PER_S = 0.6            # P gain on speed error (a = ff + K·e)
ATO_COAST_BAND_MPS = 0.03       # |e| below this with no feed-forward → coast (a = 0)
ATO_TAPER_MPS = 0.5             # final-approach taper (decel → 0 as v → 0)
ATO_RESTART_M = 8.0             # a train stopped behind its EOA restarts only when it gains this much
ATO_DEPART_MIN_EOA_M = 250.0    # ATS: hold at the platform until this much authority (or next stop)
STOP_TOLERANCE_M = 0.5          # berthing accuracy window
STOP_SNAP_MPS = 0.02            # below this speed, near the stop point, brakes hold the train

# ── ATP (automatic train protection, onboard) ────────────────────────────────
GEBR_MPS2 = 1.25                # guaranteed emergency brake rate used for the EB curve
ATP_REACTION_S = 1.0            # detection + propulsion cut-off + brake build-up
ATP_OVERSPEED_KPH = 5.0         # EB if speed exceeds the ceiling by more than this
ATP_EB_RESET_S = 3.0            # standstill time before an ATP EB auto-resets

# ── Zone controller (wayside) ────────────────────────────────────────────────
ZC_SAFETY_MARGIN_M = 15.0       # EOA sits this far behind the leader's tail
SIGNAL_EOA_OFFSET_M = 1.0       # EOA sits this far before a signal at stop
ZC_LOOKAHEAD_M = 4000.0         # signals considered for EOA within this distance

# Back-compat names used elsewhere (ML snapshot semantics, older code).
SERVICE_DECEL_MPS2 = SERVICE_BRAKE_MAX_MPS2
EMERGENCY_DECEL_MPS2 = EMERGENCY_BRAKE_MPS2
URBALIS_MA_CYCLE_S = 0.2
URBALIS_FIXED_MARGIN_M = ZC_SAFETY_MARGIN_M
URBALIS_GUARANTEED_DECEL_MPS2 = GEBR_MPS2
