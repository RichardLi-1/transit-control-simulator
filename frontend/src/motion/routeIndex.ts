/**
 * Route index: maps ring chainage (metres) ↔ world geometry.
 *
 * Built from `topology.route.segments` (contract v2). For a legacy backend that has no
 * `route`, a ring is synthesized by chaining edges (ob_0_1 → … → xover_end → ib_… →
 * xover_start), using `length_m ?? length` — the legacy backend treats `length` as metres
 * for chainage, so speeds (m/s) stay consistent.
 *
 * Indexes are memoized per topology OBJECT (WeakMap): when the visual agent swaps in a
 * re-laid-out topology, the next lookup builds a fresh index from the new `points`.
 */
import type { Topology, TopologyEdge, Vec2 } from '../types/domain'

export interface RouteSeg {
  edgeId: string
  index: number
  /** Chainage at the start of this edge (m). */
  startM: number
  /** Track metres of this edge. */
  lengthM: number
  /** World-space polyline (edge.points). */
  pts: Vec2[]
  /** Cumulative world arc length at each vertex; cum[0] = 0. */
  cum: Float64Array
  worldLen: number
}

export interface RouteIndex {
  topology: Topology
  lengthM: number
  segs: RouteSeg[]
  /** seg start chainages for binary search */
  starts: Float64Array
  segByEdge: Map<string, RouteSeg>
  edgeById: Map<string, TopologyEdge>
  /** true when built from topology.route (chainage_m on trains is meaningful) */
  fromContract: boolean
}

/** Mutable output for point lookups (avoids per-call allocation). */
export interface RoutePoint {
  x: number
  y: number
  /** tangent angle (radians, atan2 in world space) in the direction of travel */
  angle: number
}

const cache = new WeakMap<Topology, RouteIndex | null>()

export function getRouteIndex(topology: Topology | null | undefined): RouteIndex | null {
  if (!topology) return null
  if (cache.has(topology)) return cache.get(topology) ?? null
  const idx = buildRouteIndex(topology)
  cache.set(topology, idx)
  return idx
}

function makeSeg(edge: TopologyEdge, index: number, startM: number, lengthM: number): RouteSeg {
  const pts = edge.points && edge.points.length > 0 ? edge.points : [{ x: 0, y: 0 }]
  const cum = new Float64Array(pts.length)
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    cum[i] = acc
  }
  return { edgeId: edge.id, index, startM, lengthM, pts, cum, worldLen: acc }
}

function finish(topology: Topology, segs: RouteSeg[], edgeById: Map<string, TopologyEdge>, fromContract: boolean, lengthM: number): RouteIndex | null {
  if (segs.length === 0 || !(lengthM > 0)) return null
  const starts = new Float64Array(segs.length)
  const segByEdge = new Map<string, RouteSeg>()
  segs.forEach((s, i) => { starts[i] = s.startM; segByEdge.set(s.edgeId, s) })
  return { topology, lengthM, segs, starts, segByEdge, edgeById, fromContract }
}

export function buildRouteIndex(topology: Topology): RouteIndex | null {
  const edgeById = new Map<string, TopologyEdge>()
  for (const e of topology.edges ?? []) edgeById.set(e.id, e)

  const route = topology.route
  if (route && Array.isArray(route.segments) && route.segments.length > 0) {
    const segs: RouteSeg[] = []
    let expected = 0
    for (const rs of route.segments) {
      const edge = edgeById.get(rs.edge_id)
      if (!edge || !(rs.length_m > 0)) continue
      const start = Number.isFinite(rs.start_m) ? rs.start_m : expected
      segs.push(makeSeg(edge, segs.length, start, rs.length_m))
      expected = start + rs.length_m
    }
    const total = route.length_m > 0 ? route.length_m : expected
    const idx = finish(topology, segs, edgeById, true, total)
    if (idx) return idx
  }
  return synthesizeRing(topology, edgeById)
}

