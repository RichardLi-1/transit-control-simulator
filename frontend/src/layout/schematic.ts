/**
 * Schematic line-diagram layout: topology → topology.
 *
 * Repositions node coordinates, edge `points` and signal `position`s into a clean U, like the
 * official TTC map: Vaughan MC top-left, down the University–Spadina branch, a flat Union loop
 * at the bottom, up the Yonge branch to Finch top-right. Straight runs and 45° bends only; the two
 * tracks are parallel offsets of one spine.
 *
 * The diagram is sized for the screen it will be shown on (`LayoutTarget`, the usable map area
 * in CSS px): one world unit ≈ one px at fit zoom, so station spacing, track separation and
 * label clearances are designed in pixels. Station spacing follows real distance (compressed,
 * with a minimum so labels never collide) and is scaled to fill the height; the Union loop is
 * widened to fill the width, so the two branches sit well apart with room on the inner side for
 * signals, yards and speed tags. Cross-streets are aligned between the branches
 * (St George ↔ Bloor–Yonge, St Clair West ↔ St Clair, Eglinton West ↔ Eglinton, …).
 *
 * Portrait screens get a narrower variant (Vaughan extension drawn straight down, stronger
 * distance compression) so the whole line still fits with every station named.
 *
 * Never changes ids, `length`/`length_m`, `edge_id`/`offset` semantics, route, stations, etc. —
 * only geometry. Chainage → map position stays valid because positions are fractions along each
 * edge's polyline.
 */
import type { Topology, TopologyEdge, TopologyNode, TopologySignal, Vec2 } from '../types/domain'
import { interpolatePolyline, polylineLength } from '../utils/geometry'
import { setLayoutMeta, stationPairs, stationPriority, nameKey, type LayoutMeta, type StationMeta } from './meta'
import { stationLabelBoxes, approxMeasure } from './labels'

