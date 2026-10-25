import os
import sys
from pathlib import Path

# Deterministic tests: never call the ML service unless a test opts in, and never start the
# background real-time sim thread.
os.environ.setdefault("DISPATCH_ML_DISABLED", "1")
os.environ.setdefault("SIM_AUTOSTART", "0")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_global_operator_state():
    """Operator overrides and injected incidents are process-global; isolate tests."""
    import commands
    from dispatch_live import live_dispatch
    from events import registry

    commands.reset_overrides()
    registry._incidents.clear()
    live_dispatch.network_enabled = False
    live_dispatch.reset()
    yield
    commands.reset_overrides()
    registry._incidents.clear()
    live_dispatch.network_enabled = False