/** Legacy: chain edges from ob_0_1 around the ring, skipping mid-line crossovers. */
function synthesizeRing(topology: Topology, edgeById: Map<string, TopologyEdge>): RouteIndex | null {
  const edges = topology.edges ?? []
  if (edges.length === 0) return null
  const outgoing = new Map<string, TopologyEdge[]>()
  for (const e of edges) {
    if (e.id.startsWith('xover_mid')) continue
    const list = outgoing.get(e.from_node)
    if (list) list.push(e)
    else outgoing.set(e.from_node, [e])
  }
  const start = edgeById.get('ob_0_1') ?? edges[0]
  const chain: TopologyEdge[] = [start]
  const seen = new Set([start.id])
  let cur = start
  for (let guard = 0; guard < edges.length + 1; guard++) {
    const cands = outgoing.get(cur.to_node) ?? []
    if (cands.some(e => e.id === start.id)) {
      // ring closed
      const segs: RouteSeg[] = []
      let acc = 0
      for (const e of chain) {
        const len = (e.length_m ?? e.length) || 0
        if (!(len > 0)) continue
        segs.push(makeSeg(e, segs.length, acc, len))
        acc += len
      }
      return finish(topology, segs, edgeById, false, acc)
    }
    const fresh = cands.filter(e => !seen.has(e.id))
    if (fresh.length === 0) return null
    // Prefer running track over crossovers.
    const next = fresh.find(e => !e.id.includes('xover')) ?? fresh[0]
    chain.push(next)
    seen.add(next.id)
    cur = next
  }
  return null
}

// ── Chainage arithmetic ─────────────────────────────────────────────────────

export function wrapC(c: number, L: number): number {
  if (!(L > 0)) return c
  let r = c % L
  if (r < 0) r += L
  if (r >= L) r -= L
  return r
}

/** Distance travelling forward along the ring from a to b, in [0, L). */
export function fwdDist(a: number, b: number, L: number): number {
  let d = (b - a) % L
  if (d < 0) d += L
  return d
}

/** Signed shortest-arc difference b - a, in (-L/2, L/2]. */
export function signedDelta(a: number, b: number, L: number): number {
  let d = fwdDist(a, b, L)
  if (d > L / 2) d -= L
  return d
}

/** Index of the segment containing (wrapped) chainage c. */
export function segIndexAt(idx: RouteIndex, c: number): number {
  const s = idx.starts
  let lo = 0
  let hi = s.length - 1
  if (c < s[0]) return s.length - 1 // before first start → belongs to the wrap tail
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s[mid] <= c) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Chainage of (edge, fraction) if the edge is on the route. */
export function chainageOfEdgeOffset(idx: RouteIndex, edgeId: string, offset: number): number | null {
  const seg = idx.segByEdge.get(edgeId)
  if (!seg) return null
  const u = Math.max(0, Math.min(1, Number.isFinite(offset) ? offset : 0))
  return wrapC(seg.startM + u * seg.lengthM, idx.lengthM)
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** World point at arc fraction u ∈ [0,1] of a segment; writes into out. Returns vertex index i (point lies on [i-1, i]). */
function segPointAtU(seg: RouteSeg, u: number, out: RoutePoint): number {
  const pts = seg.pts
  const n = pts.length
  if (n === 1 || seg.worldLen <= 0) {
    out.x = pts[0].x
    out.y = pts[0].y
    return Math.min(1, n - 1)
  }
  const target = Math.max(0, Math.min(1, u)) * seg.worldLen
  const cum = seg.cum
  // binary search first vertex with cum >= target (i ≥ 1)
  let lo = 1
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] >= target) hi = mid
    else lo = mid + 1
  }
  const i = lo
  const a = pts[i - 1]
  const b = pts[i]
  const segLen = cum[i] - cum[i - 1]
  const t = segLen > 0 ? (target - cum[i - 1]) / segLen : 0
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  out.angle = Math.atan2(b.y - a.y, b.x - a.x)
  return i
}