export type Dir = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'
const ORDER: Dir[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const R = Math.SQRT1_2
const VEC: Record<Dir, Vec2> = {
  N: { x: 0, y: -1 }, NE: { x: R, y: -R }, E: { x: 1, y: 0 }, SE: { x: R, y: R },
  S: { x: 0, y: 1 }, SW: { x: -R, y: R }, W: { x: -1, y: 0 }, NW: { x: -R, y: -R },
}

/** A run of stations sharing one ob travel direction, starting at station `from`. */
export interface RunSpec {
  from: string
  dir: Dir
  /** The bottom loop (Union): its length is set by the layout width, not by distance. */
  loop?: boolean
}

export interface SchematicConfig {
  /** Distance between the two track centre lines (world units ≈ px at fit). */
  trackSep: number
  /** Spacing ∝ (distance / shortest)^exponent, i.e. roughly proportional but compressed. */
  exponent: number
  /** Cap on spacing as a multiple of the minimum spacing. */
  maxRatio: number
  /** Length of each 45° piece inside a 90° turn. */
  chamfer: number
  /** Minimum length of a segment that contains a 90° turn (other than the loop). */
  turnMinSpacing: number
  /** Terminal turn-back tail length beyond the platform. */
  tail: number
  /** Straight piece between the last platform of a branch and the loop's 45° chamfer. */
  loopDrop: number
  /** Minimum horizontal gap between the two branches' centre lines. */
  minGap: number
  /** Maximum gap, as a fraction of the usable height. */
  maxGapFrac: number
  /** Minimum / maximum station spacing the size solver may choose. */
  minSpacing: number
  maxSpacing: number
  /** Line shape. */
  runs: RunSpec[]
  /** Station pairs (branch 1, branch 2) drawn at the same height. */
  align: [string, string][]
}

/** Usable map area at fit, CSS px (canvas minus floating chrome). */
export interface LayoutTarget { width: number; height: number }

/** Line 1 shape for landscape screens, modelled on the official TTC map. */
export const YUS_RUNS: RunSpec[] = [
  { from: 'Vaughan MC', dir: 'SE' },      // Spadina extension, diagonal
  { from: 'Sheppard West', dir: 'S' },    // Allen Rd corridor
  { from: 'St Clair West', dir: 'SE' },   // diagonal down to Bloor
  { from: 'Spadina', dir: 'S' },          // Spadina / University Ave
  { from: 'Union', dir: 'E', loop: true },// the loop
  { from: 'King', dir: 'N' },             // Yonge St, straight up to Finch
]

/** Portrait: the Vaughan extension straight down, so the U stays narrow. */
export const YUS_RUNS_NARROW: RunSpec[] = [
  { from: 'Vaughan MC', dir: 'S' },
  { from: 'Dupont', dir: 'SE' },
  { from: 'Spadina', dir: 'S' },
  { from: 'Union', dir: 'E', loop: true },
  { from: 'King', dir: 'N' },
]

const YUS_ALIGN: [string, string][] = [
  ['St George', 'Bloor–Yonge'],
  ['St Clair West', 'St Clair'],
  ['Eglinton West', 'Eglinton'],
  ['Lawrence West', 'Lawrence'],
  ['Sheppard West', 'Sheppard–Yonge'],
]

export const SCHEMATIC_WIDE: SchematicConfig = {
  trackSep: 10,
  exponent: 0.55,
  maxRatio: 2.8,
  chamfer: 14,
  turnMinSpacing: 38,
  tail: 12,
  loopDrop: 10,
  minGap: 120,
  maxGapFrac: 0.62,
  minSpacing: 19,
  maxSpacing: 64,
  runs: YUS_RUNS,
  align: YUS_ALIGN,
}

export const SCHEMATIC_NARROW: SchematicConfig = {
  ...SCHEMATIC_WIDE,
  exponent: 0.45,
  maxRatio: 2.0,
  minGap: 56,
  maxGapFrac: 0.3,
  minSpacing: 18,
  runs: YUS_RUNS_NARROW,
}

/** Very narrow screens: both branches straight, the tightest gap that still holds signals. */
export const YUS_RUNS_STRAIGHT: RunSpec[] = [
  { from: 'Vaughan MC', dir: 'S' },
  { from: 'Union', dir: 'E', loop: true },
  { from: 'King', dir: 'N' },
]

export const SCHEMATIC_STRAIGHT: SchematicConfig = {
  ...SCHEMATIC_NARROW,
  minGap: 40,
  runs: YUS_RUNS_STRAIGHT,
}

/** Default target (16:10 desktop with a right-hand inspector): used when nothing is measured. */
export const DEFAULT_TARGET: LayoutTarget = { width: 1120, height: 812 }

/** Landscape vs portrait variant for a usable map area. */
export function schematicVariantFor(target: LayoutTarget): 'wide' | 'narrow' {
  return target.width / Math.max(1, target.height) < 0.85 ? 'narrow' : 'wide'
}

/** Variants to try for a target, best first (the first one that fits is used). */
export function schematicConfigsFor(target: LayoutTarget): SchematicConfig[] {
  return schematicVariantFor(target) === 'narrow'
    ? [SCHEMATIC_NARROW, SCHEMATIC_STRAIGHT]
    : [SCHEMATIC_WIDE, SCHEMATIC_NARROW, SCHEMATIC_STRAIGHT]
}

/** Mirrors `Viewport.fitToBounds(…, 0.1)`: padding on each side of the fitted bounds. */
export function fitPadding(target: LayoutTarget): number {
  return Math.min(target.width, target.height) * 0.05
}

function genericRuns(names: string[]): RunSpec[] {
  const n = names.length
  const mid = Math.floor((n - 1) / 2)
  return [
    { from: names[0], dir: 'S' },
    { from: names[mid], dir: 'E', loop: true },
    { from: names[Math.min(n - 1, mid + 1)], dir: 'N' },
  ]
}

function add(a: Vec2, b: Vec2, k = 1): Vec2 { return { x: a.x + b.x * k, y: a.y + b.y * k } }
function lerp(a: Vec2, b: Vec2, t: number): Vec2 { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } }
function right(d: Vec2): Vec2 { return { x: -d.y, y: d.x } }
function samePt(a: Vec2, b: Vec2, eps = 1e-6): boolean { return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps }
function round(p: Vec2): Vec2 { return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 } }

/** 45° steps from a to b, shortest way round, excluding a and b. */
function turnPath(a: Dir, b: Dir): Dir[] {
  const ia = ORDER.indexOf(a)
  const ib = ORDER.indexOf(b)
  let diff = (ib - ia + 8) % 8
  const step = diff <= 4 ? 1 : -1
  if (step < 0) diff = 8 - diff
  const mids: Dir[] = []
  for (let k = 1; k < diff; k++) mids.push(ORDER[(ia + step * k + 8) % 8])
  return mids
}

