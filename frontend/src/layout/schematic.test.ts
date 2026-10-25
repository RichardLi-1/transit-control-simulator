import { describe, expect, it } from 'vitest'
import { buildYusTopology } from '../mock/buildYusTopology'
import type { Topology, TopologyEdge, Vec2 } from '../types/domain'
import { Viewport, setFitInsets } from '../render/Viewport'
import { buildSchematic, type LayoutTarget } from './schematic'
import { stationLabelBoxes, cullLabels, approxMeasure, boxesOverlap } from './labels'
import { applyLayout } from './index'
import { getLayoutMeta } from './meta'
import { polylineLength } from '../utils/geometry'

function source(withMetres: boolean): { topology: Topology; route: string[] } {
  const { topology, trainRoute } = buildYusTopology()
  if (!withMetres) return { topology, route: trainRoute }
  // Fake real metres (≈ geographic polyline length × 6) and contract-v2 extras.
  const edges = topology.edges.map((e) => ({ ...e, length_m: Math.round(polylineLength(e.points) * 6) + 1 }))
  return { topology: { ...topology, edges }, route: trainRoute }
}

function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d)
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

function distToPolyline(p: Vec2, pts: Vec2[]): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const abx = b.x - a.x, aby = b.y - a.y
    const L2 = abx * abx + aby * aby
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2)) : 0
    best = Math.min(best, Math.hypot(a.x + u * abx - p.x, a.y + u * aby - p.y))
  }
  return best
}

function segments(edges: TopologyEdge[]): [Vec2, Vec2, string][] {
  const out: [Vec2, Vec2, string][] = []
  for (const e of edges) for (let i = 1; i < e.points.length; i++) out.push([e.points[i - 1], e.points[i], e.id])
  return out
}

interface Screen { name: string; w: number; h: number; insets: { top: number; right: number; bottom: number; left: number } }

/** Map canvas sizes: 16:10 desktop with the 320 px inspector + bars, a 390×844 phone, and a
 * desktop with a floating left panel (narrower, squarer map). */
const SCREENS: Screen[] = [
  { name: 'desktop', w: 1120, h: 832, insets: { top: 16, right: 56, bottom: 16, left: 16 } },
  { name: 'desktop + left panel', w: 1440, h: 844, insets: { top: 12, right: 64, bottom: 12, left: 324 } },
  { name: 'phone', w: 390, h: 728, insets: { top: 8, right: 44, bottom: 8, left: 8 } },
  { name: 'phone (no insets)', w: 390, h: 700, insets: { top: 6, right: 6, bottom: 6, left: 6 } },
]

function targetOf(s: Screen): LayoutTarget {
  return { width: s.w - s.insets.left - s.insets.right, height: s.h - s.insets.top - s.insets.bottom }
}

function fitViewport(t: Topology, w: number, h: number, insets: { top: number; right: number; bottom: number; left: number }) {
  setFitInsets(insets)
  const vp = new Viewport()
  vp.resize(w, h)
  vp.fitToBounds({ minX: t.bounds.min_x, minY: t.bounds.min_y, maxX: t.bounds.max_x, maxY: t.bounds.max_y })
  setFitInsets({ top: 0, right: 0, bottom: 0, left: 0 })
  return vp
}

function boxCrossesSegment(box: { x: number; y: number; w: number; h: number }, a: Vec2, b: Vec2): boolean {
  const corners: Vec2[] = [
    { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h },
  ]
  const inside = (p: Vec2) => p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h
  if (inside(a) || inside(b)) return true
  for (let k = 0; k < 4; k++) if (segIntersect(a, b, corners[k], corners[(k + 1) % 4])) return true
  return false
}

