import { describe, expect, it } from 'vitest'
import type { Topology, TopologyEdge } from '../types/domain'
import {
  appendRange,
  buildRouteIndex,
  chainageOfEdgeOffset,
  fwdDist,
  getRouteIndex,
  pointAt,
  segIndexAt,
  signedDelta,
  wrapC,
} from './routeIndex'
import { buildYusTopology } from '../mock/buildYusTopology'

function edge(id: string, from: string, to: string, pts: [number, number][], length = 0): TopologyEdge {
  return { id, from_node: from, to_node: to, block_id: id, points: pts.map(([x, y]) => ({ x, y })), length }
}

/**
 * Square ring 100×100 world units; e0 has an interior vertex (L-shape is split across e0).
 * Track metres differ from world units on purpose: e0 = 1000 m, e1 = 500 m, e2 = 1000 m, e3 = 500 m.
 */
function squareTopology(): Topology {
  const edges = [
    edge('e0', 'a', 'b', [[0, 0], [50, 0], [100, 0]]),
    edge('e1', 'b', 'c', [[100, 0], [100, 100]]),
    edge('e2', 'c', 'd', [[100, 100], [0, 100]]),
    edge('e3', 'd', 'a', [[0, 100], [0, 0]]),
  ]
  return {
    nodes: [],
    edges,
    switches: [],
    crossovers: [],
    signals: [],
    bounds: { min_x: 0, min_y: 0, max_x: 100, max_y: 100 },
    route: {
      length_m: 3000,
      segments: [
        { edge_id: 'e0', start_m: 0, length_m: 1000 },
        { edge_id: 'e1', start_m: 1000, length_m: 500 },
        { edge_id: 'e2', start_m: 1500, length_m: 1000 },
        { edge_id: 'e3', start_m: 2500, length_m: 500 },
      ],
    },
  }
}

describe('chainage arithmetic', () => {
  it('wraps into [0, L)', () => {
    expect(wrapC(3010, 3000)).toBeCloseTo(10)
    expect(wrapC(-10, 3000)).toBeCloseTo(2990)
    expect(wrapC(3000, 3000)).toBe(0)
  })
  it('measures forward distance across the wrap', () => {
    expect(fwdDist(2990, 10, 3000)).toBeCloseTo(20)
    expect(fwdDist(10, 2990, 3000)).toBeCloseTo(2980)
    expect(signedDelta(10, 2990, 3000)).toBeCloseTo(-20)
  })
})

describe('route index', () => {
  const topo = squareTopology()
  const idx = buildRouteIndex(topo)!

  it('builds from contract route', () => {
    expect(idx.fromContract).toBe(true)
    expect(idx.lengthM).toBe(3000)
    expect(idx.segs).toHaveLength(4)
  })

  it('maps chainage by track metres, not world units', () => {
    const p = pointAt(idx, 250) // quarter of e0 → x = 25
    expect(p.x).toBeCloseTo(25)
    expect(p.y).toBeCloseTo(0)
    expect(p.angle).toBeCloseTo(0)
    const q = pointAt(idx, 1250) // half of e1 (500 m) → y = 50
    expect(q.x).toBeCloseTo(100)
    expect(q.y).toBeCloseTo(50)
    expect(q.angle).toBeCloseTo(Math.PI / 2)
  })

  it('places edge boundaries on the next edge', () => {
    expect(segIndexAt(idx, 1000)).toBe(1)
    expect(segIndexAt(idx, 999.999)).toBe(0)
    const p = pointAt(idx, 1000)
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(0)
    expect(p.angle).toBeCloseTo(Math.PI / 2) // heading down e1
  })

  it('wraps at the end of the ring', () => {
    const a = pointAt(idx, 3000 + 250)
    expect(a.x).toBeCloseTo(25)
    const b = pointAt(idx, -250) // 2750 → halfway up e3 (x=0, y=50)
    expect(b.x).toBeCloseTo(0)
    expect(b.y).toBeCloseTo(50)
  })

  it('returns a range polyline across an edge boundary with interior vertices', () => {
    const out: number[] = []
    // from 400 m on e0 (x=40) for 800 m: e0 → x=100 (incl. vertex 50,0), then 200 m of e1 (y=40)
    appendRange(idx, 400, 800, out)
    expect(out).toEqual([40, 0, 50, 0, 100, 0, 100, 40].map(v => expect.closeTo(v, 6)))
  })

  it('returns a range polyline across the ring wrap', () => {
    const out: number[] = []
    appendRange(idx, 2900, 300, out) // last 100 m of e3 (y 20→0) + 200 m of e0 (x 0→20)
    const pts: [number, number][] = []
    for (let i = 0; i < out.length; i += 2) pts.push([out[i], out[i + 1]])
    expect(pts[0][0]).toBeCloseTo(0)
    expect(pts[0][1]).toBeCloseTo(20)
    expect(pts[pts.length - 1][0]).toBeCloseTo(20)
    expect(pts[pts.length - 1][1]).toBeCloseTo(0)
    // passes through the ring origin, no duplicate boundary point
    expect(pts.filter(p => Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9)).toHaveLength(1)
  })

  it('zero-length range yields a single point', () => {
    const out: number[] = []
    expect(appendRange(idx, 500, 0, out)).toBe(1)
    expect(out[0]).toBeCloseTo(50)
  })

  it('maps legacy edge/offset to chainage', () => {
    expect(chainageOfEdgeOffset(idx, 'e2', 0.5)).toBeCloseTo(2000)
    expect(chainageOfEdgeOffset(idx, 'nope', 0.5)).toBeNull()
  })

  it('memoizes per topology object and rebuilds for a re-laid-out copy', () => {
    const a = getRouteIndex(topo)
    expect(getRouteIndex(topo)).toBe(a)
    const relaid: Topology = {
      ...topo,
      edges: topo.edges.map(e => ({ ...e, points: e.points.map(p => ({ x: p.x * 2, y: p.y * 2 })) })),
    }
    const b = getRouteIndex(relaid)!
    expect(b).not.toBe(a)
    expect(pointAt(b, 250).x).toBeCloseTo(50) // same chainage, new layout
  })
})

describe('legacy ring synthesis (no topology.route)', () => {
  const { topology, trainRoute } = buildYusTopology()
  const legacy: Topology = { ...topology, route: undefined, edges: topology.edges.map(e => ({ ...e, length_m: undefined })) }
  const idx = buildRouteIndex(legacy)!

  it('chains ob → xover_end → ib → xover_start', () => {
    expect(idx.fromContract).toBe(false)
    expect(idx.segs.map(s => s.edgeId)).toEqual(trainRoute)
  })

  it('uses legacy pixel `length` as chainage units', () => {
    const total = trainRoute.reduce((s, id) => s + legacy.edges.find(e => e.id === id)!.length, 0)
    expect(idx.lengthM).toBeCloseTo(total)
  })

  it('returns null for a topology that does not form a ring', () => {
    const broken: Topology = { ...legacy, edges: legacy.edges.filter(e => e.id !== 'xover_end') }
    expect(buildRouteIndex(broken)).toBeNull()
  })
})