interface Spine {
  /** Vertex positions on the centre line. */
  verts: Vec2[]
  /** Arc length at each vertex. */
  vertS: number[]
  /** Direction of piece k (verts[k] → verts[k+1]). */
  dirs: Dir[]
  /** Arc length of each station. */
  stationS: number[]
  /** Centre-line position of each station. */
  stationP: Vec2[]
}

/** Explicit straight lengths [before, after] the 45° pieces of a turn segment. */
type Split = (i: number) => [number, number] | null

function buildSpine(spacing: number[], stationDir: Dir[], cfg: SchematicConfig, split: Split): Spine {
  const verts: Vec2[] = [{ x: 0, y: 0 }]
  const vertS = [0]
  const dirs: Dir[] = []
  const stationS = [0]
  const stationP: Vec2[] = [{ x: 0, y: 0 }]
  let p: Vec2 = { x: 0, y: 0 }
  let acc = 0
  const push = (dir: Dir, len: number) => {
    if (len <= 1e-9) return
    p = add(p, VEC[dir], len)
    acc += len
    const last = dirs.length - 1
    if (last >= 0 && dirs[last] === dir) {
      // extend the previous collinear piece
      verts[verts.length - 1] = p
      vertS[vertS.length - 1] = acc
    } else {
      verts.push(p)
      vertS.push(acc)
      dirs.push(dir)
    }
  }
  for (let i = 0; i < spacing.length; i++) {
    const a = stationDir[i]
    const b = stationDir[i + 1]
    const s = spacing[i]
    if (a === b) {
      push(a, s)
    } else {
      const mids = turnPath(a, b)
      const fixed = split(i)
      if (fixed) {
        push(a, fixed[0])
        for (const m of mids) push(m, cfg.chamfer)
        push(b, fixed[1])
      } else if (mids.length === 0) {
        push(a, s / 2)
        push(b, s / 2)
      } else {
        const ss = Math.max(s, cfg.turnMinSpacing, mids.length * cfg.chamfer + 8)
        const rest = (ss - mids.length * cfg.chamfer) / 2
        push(a, rest)
        for (const m of mids) push(m, cfg.chamfer)
        push(b, rest)
      }
    }
    stationS.push(acc)
    stationP.push(p)
  }
  return { verts, vertS, dirs, stationS, stationP }
}

/** Parallel offset of the spine (miter joins). h > 0 = right of ob travel (the ob track). */
function offsetVerts(sp: Spine, h: number): Vec2[] {
  return sp.verts.map((v, k) => {
    const nIn = k > 0 ? right(VEC[sp.dirs[k - 1]]) : null
    const nOut = k < sp.dirs.length ? right(VEC[sp.dirs[k]]) : null
    const a = nIn ?? nOut!
    const b = nOut ?? nIn!
    const m = { x: a.x + b.x, y: a.y + b.y }
    const L = Math.hypot(m.x, m.y) || 1
    const mu = { x: m.x / L, y: m.y / L }
    const scale = 1 / Math.max(0.2, mu.x * a.x + mu.y * a.y)
    return add(v, mu, h * scale)
  })
}

function pieceAt(sp: Spine, s: number): number {
  const last = sp.dirs.length - 1
  for (let k = 0; k <= last; k++) if (s <= sp.vertS[k + 1] + 1e-9) return k
  return last
}

/** Point on the track offset h from the spine at arc length s (exact perpendicular offset). */
function pointAt(sp: Spine, h: number, s: number): Vec2 {
  const total = sp.vertS[sp.vertS.length - 1]
  let k: number
  let base: Vec2
  if (s <= 0) {
    k = 0
    base = add(sp.verts[0], VEC[sp.dirs[0]], s)
  } else if (s >= total) {
    k = sp.dirs.length - 1
    base = add(sp.verts[sp.verts.length - 1], VEC[sp.dirs[k]], s - total)
  } else {
    k = pieceAt(sp, s)
    const len = sp.vertS[k + 1] - sp.vertS[k]
    base = lerp(sp.verts[k], sp.verts[k + 1], len > 0 ? (s - sp.vertS[k]) / len : 0)
  }
  return add(base, right(VEC[sp.dirs[k]]), h)
}

