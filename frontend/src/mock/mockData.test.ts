import { describe, expect, it } from 'vitest'
import { MOCK_TOPOLOGY, mockCommandTrain, resetMock, tickMockRuntime } from './mockData'
import { buildRouteIndex, fwdDist } from '../motion/routeIndex'
import type { TrainPosition } from '../types/domain'

const L = MOCK_TOPOLOGY.route!.length_m
const platformChainages = MOCK_TOPOLOGY.stations!.flatMap(s => s.platforms.map(p => p.chainage_m))

function run(seconds: number, each?: (trains: TrainPosition[], t: number) => void) {
  let last = tickMockRuntime(0)
  for (let t = 0; t < seconds; t += 0.5) {
    last = tickMockRuntime(500)
    each?.(last.trains, last.sim_time_s!)
  }
  return last
}

describe('mock service (contract v2)', () => {
  it('publishes a route the motion index accepts, ~77 km ring', () => {
    const idx = buildRouteIndex(MOCK_TOPOLOGY)!
    expect(idx.fromContract).toBe(true)
    expect(L).toBeGreaterThan(76_000)
    expect(L).toBeLessThan(78_000)
    expect(MOCK_TOPOLOGY.stations).toHaveLength(38)
    expect(MOCK_TOPOLOGY.signals.length).toBeLessThan(40) // interlockings only
  })

  it('runs realistically: no EOA violations, exact platform stops, no speed limit-cycling', () => {
    resetMock()
    const prev = new Map<string, TrainPosition>()
    const travelled = new Map<string, number>()
    const v = { overspeed: 0, negativeGap: 0, pastEoa: 0, dwellMoving: 0, dwellOffPlatform: 0, bigStep: 0, flips: 0 }
    let dwellSamples = 0
    run(1800, (trains) => {
      for (const t of trains) {
        if (t.speed > 80 / 3.6 + 1e-6) v.overspeed++
        if ((t.gap_to_leader_m ?? 999) < 0) v.negativeGap++
        if (t.authority_eoa_m != null) {
          const ahead = fwdDist(t.chainage_m!, t.authority_eoa_m, L)
          if (!(ahead < L * 0.75 || ahead > L - 0.01)) v.pastEoa++
        }
        if (t.state === 'dwelling') {
          dwellSamples++
          if (t.speed !== 0) v.dwellMoving++
          if (!platformChainages.some(c => Math.abs(c - t.chainage_m!) < 0.01)) v.dwellOffPlatform++
        }
        const p = prev.get(t.train_id)
        if (p) {
          const d = fwdDist(p.chainage_m!, t.chainage_m!, L)
          if (d >= 12) v.bigStep++ // ≤ 22 m/s × 0.5 s, never backwards (would be ~L)
          travelled.set(t.train_id, (travelled.get(t.train_id) ?? 0) + d)
          const a0 = p.accel_mps2 ?? 0
          const a1 = t.accel_mps2 ?? 0
          if (t.state === 'running' && p.state === 'running' && Math.abs(a0) > 0.05 && Math.abs(a1) > 0.05 && Math.sign(a0) !== Math.sign(a1)) v.flips++
        }
        prev.set(t.train_id, t)
      }
    })
    expect(dwellSamples).toBeGreaterThan(1000)
    expect(v).toEqual({ overspeed: 0, negativeGap: 0, pastEoa: 0, dwellMoving: 0, dwellOffPlatform: 0, bigStep: 0, flips: v.flips })
    for (const [, d] of travelled) expect(d).toBeGreaterThan(5000) // everyone circulates
    // accelerate↔brake flips while running should be rare (no bang-bang ATO)
    expect(v.flips / prev.size).toBeLessThan(40)
  }, 60_000)

  it('honours dispatcher commands', () => {
    resetMock()
    let st = tickMockRuntime(0)
    const id = st.trains[0].train_id
    mockCommandTrain(id, 'express')
    st = run(1)
    expect(st.trains.find(t => t.train_id === id)!.dispatch_express).toBe(true)
    mockCommandTrain(id, 'release')
    st = run(1)
    expect(st.trains.find(t => t.train_id === id)!.dispatch_express).toBe(false)
    mockCommandTrain(id, 'hold')
    st = run(400)
    const t = st.trains.find(t => t.train_id === id)!
    expect(t.state).toBe('dwelling')
    expect(t.stop_reason).toBe('dispatcher_hold')
  }, 60_000)
})