for (const withMetres of [false, true]) {
  describe(`schematic layout (${withMetres ? 'length_m' : 'pixel lengths'})`, () => {
    const { topology: src, route } = source(withMetres)
    const res = buildSchematic(src, { target: targetOf(SCREENS[0]) })!
    const t = res.topology
    const nodes = new Map(t.nodes.map((n) => [n.id, n]))
    const edges = new Map(t.edges.map((e) => [e.id, e]))

    it('keeps every id, length and signal reference', () => {
      expect(t.nodes.map((n) => n.id)).toEqual(src.nodes.map((n) => n.id))
      expect(t.edges.map((e) => [e.id, e.from_node, e.to_node, e.block_id, e.length, e.length_m]))
        .toEqual(src.edges.map((e) => [e.id, e.from_node, e.to_node, e.block_id, e.length, e.length_m]))
      expect(t.signals.map((s) => [s.id, s.edge_id, s.offset])).toEqual(src.signals.map((s) => [s.id, s.edge_id, s.offset]))
      expect(t.switches).toEqual(src.switches)
      expect(t.crossovers).toEqual(src.crossovers)
    })

    it('keeps edge endpoints on their nodes (except offset mid crossovers)', () => {
      for (const e of t.edges) {
        if (e.id.startsWith('xover_mid')) continue
        const a = nodes.get(e.from_node)!
        const b = nodes.get(e.to_node)!
        expect(Math.hypot(e.points[0].x - a.x, e.points[0].y - a.y)).toBeLessThan(1e-6)
        const last = e.points[e.points.length - 1]
        expect(Math.hypot(last.x - b.x, last.y - b.y)).toBeLessThan(1e-6)
      }
    })

    it('chains the revenue route into a closed ring', () => {
      for (let k = 0; k < route.length; k++) {
        const a = edges.get(route[k])!
        const b = edges.get(route[(k + 1) % route.length])!
        const end = a.points[a.points.length - 1]
        expect(Math.hypot(end.x - b.points[0].x, end.y - b.points[0].y)).toBeLessThan(1e-6)
      }
    })

    it('uses only straight runs and 45° bends', () => {
      for (const e of t.edges) {
        for (let i = 1; i < e.points.length; i++) {
          const dx = e.points[i].x - e.points[i - 1].x
          const dy = e.points[i].y - e.points[i - 1].y
          if (Math.hypot(dx, dy) < 1e-6) continue
          const deg = (Math.atan2(dy, dx) * 180) / Math.PI
          const off = Math.abs(deg / 45 - Math.round(deg / 45))
          expect(off, `${e.id} ${JSON.stringify(e.points)}`).toBeLessThan(1e-3)
        }
      }
    })

    it('keeps the two tracks parallel at the track separation', () => {
      const sep = res.meta.trackSep
      const n = t.nodes.filter((x) => x.id.startsWith('ob_')).length
      for (let i = 0; i < n - 1; i++) {
        const ob = edges.get(`ob_${i}_${i + 1}`)!
        const ib = edges.get(`ib_${i + 1}_${i}`)!
        // Along every straight piece the other track is exactly `sep` away…
        const mids = (pts: Vec2[]) => pts.slice(1).map((p, k) => ({ x: (p.x + pts[k].x) / 2, y: (p.y + pts[k].y) / 2 }))
        for (const p of mids(ob.points)) expect(Math.abs(distToPolyline(p, ib.points) - sep), ob.id).toBeLessThan(5e-3)
        for (const p of mids(ib.points)) expect(Math.abs(distToPolyline(p, ob.points) - sep), ib.id).toBeLessThan(5e-3)
        // …and corners never pinch (outer miter corner of a 45° bend is sep / cos 22.5°).
        const corner = sep / Math.cos(Math.PI / 8) + 5e-3
        for (const p of ob.points) {
          const d = distToPolyline(p, ib.points)
          expect(d).toBeGreaterThan(sep - 5e-3)
          expect(d).toBeLessThan(corner)
        }
        for (const p of ib.points) {
          const d = distToPolyline(p, ob.points)
          expect(d).toBeGreaterThan(sep - 5e-3)
          expect(d).toBeLessThan(corner)
        }
        // Platform nodes sit directly across from each other.
        const a = nodes.get(`ob_${i}`)!
        const b = nodes.get(`ib_${i}`)!
        expect(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - sep)).toBeLessThan(5e-3)
      }
    })

    it('never crosses tracks except at crossovers', () => {
      const revenue = t.edges.filter((e) => !e.id.startsWith('xover'))
      const segs = segments(revenue)
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const [a, b, ea] = segs[i]
          const [c, d, eb] = segs[j]
          if (ea === eb) continue
          expect(segIntersect(a, b, c, d), `${ea} × ${eb}`).toBe(false)
        }
      }
    })

    it('recomputes signal positions from edge_id + offset', () => {
      for (const s of t.signals) {
        const e = edges.get(s.edge_id)!
        expect(distToPolyline(s.position, e.points)).toBeLessThan(1e-3)
      }
    })

    it('draws mid crossovers as straight diagonals across the pair, clear of both platforms', () => {
      const n = t.nodes.filter((x) => x.id.startsWith('ob_')).length
      for (const e of t.edges.filter((x) => x.id.startsWith('xover_mid'))) {
        expect(e.points.length).toBe(2)
        const [a, b] = e.points
        // 45° to the rails (steeper only where signals leave less room)
        const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
        expect(Math.abs(deg / 45 - Math.round(deg / 45)), e.id).toBeLessThan(1e-3)
        // diagonal spans exactly the track separation across, and lies between its two stations
        const i = Number(e.id.split('_').pop())
        expect(i).toBeLessThan(n - 1)
        const ob = edges.get(`ob_${i}_${i + 1}`)!
        const ib = edges.get(`ib_${i + 1}_${i}`)!
        expect(distToPolyline(a, ob.points), e.id).toBeLessThan(1e-3)
        expect(distToPolyline(b, ib.points), `${e.id} ${JSON.stringify(e.points)} ${JSON.stringify(ib.points)}`).toBeLessThan(1e-3)
        const s0 = nodes.get(`ob_${i}`)!
        const s1 = nodes.get(`ob_${i + 1}`)!
        expect(Math.hypot(a.x - s0.x, a.y - s0.y)).toBeGreaterThan(res.meta.trackSep * 0.8)
        expect(Math.hypot(a.x - s1.x, a.y - s1.y)).toBeGreaterThan(res.meta.trackSep * 0.8)
      }
    })

    for (const screen of SCREENS) {
      describe(`at fit on ${screen.name} (${screen.w}×${screen.h})`, () => {
        const r = buildSchematic(src, { target: targetOf(screen) })!
        const vp = fitViewport(r.topology, screen.w, screen.h, screen.insets)
        const boxes = stationLabelBoxes(r.meta, vp, approxMeasure)

        it('fits at zoom ≥ 1 (the diagram is sized for the screen)', () => {
          expect(vp.camera.zoom).toBeGreaterThan(0.97)
        })

        it('shows every station name, none overlapping, all on screen', () => {
          expect(boxes.length).toBe(38)
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              expect(boxesOverlap(boxes[i], boxes[j]), `${boxes[i].station.name} / ${boxes[j].station.name}`).toBe(false)
            }
            const b = boxes[i]
            expect(b.x, b.station.name).toBeGreaterThanOrEqual(0)
            expect(b.y, b.station.name).toBeGreaterThanOrEqual(0)
            expect(b.x + b.w, b.station.name).toBeLessThanOrEqual(screen.w - screen.insets.right + 1)
            expect(b.y + b.h, b.station.name).toBeLessThanOrEqual(screen.h)
          }
          expect(cullLabels(boxes, vp).length).toBe(38)
        })

        it('keeps station names off every track', () => {
          const segs = segments(r.topology.edges).map(([a, b]) => {
            const [ax, ay] = vp.worldToScreen(a.x, a.y)
            const [bx, by] = vp.worldToScreen(b.x, b.y)
            return [{ x: ax, y: ay }, { x: bx, y: by }] as const
          })
          for (const box of boxes) for (const [a, b] of segs) expect(boxCrossesSegment(box, a, b), box.station.name).toBe(false)
        })

        it('keeps the two branches well apart (room for inner-side text)', () => {
          if (!withMetres) return
          const st = r.meta.stations
          const gap = Math.abs(st[27].center.x - st[15].center.x) * vp.camera.zoom // Bloor–Yonge ↔ St George
          expect(gap).toBeGreaterThan(screen.w > 700 ? 200 : 38)
        })
      })
    }
  })
}