/** Polyline on one track between arc lengths a < b (includes bend vertices). */
function subPolyline(sp: Spine, off: Vec2[], h: number, a: number, b: number): Vec2[] {
  const pts: Vec2[] = [pointAt(sp, h, a)]
  for (let k = 1; k < sp.verts.length - 1; k++) {
    const s = sp.vertS[k]
    if (s > a + 1e-6 && s < b - 1e-6) pts.push(off[k])
  }
  const end = pointAt(sp, h, b)
  if (!samePt(pts[pts.length - 1], end)) pts.push(end)
  return pts.map(round)
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]
}

/** Nearest (edge, fraction) on a set of polylines for a world point — fallback mapping. */
function locateOnEdges(p: Vec2, edges: TopologyEdge[]): { edge: TopologyEdge; t: number } | null {
  let best: { edge: TopologyEdge; t: number; d: number } | null = null
  for (const e of edges) {
    const total = polylineLength(e.points)
    if (total <= 0) continue
    let acc = 0
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]
      const b = e.points[i]
      const abx = b.x - a.x
      const aby = b.y - a.y
      const L2 = abx * abx + aby * aby
      const L = Math.sqrt(L2)
      const u = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2)) : 0
      const d = Math.hypot(a.x + u * abx - p.x, a.y + u * aby - p.y)
      if (!best || d < best.d) best = { edge: e, t: (acc + u * L) / total, d }
      acc += L
    }
  }
  return best ? { edge: best.edge, t: best.t } : null
}

export interface SchematicResult {
  topology: Topology
  meta: LayoutMeta
  /** Chosen minimum station spacing and branch gap (world units ≈ px at fit). */
  spacing: number
  gap: number
}

export interface SchematicOptions {
  /** Usable map area (CSS px) the diagram should fill at fit zoom. */
  target?: LayoutTarget
  /** Override the variant picked for the target. */
  config?: SchematicConfig
}

/**
 * Lay out a topology as a schematic diagram. Returns the input unchanged if it doesn't use the
 * ob_<i>/ib_<i> station-pair convention.
 */
export function schematicLayout(src: Topology, opts: SchematicOptions = {}): Topology {
  return buildSchematic(src, opts)?.topology ?? src
}

interface Prepared {
  src: Topology
  n: number
  names: string[]
  /** Spacing factor per segment (≥ 1), from real distance. */
  factor: number[]
  stationDir: Dir[]
  /** Index of the loop station (-1 if none). */
  loop: number
  /** Aligned station index pairs (branch 1, branch 2), nearest the loop first. */
  anchors: [number, number][]
  /** Real fraction of each mid crossover's points along its ob edge (by crossover index). */
  xoverT: Map<number, number>
  /**
   * Signals protecting each mid crossover (edge offsets on ob_i_i+1 / ib_i+1_i): a train must
   * pass the signal before it reaches the points, in both directions.
   */
  xoverSig: Map<number, { ob?: number; ib?: number }>
}