/** Tangent of a segment's polyline near vertex i (skips zero-length pieces). */
function segAngleNear(seg: RouteSeg, i: number): number | null {
  const pts = seg.pts
  for (let k = i; k < pts.length; k++) {
    const a = pts[k - 1]
    const b = pts[k]
    if (a && b && (a.x !== b.x || a.y !== b.y)) return Math.atan2(b.y - a.y, b.x - a.x)
  }
  for (let k = i - 1; k >= 1; k--) {
    const a = pts[k - 1]
    const b = pts[k]
    if (a.x !== b.x || a.y !== b.y) return Math.atan2(b.y - a.y, b.x - a.x)
  }
  return null
}

/** World point + tangent at chainage c. Writes into `out` and returns it. */
export function pointAt(idx: RouteIndex, c: number, out: RoutePoint = { x: 0, y: 0, angle: 0 }): RoutePoint {
  const cc = wrapC(c, idx.lengthM)
  const si = segIndexAt(idx, cc)
  const seg = idx.segs[si]
  const u = seg.lengthM > 0 ? (cc - seg.startM) / seg.lengthM : 0
  const vi = segPointAtU(seg, u, out)
  if (seg.worldLen <= 0 || (seg.pts[vi - 1] && seg.pts[vi - 1].x === seg.pts[vi].x && seg.pts[vi - 1].y === seg.pts[vi].y)) {
    // degenerate piece: borrow the tangent from this or the neighbouring segments
    let ang = segAngleNear(seg, Math.max(1, vi))
    if (ang == null) {
      const nxt = idx.segs[(si + 1) % idx.segs.length]
      ang = segAngleNear(nxt, 1)
    }
    if (ang == null) {
      const prv = idx.segs[(si - 1 + idx.segs.length) % idx.segs.length]
      ang = segAngleNear(prv, prv.pts.length - 1)
    }
    out.angle = ang ?? 0
  }
  return out
}

const _tmp: RoutePoint = { x: 0, y: 0, angle: 0 }

/**
 * Append the world polyline from chainage c0 forward for `len` metres to `out` as flat
 * [x0, y0, x1, y1, …]. Includes interior vertices and edge boundaries; wraps at the ring end.
 * Returns the number of points appended.
 */
export function appendRange(idx: RouteIndex, c0: number, len: number, out: number[]): number {
  const L = idx.lengthM
  let remaining = Math.max(0, Math.min(len, L))
  let c = wrapC(c0, L)
  let si = segIndexAt(idx, c)
  let count = 0
  let seg = idx.segs[si]
  let u0 = seg.lengthM > 0 ? (c - seg.startM) / seg.lengthM : 0
  if (u0 < 0) u0 = 0 // c before first start (gap) — clamp
  segPointAtU(seg, u0, _tmp)
  out.push(_tmp.x, _tmp.y)
  count++
  let guard = 0
  while (remaining > 1e-9 && guard++ < idx.segs.length + 2) {
    const segEnd = seg.startM + seg.lengthM
    const avail = Math.max(0, segEnd - c)
    const take = Math.min(avail, remaining)
    const u1 = seg.lengthM > 0 ? (c + take - seg.startM) / seg.lengthM : 1
    if (seg.worldLen > 0) {
      const w0 = u0 * seg.worldLen
      const w1 = u1 * seg.worldLen
      for (let i = 1; i < seg.pts.length - 1; i++) {
        const w = seg.cum[i]
        if (w > w0 && w < w1) { out.push(seg.pts[i].x, seg.pts[i].y); count++ }
      }
    }
    segPointAtU(seg, u1, _tmp)
    out.push(_tmp.x, _tmp.y)
    count++
    remaining -= take
    c += take
    if (remaining > 1e-9) {
      si = (si + 1) % idx.segs.length
      seg = idx.segs[si]
      c = seg.startM
      u0 = 0
      // boundary point of next segment (usually identical to previous end — skip duplicates)
      const p = seg.pts[0]
      const n = out.length
      if (out[n - 2] !== p.x || out[n - 1] !== p.y) { out.push(p.x, p.y); count++ }
    }
  }
  return count
}