describe('mid crossovers vs their protecting signals (backend data shape)', () => {
  // Backend: points at 0.3 along both legs, home/starter signals with `switch_id`, some very close
  // to the points downtown (e.g. BLY 1 at 0.108 / BLY 2 at 0.464). A train must always pass the
  // signal before it reaches the points, in both directions.
  const { topology } = source(true)
  const segs = new Map((topology.route?.segments ?? []).map((x) => [x.edge_id, x]))
  const mids = topology.switches.filter((x) => /^sw_mid_\d+$/.test(x.id))
  const signals = [...topology.signals]
  const switches = mids.map((sw) => {
    const i = Number(sw.id.split('_').pop())
    const ob = segs.get(`ob_${i}_${i + 1}`)!
    const ib = segs.get(`ib_${i + 1}_${i}`)!
    signals.push({ ...topology.signals[0], id: `sig_t_${i}_ob`, edge_id: `ob_${i}_${i + 1}`, offset: 0.12, switch_id: sw.id } as typeof signals[number])
    signals.push({ ...topology.signals[0], id: `sig_t_${i}_ib`, edge_id: `ib_${i + 1}_${i}`, offset: 0.48, switch_id: sw.id } as typeof signals[number])
    return { ...sw, points_m: [ob.start_m + 0.3 * ob.length_m, ib.start_m + 0.7 * ib.length_m] }
  })
  const src: Topology = { ...topology, signals, switches: [...topology.switches.filter((x) => !/^sw_mid/.test(x.id)), ...switches] }

  for (const screen of SCREENS) {
    it(`keeps each diagonal between its signals (${screen.name})`, () => {
      const t = buildSchematic(src, { target: targetOf(screen) })!.topology
      const E = new Map(t.edges.map((e) => [e.id, e]))
      const along = (pts: Vec2[], p: Vec2) => {
        let acc = 0, best = 0, bd = Infinity
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k]
          const L = Math.hypot(b.x - a.x, b.y - a.y)
          const u = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L)))
          const d = Math.hypot(a.x + u * (b.x - a.x) - p.x, a.y + u * (b.y - a.y) - p.y)
          if (d < bd) { bd = d; best = acc + u * L }
          acc += L
        }
        return best / acc
      }
      for (const sw of mids) {
        const i = Number(sw.id.split('_').pop())
        const x = E.get(sw.reverse_edge_id)!
        const ob = E.get(`ob_${i}_${i + 1}`)!
        const ib = E.get(`ib_${i + 1}_${i}`)!
        expect(along(ob.points, x.points[0]), `${sw.id} ob points after its signal`).toBeGreaterThan(0.12)
        expect(along(ib.points, x.points[1]), `${sw.id} ib points after its signal`).toBeGreaterThan(0.48)
      }
    })
  }
})

describe('applyLayout', () => {
  it('returns one stable object per layout', () => {
    const { topology } = buildYusTopology()
    const a = applyLayout(topology, 'schematic')
    expect(applyLayout(topology, 'schematic')).toBe(a)
    expect(applyLayout(topology, 'geographic')).toBe(topology)
    expect(getLayoutMeta(a).kind).toBe('schematic')
    expect(getLayoutMeta(topology).stations.length).toBe(38)
  })
})