function prepare(src: Topology, cfg: SchematicConfig): Prepared | null {
  const pairs = stationPairs(src)
  if (!pairs) return null
  const { n, names } = pairs
  const edgeById = new Map(src.edges.map((e) => [e.id, e]))

  // ── spacing factors from real distance ──
  const obEdges = Array.from({ length: n - 1 }, (_, i) => edgeById.get(`ob_${i}_${i + 1}`))
  const allMetres = obEdges.every((e) => e && Number.isFinite(e.length_m) && (e.length_m as number) > 0)
  const dist = obEdges.map((e, i) => {
    if (!e) {
      const a = pairs.ob[i]
      const b = pairs.ob[i + 1]
      return Math.hypot(b.x - a.x, b.y - a.y) || 1
    }
    return allMetres ? (e.length_m as number) : (polylineLength(e.points) || 1)
  })
  const dRef = quantile(dist, 0.1) || 1
  const factor = dist.map((d) => Math.min(cfg.maxRatio, Math.max(1, Math.pow(d / dRef, cfg.exponent))))

  // ── run directions per station ──
  const keyed = names.map(nameKey)
  let runs = cfg.runs
  let resolved = runs.map((r) => ({ ...r, at: keyed.indexOf(nameKey(r.from)) }))
  if (resolved.some((r) => r.at < 0) || resolved[0].at !== 0) {
    runs = genericRuns(names)
    resolved = runs.map((r) => ({ ...r, at: keyed.indexOf(nameKey(r.from)) }))
  }
  resolved.sort((a, b) => a.at - b.at)
  const stationDir: Dir[] = names.map((_, i) => {
    let d = resolved[0].dir
    for (const r of resolved) if (r.at <= i) d = r.dir
    return d
  })
  const loopRun = resolved.find((r) => r.loop)
  const loop = loopRun && loopRun.at > 0 && loopRun.at < n - 1 ? loopRun.at : -1

  const anchors: [number, number][] = []
  if (loop > 0) {
    for (const [a, b] of cfg.align) {
      const ia = keyed.indexOf(nameKey(a))
      const ib = keyed.indexOf(nameKey(b))
      if (ia >= 0 && ia < loop - 1 && ib > loop + 1) anchors.push([ia, ib])
    }
    anchors.sort((p, q) => q[0] - p[0])
    // keep only monotone pairs (each further from the loop on both branches)
    for (let k = anchors.length - 1; k > 0; k--) {
      if (!(anchors[k][0] < anchors[k - 1][0] && anchors[k][1] > anchors[k - 1][1])) anchors.splice(k, 1)
    }
  }

  // ── where the mid crossovers really are (fraction along their ob edge) ──
  const xoverT = new Map<number, number>()
  const segByEdge = new Map((src.route?.segments ?? []).map((s) => [s.edge_id, s]))
  for (const sw of src.switches ?? []) {
    const m = /^xover_mid_(\d+)$/.exec(sw.reverse_edge_id)
    const pm = (sw as { points_m?: number[] }).points_m
    if (!m || !pm?.length) continue
    const seg = segByEdge.get(sw.normal_edge_id)
    if (!seg || !(seg.length_m > 0)) continue
    const t = (pm[0] - seg.start_m) / seg.length_m
    if (t > 0 && t < 1) xoverT.set(Number(m[1]), t)
  }
  const xoverSig = new Map<number, { ob?: number; ib?: number }>()
  for (const sig of src.signals ?? []) {
    const swId = (sig as { switch_id?: string | null }).switch_id
    const m = swId ? /^sw_mid_(\d+)$/.exec(swId) : null
    if (!m || !Number.isFinite(sig.offset)) continue
    const i = Number(m[1])
    const entry = xoverSig.get(i) ?? {}
    if (sig.edge_id === `ob_${i}_${i + 1}`) entry.ob = Math.max(entry.ob ?? 0, sig.offset)
    else if (sig.edge_id === `ib_${i + 1}_${i}`) entry.ib = Math.max(entry.ib ?? 0, sig.offset)
    xoverSig.set(i, entry)
  }

  return { src, n, names, factor, stationDir, loop, anchors, xoverT, xoverSig }
}

/** Spine for a given minimum spacing and loop half-width, with cross-street alignment. */
function solveSpine(p: Prepared, cfg: SchematicConfig, m: number, loopHalf: number): Spine {
  const { n, loop, stationDir } = p
  const spacing = p.factor.map((f) => f * m)
  const lead = Math.max(2, loopHalf - cfg.chamfer * R)
  const split: Split = (i) => {
    if (loop < 0) return null
    if (i === loop - 1) return [cfg.loopDrop, lead]
    if (i === loop) return [lead, cfg.loopDrop]
    return null
  }
  let sp = buildSpine(spacing, stationDir, cfg, split)
  if (loop < 0 || !p.anchors.length) return sp

  // Align anchor pairs: within each section, stretch the shorter branch (never shrink).
  const y = (i: number) => sp.stationP[i].y
  let prevA = loop - 1
  let prevB = loop + 1
  for (const [a, b] of p.anchors) {
    for (let iter = 0; iter < 4; iter++) {
      const extA = y(prevA) - y(a)
      const extB = y(prevB) - y(b)
      if (extA <= 1 || extB <= 1) break
      const diff = extA - extB
      if (Math.abs(diff) < 0.05) break
      if (diff > 0) {
        const k = Math.min(1.8, extA / extB)
        for (let i = prevB; i < b; i++) spacing[i] *= k
      } else {
        const k = Math.min(1.8, extB / extA)
        for (let i = a; i < prevA; i++) spacing[i] *= k
      }
      sp = buildSpine(spacing, stationDir, cfg, split)
    }
    prevA = a
    prevB = b
  }
  void n
  return sp
}

