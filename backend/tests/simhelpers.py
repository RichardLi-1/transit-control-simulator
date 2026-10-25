"""Shared helpers for backend tests."""

from __future__ import annotations


def make_sim(**kw):
    """A fresh simulation on its own line (does not touch the global roster)."""
    import sim as simmod
    import train as trainmod

    line = trainmod.Line("YUS", [])
    kw.setdefault("populate", True)
    return simmod.Simulation(lines=[line], **kw), line


def lone_train_sim(chainage_m: float, v_mps: float = 0.0, **kw):
    """One train on an otherwise empty ring, no spawning."""
    import sim as simmod
    import train as trainmod

    tr = trainmod.Train(chainage_front_m=chainage_m, run_number=1)
    tr.v = v_mps
    line = trainmod.Line("YUS", [tr])
    kw.setdefault("spawning", False)
    kw.setdefault("use_dispatch", False)
    s = simmod.Simulation(lines=[line], populate=False, **kw)
    return s, line, tr
