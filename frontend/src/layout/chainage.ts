/**
 * Route chainage (metres on the revenue ring) → map geometry, for any layout.
 * A chainage c on segment {edge_id, start_m, length_m} sits at fraction (c - start_m) / length_m
 * along that edge's polyline (contract v2).
 */
import type { Topology, TopologyEdge, Vec2 } from '../types/domain'
import { interpolatePolyline, polylineLength } from '../utils/geometry'

export interface ChainagePoint {
  edge: TopologyEdge
  t: number
  point: Vec2
  /** Unit tangent in travel direction. */
  dir: Vec2
  leg: 'ob' | 'ib' | 'other'
}

function edgeMap(topology: Topology): Map<string, TopologyEdge> {
  return new Map(topology.edges.map((e) => [e.id, e]))
}

const EDGE_MAPS = new WeakMap<Topology, Map<string, TopologyEdge>>()
function edgesOf(topology: Topology): Map<string, TopologyEdge> {
  let m = EDGE_MAPS.get(topology)
  if (!m) {
    m = edgeMap(topology)
    EDGE_MAPS.set(topology, m)
  }
  return m
}

function tangent(points: Vec2[], t: number): Vec2 {
  const a = interpolatePolyline(points, Math.max(0, t - 0.002))
  const b = interpolatePolyline(points, Math.min(1, t + 0.002))
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
}

export function legOf(edgeId: string): 'ob' | 'ib' | 'other' {
  if (edgeId.startsWith('ob_')) return 'ob'
  if (edgeId.startsWith('ib_')) return 'ib'
  return 'other'
}

export function chainagePoint(topology: Topology, c: number): ChainagePoint | null {
  const route = topology.route
  if (!route || !route.segments?.length || !(route.length_m > 0) || !Number.isFinite(c)) return null
  const L = route.length_m
  const cc = ((c % L) + L) % L
  const edges = edgesOf(topology)
  for (const seg of route.segments) {
    if (cc >= seg.start_m && cc < seg.start_m + seg.length_m) {
      const edge = edges.get(seg.edge_id)
      if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) return null
      const t = seg.length_m > 0 ? (cc - seg.start_m) / seg.length_m : 0
      return { edge, t, point: interpolatePolyline(edge.points, t), dir: tangent(edge.points, t), leg: legOf(edge.id) }
    }
  }
  return null
}

/** Sub-polyline of `points` between fractions t0 < t1 (by arc length). */
export function slicePolyline(points: Vec2[], t0: number, t1: number): Vec2[] {
  const total = polylineLength(points)
  if (total <= 0) return []
  const a = Math.max(0, Math.min(1, t0)) * total
  const b = Math.max(0, Math.min(1, t1)) * total
  const out: Vec2[] = [interpolatePolyline(points, t0)]
  let acc = 0
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (acc > a && acc < b) out.push(points[i])
  }
  out.push(interpolatePolyline(points, t1))
  return out
}

/** Polylines covering chainage range [a, b) (a < b, no wrap), one per route edge touched. */
export function chainageRange(topology: Topology, a: number, b: number): { edge: TopologyEdge; points: Vec2[] }[] {
  const route = topology.route
  if (!route?.segments?.length || !Number.isFinite(a) || !Number.isFinite(b)) return []
  const edges = edgesOf(topology)
  const out: { edge: TopologyEdge; points: Vec2[] }[] = []
  for (const seg of route.segments) {
    const s0 = seg.start_m
    const s1 = seg.start_m + seg.length_m
    const lo = Math.max(a, s0)
    const hi = Math.min(b, s1)
    if (hi <= lo || seg.length_m <= 0) continue
    const edge = edges.get(seg.edge_id)
    if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) continue
    out.push({ edge, points: slicePolyline(edge.points, (lo - s0) / seg.length_m, (hi - s0) / seg.length_m) })
  }
  return out
}

const WPM = new WeakMap<Topology, number>()

/**
 * Typical world units per track metre along the route (median over revenue edges). The
 * schematic does not keep a constant scale (downtown is stretched, the Union loop is widened),
 * so trains and platforms are drawn at this typical scale for a consistent size everywhere.
 */
export function worldPerMetre(topology: Topology): number {
  const hit = WPM.get(topology)
  if (hit != null) return hit
  const edges = edgesOf(topology)
  const ratios: number[] = []
  for (const seg of topology.route?.segments ?? []) {
    if (!(seg.length_m > 50)) continue
    const e = edges.get(seg.edge_id)
    if (!e || !Array.isArray(e.points) || e.points.length < 2) continue
    const w = polylineLength(e.points)
    if (w > 0) ratios.push(w / seg.length_m)
  }
  ratios.sort((a, b) => a - b)
  const v = ratios.length ? ratios[ratios.length >> 1] : 0.05
  WPM.set(topology, v)
  return v
}