interface Built {
  topology: Topology
  meta: LayoutMeta
  /** Bounds of geometry + station labels at zoom 1. */
  box: { minX: number; minY: number; maxX: number; maxY: number }
}

function assemble(p: Prepared, cfg: SchematicConfig, sp: Spine, labelWidth: number): Built {
  const { src, n, names } = p
  const h = cfg.trackSep / 2
  const offOb = offsetVerts(sp, h)
  const offIb = offsetVerts(sp, -h)

  const S = sp.stationS
  const obPt = (s: number) => round(pointAt(sp, h, s))
  const ibPt = (s: number) => round(pointAt(sp, -h, s))
  const cPt = (s: number) => round(pointAt(sp, 0, s))

  // ── nodes ──
  const nodePos = new Map<string, Vec2>()
  for (let i = 0; i < n; i++) {
    nodePos.set(`ob_${i}`, obPt(S[i]))
    nodePos.set(`ib_${i}`, ibPt(S[i]))
  }

  // ── edges ──
  const revenueSrc = src.edges.filter((e) => /^(ob|ib)_\d+_\d+$/.test(e.id))
  const newPoints = new Map<string, Vec2[]>()
  for (let i = 0; i < n - 1; i++) {
    newPoints.set(`ob_${i}_${i + 1}`, subPolyline(sp, offOb, h, S[i], S[i + 1]))
    newPoints.set(`ib_${i + 1}_${i}`, subPolyline(sp, offIb, -h, S[i], S[i + 1]).reverse())
  }

  // Terminal turn-backs: a short tail beyond the platform with a pointed 45° cap.
  const startTail = { x: -VEC[sp.dirs[0]].x, y: -VEC[sp.dirs[0]].y }
  const endTail = VEC[sp.dirs[sp.dirs.length - 1]]
  const T = cfg.tail
  const cap = (from: Vec2, centre: Vec2, to: Vec2, tail: Vec2): Vec2[] =>
    [from, add(from, tail, T), add(centre, tail, T + h), add(to, tail, T), to].map(round)
  /** Spine arc length of the track point at fraction f along an edge polyline (lo ≤ arc ≤ hi). */
  const arcAt = (pts: Vec2[], s0: number, s1: number, f: number): number => {
    const P = interpolatePolyline(pts, Math.max(0, Math.min(1, f)))
    const lo = Math.min(s0, s1)
    const hi = Math.max(s0, s1)
    let best = s0 + f * (s1 - s0)
    let bd = Infinity
    for (let k = 0; k < sp.dirs.length; k++) {
      if (sp.vertS[k + 1] < lo - 1e-6 || sp.vertS[k] > hi + 1e-6) continue
      const v = VEC[sp.dirs[k]]
      const raw = sp.vertS[k] + (P.x - sp.verts[k].x) * v.x + (P.y - sp.verts[k].y) * v.y
      const sc = Math.max(Math.max(lo, sp.vertS[k]), Math.min(Math.min(hi, sp.vertS[k + 1]), raw))
      const q = pointAt(sp, 0, sc)
      const d = Math.abs(Math.hypot(P.x - q.x, P.y - q.y) - h) + Math.abs(raw - sc)
      if (d < bd) { bd = d; best = sc }
    }
    return best
  }
  const xoverPoints = (e: TopologyEdge): Vec2[] | null => {
    if (e.id === 'xover_start' || (e.from_node === 'ib_0' && e.to_node === 'ob_0')) {
      return cap(nodePos.get('ib_0')!, cPt(S[0]), nodePos.get('ob_0')!, startTail)
    }
    const last = n - 1
    if (e.id === 'xover_end' || (e.from_node === `ob_${last}` && e.to_node === `ib_${last}`)) {
      return cap(nodePos.get(`ob_${last}`)!, cPt(S[last]), nodePos.get(`ib_${last}`)!, endTail)
    }
    const mid = /^xover_mid_(\d+)$/.exec(e.id)
    if (mid) {
      const idx = Number(mid[1])
      if (idx < 0 || idx >= n - 1) return null
      // A 45° diagonal (ob → ib, in ob travel direction) on a straight piece, clear of both
      // platforms. Anchored where the points really are when known, else centred.
      const len = S[idx + 1] - S[idx]
      // half the diagonal's along-track length: 45° normally (= h)
      let ha = h
      // clear of both platforms where possible
      const margin = Math.max(7, cfg.trackSep * 0.8)
      let a = S[idx] + margin + ha
      let b = S[idx + 1] - margin - ha
      // the real points are directly across from each other at fraction t: centre the diagonal there
      const t = p.xoverT.get(idx)
      const want = t != null ? S[idx] + t * len : (a + b) / 2
      // never past a protecting signal (a train must meet the signal before the points). This
      // outranks platform clearance; where the signals leave less than a 45° diagonal's length
      // (tight downtown spacing) the diagonal gets steeper, never longer than the gap.
      const sig = p.xoverSig.get(idx)
      if (sig) {
        const obPts = newPoints.get(`ob_${idx}_${idx + 1}`)
        const ibPts = newPoints.get(`ib_${idx + 1}_${idx}`)
        const sLo = sig.ob != null && obPts ? arcAt(obPts, S[idx], S[idx + 1], sig.ob) + 1 : S[idx] + 2
        const sHi = sig.ib != null && ibPts ? arcAt(ibPts, S[idx + 1], S[idx], sig.ib) - 1 : S[idx + 1] - 2
        if (sHi - sLo < 2 * ha) ha = Math.max(h / 2, (sHi - sLo) / 2)
        const lo = sLo + ha
        const hi = sHi - ha
        if (lo > hi) {
          a = b = (lo + hi) / 2
        } else if (Math.max(a, lo) <= Math.min(b, hi)) {
          a = Math.max(a, lo)
          b = Math.min(b, hi)
        } else {
          a = lo
          b = hi
        }
      }
      let best: [number, number] = [a, b]
      let bestScore = Infinity
      for (let k = 0; k < sp.dirs.length; k++) {
        // keep both diagonal ends on this straight piece of BOTH offset tracks (the inner
        // track's piece ends up to h short of the spine vertex at a bend)
        const lo = Math.max(a, sp.vertS[k] + (k > 0 ? ha + h : ha))
        const hi = Math.min(b, sp.vertS[k + 1] - (k < sp.dirs.length - 1 ? ha + h : ha))
        if (hi < lo) continue
        const c = Math.max(lo, Math.min(hi, want))
        const score = Math.abs(c - want)
        if (score < bestScore) { bestScore = score; best = [c, c] }
      }
      if (!Number.isFinite(bestScore)) best = [(a + b) / 2, (a + b) / 2]
      const c = best[0]
      return [obPt(c - ha), ibPt(c + ha)]
    }
    return null
  }

  const edges: TopologyEdge[] = src.edges.map((e) => {
    let pts = newPoints.get(e.id) ?? xoverPoints(e)
    if (!pts) {
      // Unknown edge (e.g. a yard lead): map each point onto the new revenue geometry.
      pts = e.points.map((q) => {
        const hit = locateOnEdges(q, revenueSrc)
        if (!hit) return q
        const np = newPoints.get(hit.edge.id)
        return np ? round(interpolatePolyline(np, hit.t)) : q
      })
      const na = nodePos.get(e.from_node)
      const nb = nodePos.get(e.to_node)
      if (na && pts.length) pts[0] = na
      if (nb && pts.length) pts[pts.length - 1] = nb
    }
    newPoints.set(e.id, pts)
    return { ...e, points: pts }
  })

  const nodes: TopologyNode[] = src.nodes.map((node) => {
    let q = nodePos.get(node.id)
    if (!q) {
      const hit = locateOnEdges(node, revenueSrc)
      const np = hit ? newPoints.get(hit.edge.id) : null
      q = hit && np ? round(interpolatePolyline(np, hit.t)) : { x: node.x, y: node.y }
    }
    return { ...node, x: q.x, y: q.y }
  })

  const signals: TopologySignal[] = src.signals.map((sig) => {
    const pts = newPoints.get(sig.edge_id)
    if (pts) return { ...sig, position: round(interpolatePolyline(pts, sig.offset)) }
    const hit = locateOnEdges(sig.position, revenueSrc)
    const np = hit ? newPoints.get(hit.edge.id) : null
    return { ...sig, position: hit && np ? round(interpolatePolyline(np, hit.t)) : sig.position }
  })

  // ── station metadata ──
  const stations: StationMeta[] = names.map((name, i) => {
    const k = pieceAt(sp, S[i])
    const along = VEC[sp.dirs[Math.min(k, sp.dirs.length - 1)]]
    return {
      index: i,
      name,
      center: cPt(S[i]),
      along,
      outward: right(along),
      ...stationPriority(i, n, name),
    }
  })
  const meta: LayoutMeta = { kind: 'schematic', trackSep: cfg.trackSep, stations }

  // ── bounds: geometry + labels at zoom 1 ──
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const e of edges) for (const q of e.points) grow(q.x, q.y)
  const unit = { width: labelWidth, height: 900, camera: { zoom: 1 }, worldToScreen: (x: number, y: number): [number, number] => [x, y] }
  for (const bx of stationLabelBoxes(meta, unit, approxMeasure)) {
    grow(bx.x, bx.y)
    grow(bx.x + bx.w, bx.y + bx.h)
  }
  const box = { minX, minY, maxX, maxY }
  const PAD = 4
  const topology: Topology = {
    ...src,
    nodes,
    edges,
    signals,
    bounds: { min_x: minX - PAD, min_y: minY - PAD, max_x: maxX + PAD, max_y: maxY + PAD },
  }
  return { topology, meta, box }
}

