import { describe, expect, it } from 'vitest'
import type { Topology } from '../types/domain'
import { MotionEngine } from './engine'
import { signedDelta } from './routeIndex'
import { MOCK_TOPOLOGY, resetMock, tickMockRuntime } from '../mock/mockData'

/** A re-laid-out copy (new object, new points, same edge ids / route) — like schematic ↔ geographic. */
function relayout(t: Topology): Topology {
  return {
    ...t,
    nodes: t.nodes.map((n) => ({ ...n, x: n.x * 0.5 + 300, y: n.y * 1.3 })),
    edges: t.edges.map((e) => ({ ...e, points: e.points.map((p) => ({ x: p.x * 0.5 + 300, y: p.y * 1.3 })) })),
  }
}

describe('MotionEngine', () => {
  it('a layout swap keeps per-train continuity: no re-fade, no jump, no reversal', () => {
    resetMock()
    const eng = new MotionEngine()
    const geo = MOCK_TOPOLOGY
    const sch = relayout(MOCK_TOPOLOGY)
    let topo = geo
    let lastPoll = -1e9
    let minAlpha = 1
    let worstBack = 0
    let worstFwd = 0
    const prev = new Map<string, number>()
    for (let now = 0; now < 20_000; now += 1000 / 60) {
      if (now - lastPoll >= 200) { lastPoll = now; eng.ingest(tickMockRuntime(200), now + 20) }
      if (now >= 10_000) topo = Math.floor(now / 2500) % 2 ? sch : geo // toggle a few times
      const f = eng.computeFrame(topo, now)
      for (const m of f.trains) {
        if (now > 3000) minAlpha = Math.min(minAlpha, m.alpha)
        const p = prev.get(m.id)
        if (p != null && m.c != null && now > 3000) {
          const d = signedDelta(p, m.c, f.route!.lengthM)
          worstBack = Math.min(worstBack, d)
          worstFwd = Math.max(worstFwd, d)
        }
        if (m.c != null) prev.set(m.id, m.c)
      }
    }
    expect(minAlpha).toBe(1)
    expect(worstBack).toBeGreaterThanOrEqual(0)
    expect(worstFwd).toBeLessThan(0.5)
  })

  it('mock service through the engine: stationary trains never move and always read 0 km/h', () => {
    resetMock()
    const eng = new MotionEngine()
    let lastPoll = -1e9
    const prev = new Map<string, { c: number; st: boolean }>()
    let back = 0
    let stillMoves = 0
    let kmhWhileStationary = 0
    for (let now = 0; now < 60_000; now += 1000 / 60) {
      if (now - lastPoll >= 200) { lastPoll = now; eng.ingest(tickMockRuntime(200), now + 15) }
      const f = eng.computeFrame(MOCK_TOPOLOGY, now)
      for (const m of f.trains) {
        const p = prev.get(m.id)
        if (p && m.c != null) {
          const d = signedDelta(p.c, m.c, f.route!.lengthM)
          if (d < -1e-9) back++
          if (p.st && m.stationary && d !== 0) stillMoves++
        }
        if (m.stationary && m.displayKmh !== 0) kmhWhileStationary++
        if (m.c != null) prev.set(m.id, { c: m.c, st: m.stationary })
      }
    }
    expect(back).toBe(0)
    expect(stillMoves).toBe(0)
    expect(kmhWhileStationary).toBe(0)
  })
})
