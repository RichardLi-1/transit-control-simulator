"""Wayside zone controller: movement authority (EOA) for every train on the ring.

EOA = the most restrictive of
  * the leader's tail − ZC_SAFETY_MARGIN_M (moving block), and
  * the first interlocking signal at STOP ahead − SIGNAL_EOA_OFFSET_M.

The EOA is a *point*; braking distance is NOT added here (that is the onboard ATP's job —
adding it in both places was the old double-counting bug).

Approach locking: if a signal is put to stop in front of a train that can no longer stop for
it with a service brake application (operator override / failure at the last moment), the
train is "committed" and keeps its authority through that signal; the next train stops.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import TYPE_CHECKING, List

from ma_constants import (
    SERVICE_BRAKE_MAX_MPS2,
    SIGNAL_EOA_OFFSET_M,
    ZC_LOOKAHEAD_M,
    ZC_SAFETY_MARGIN_M,
)
from route_geom import ROUTE_LEN_M

if TYPE_CHECKING:
    from interlocking import Interlocking
    from train import Train

_L = ROUTE_LEN_M
_COMMIT_DECEL = SERVICE_BRAKE_MAX_MPS2 - 0.1
_COMMIT_REACTION_S = 1.0


def required_follower_gap_m(follower_speed_kph: float, leader_speed_kph: float = 0.0) -> float:
    """Minimum nose→leader-tail gap for a follower at this speed: ATP stopping distance + margin.
    (Leader speed is ignored: brick-wall moving block.)"""
    from train import atp_stopping_distance_m
    return atp_stopping_distance_m(follower_speed_kph / 3.6, 0.0) + ZC_SAFETY_MARGIN_M


class ZoneController:
    def __init__(self, route_len_m: float = ROUTE_LEN_M) -> None:
        self.route_len_m = route_len_m

    def update(self, trains: List["Train"], interlocking: "Interlocking | None" = None,
               trains_sorted: List["Train"] | None = None) -> None:
        if not trains:
            return
        L = self.route_len_m
        order = trains_sorted if trains_sorted is not None else sorted(trains, key=lambda t: t.chainage_front_m)
        n = len(order)
        stops = interlocking.stop_signals if interlocking is not None else []
        stop_ch = [c for c, _ in stops]
        ns = len(stops)

        for idx in range(n):
            tr = order[idx]
            nose = tr.chainage_front_m
            if n > 1:
                leader = order[(idx + 1) % n]
                tail = leader.chainage_front_m - leader.length_m
                gap = (tail - nose) % L
                if gap > L - leader.length_m:   # numerically overlapping (shouldn't happen)
                    gap = 0.0
                eoa = gap - ZC_SAFETY_MARGIN_M
                src = 'train_ahead'
                u = leader.v
                tr.eoa_train_m = eoa
                tr.eoa_train_speed_mps = u
                tr.leader_run_number = leader.run_number
                tr.gap_to_leader_m = gap
            else:
                eoa = L - tr.length_m - ZC_SAFETY_MARGIN_M
                src = None
                u = 0.0
                tr.eoa_train_m = eoa
                tr.eoa_train_speed_mps = 0.0
                tr.leader_run_number = None
                tr.gap_to_leader_m = None
            sig_id = None
            tr.eoa_signal_m = float('inf')

            if ns:
                respected = tr._respected_signals
                committed = tr._committed_signals
                if respected or committed:
                    # Forget signals that cleared or that the train has passed.
                    asp = interlocking.aspects
                    for s in [s for s in respected if asp.get(s) != 'red' or not self._ahead(nose, interlocking, s)]:
                        respected.discard(s)
                    for s in [s for s in committed if asp.get(s) != 'red' or not self._ahead(nose, interlocking, s)]:
                        committed.discard(s)
                j = bisect_right(stop_ch, nose)
                v = tr.v
                for k in range(ns):
                    c, sid = stops[(j + k) % ns]
                    d = (c - nose) % L
                    # Report the first applicable signal at stop even when it lies beyond the
                    # leader-based limit: the ATO then sees it coming and blends smoothly when
                    # the leader passes it and it becomes the binding limit.
                    if d > ZC_LOOKAHEAD_M:
                        break
                    if d < 0.5:
                        continue
                    need = v * _COMMIT_REACTION_S + v * v / (2.0 * _COMMIT_DECEL)
                    if sid in committed:
                        # Approach locking only covers a train that genuinely can't stop.  If it
                        # has since slowed (e.g. stopped behind its leader) it must respect it.
                        if d - SIGNAL_EOA_OFFSET_M >= need:
                            committed.discard(sid)
                            respected.add(sid)
                        else:
                            continue
                    if sid not in respected:
                        if d - SIGNAL_EOA_OFFSET_M >= need:
                            respected.add(sid)
                        else:
                            committed.add(sid)
                            continue
                    tr.eoa_signal_m = d - SIGNAL_EOA_OFFSET_M
                    if tr.eoa_signal_m < eoa:
                        eoa = tr.eoa_signal_m
                        src = 'signal'
                        u = 0.0
                        sig_id = sid
                    break
            else:
                tr._respected_signals.clear()
                tr._committed_signals.clear()

            tr.eoa_dist_m = eoa
            tr.eoa_source = src
            tr.eoa_speed_mps = u
            tr.eoa_signal_id = sig_id
            tr.authority_eoa_m = (nose + max(eoa, 0.0)) % L

    @staticmethod
    def _ahead(nose: float, interlocking, sid: str) -> bool:
        sig = interlocking.by_id.get(sid) if interlocking is not None else None
        if sig is None:
            return False
        return (sig.ch - nose) % _L < ZC_LOOKAHEAD_M