interface Solved { built: Built; spacing: number; half: number; fits: boolean; scale: number }

/** Size one variant for the target: largest spacing that fits, then widen the loop. */
function solve(src: Topology, cfg: SchematicConfig, target: LayoutTarget): Solved | null {
  const p = prepare(src, cfg)
  if (!p) return null
  // Area the bounds may fill at zoom 1 (Viewport pads the fit by 5 % of the short side).
  const pad = fitPadding(target)
  const W = Math.max(200, target.width - pad * 2) - 8
  const H = Math.max(200, target.height - pad * 2) - 8
  const gMinHalf = cfg.minGap / 2
  const build = (m: number, half: number) => assemble(p, cfg, solveSpine(p, cfg, m, half), target.width)
  const size = (b: Built) => ({ w: b.box.maxX - b.box.minX, h: b.box.maxY - b.box.minY })

  // 1 ── largest station spacing whose diagram (with the narrowest loop) fits the area.
  let lo = cfg.minSpacing
  let hi = cfg.maxSpacing
  if (p.loop >= 0) {
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) / 2
      const s = size(build(m, gMinHalf))
      if (s.w <= W && s.h <= H) lo = m
      else hi = m
    }
  } else {
    lo = Math.max(cfg.minSpacing, 24)
  }
  const m = lo
  // 2 ── widen the loop into the spare width (capped, so very wide screens keep a sane U).
  let half = gMinHalf
  const narrowest = size(build(m, gMinHalf))
  if (p.loop >= 0) half = Math.max(gMinHalf, Math.min(gMinHalf + (W - narrowest.w) / 2, (cfg.maxGapFrac * H) / 2))
  const built = build(m, half)
  const s = size(built)
  const scale = Math.min(1, W / Math.max(1, s.w), H / Math.max(1, s.h))
  return { built, spacing: m, half, fits: s.w <= W + 0.5 && s.h <= H + 0.5, scale }
}

export function buildSchematic(src: Topology, opts: SchematicOptions = {}): SchematicResult | null {
  const target = opts.target ?? DEFAULT_TARGET
  const configs = opts.config ? [opts.config] : schematicConfigsFor(target)
  let best: Solved | null = null
  for (const cfg of configs) {
    const r = solve(src, cfg, target)
    if (!r) return null
    if (r.fits) { best = r; break }
    // nothing fits: keep the variant that needs the least zooming out
    if (!best || r.scale > best.scale) best = r
  }
  if (!best) return null
  const out = best.built
  setLayoutMeta(out.topology, out.meta)
  return { topology: out.topology, meta: out.meta, spacing: best.spacing, gap: best.half * 2 }
}
