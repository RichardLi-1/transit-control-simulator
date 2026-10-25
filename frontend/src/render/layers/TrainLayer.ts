/**
 * Trains: slim capsules drawn ALONG the track for their real length (min on-screen length so
 * they stay visible zoomed out), a pointed nose for direction, fill by state, a thin movement-
 * authority line from nose to EOA, and small id tags placed through the shared label pass.
 *
 * Positions come from the motion engine's interpolated frame (never the raw snapshot). This
 * layer writes each train's screen geometry back onto the frame so CanvasView hit-tests
 * exactly what was drawn. It is the last map layer, so it also flushes the label pass
 * (`motion/labels`): station names, yard names, signal names, speed tags and train ids are
 * resolved together in priority order and drawn on top of all geometry.
 */
import type { RuntimeState, Topology, TopologyEdge, TrainPosition } from '../../types/domain'
import type { Viewport } from '../Viewport'
import { COLORS } from '../../constants/colors'
import { slackTier } from '../../utils/safeZone'
import { interpolatePolyline, tangentAtT } from '../../utils/geometry'
import { appendRange, fwdDist, segIndexAt, wrapC, type RouteIndex } from '../../motion/routeIndex'
import type { MotionFrame, MotionTrain } from '../../motion/engine'
import { addLabel, flushLabels, LabelPriority, Obstacle, type Box } from '../../motion/labels'
import { MAP_TYPE, measureText, monoFont } from '../text'
import { worldPerMetre } from '../../layout/chainage'
import { previewTrain } from '../debugHook'

// ════════════════════════════════════════════════════════════════════════════
// Train palette & sizing — the ONE place to restyle trains. Values read COLORS at draw time
// so high-contrast mode keeps working.
//   running cyan · at platform white · stopped amber · emergency brake red (light outline) ·
//   out of service hollow grey — distinct in hue and lightness (colour-vision safe).
// ════════════════════════════════════════════════════════════════════════════
const PAL = {
  running: () => COLORS.TRAIN_FILL,
  arriving: () => COLORS.TRAIN_ARRIVING,
  dwelling: () => COLORS.TRAIN_DWELL,
  stopped: () => COLORS.TRAIN_STOPPED,
  ebrake: () => COLORS.TRAIN_EBRAKE,
  outOfService: () => COLORS.TRAIN_OUT_OF_SERVICE,
  /** knockout between body and track */
  outline: () => COLORS.TRAIN_BORDER,
  /** emergency-brake outline (shape cue in addition to colour) */
  alertOutline: () => COLORS.TEXT_1,
  ring: () => COLORS.TEXT_1,
  ringGap: () => COLORS.BACKGROUND,
  label: () => COLORS.TRAIN_ID_LABEL,
  labelDim: () => COLORS.HUD,
  labelBg: () => COLORS.SURFACE_1,
  labelBorder: () => COLORS.BORDER_STRONG,
  maBand: () => COLORS.MA_BAND,
  maEoa: () => COLORS.MA_EOA,
  maCaution: () => COLORS.CAUTION,
  maDanger: () => COLORS.DANGER,
  badgeHold: () => COLORS.CAUTION,
  badgeExpress: () => COLORS.INFO,
  badgeSkip: () => COLORS.TEXT_2,
}
const BODY_W = 6               // px — half-height 3 keeps ob/ib trains apart in the schematic
const MIN_BODY_PX = 13         // never shorter than this on screen
const LABEL_MIN_NATURAL_PX = 12 // show id tags once a train (at the layout's typical scale) is this long
const SPEED_MIN_NATURAL_PX = 30 // …and its km/h once zoomed in this far
const MA_W = 1.25              // nominal authority line (quiet)
const MA_W_CAUTION = 2.5
const MA_W_DANGER = 3
const MA_MAX_M = 6000
const LABEL_H = 15
const LABEL_PAD_X = 4
const LABEL_GAP = 4            // body edge → label
const LABEL_FONT = () => monoFont(MAP_TYPE.train, 500)
const SPEED_FONT = () => monoFont(MAP_TYPE.train, 400)
const BADGE_FONT = () => monoFont(MAP_TYPE.tiny, 600)
// ════════════════════════════════════════════════════════════════════════════

export interface TrainDrawOptions {
  showSafeZones: boolean
  showLabels: boolean
  hoveredId: string | null
  selectedId: string | null
}

// ── scratch buffers (no per-frame allocation) ──
const worldBuf: number[] = []
const bandBuf: number[] = []
const order: number[] = []
/** Label spot used last frame per train — tried first so labels don't hop between spots. */
const lastSpot = new Map<string, number>()

function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  return measureText(ctx, font, text)
}

function toScreen(vp: Viewport, world: number[], out: number[]): void {
  const { cx, cy, zoom } = vp.camera
  const hw = vp.width / 2
  const hh = vp.height / 2
  out.length = 0
  for (let i = 0; i < world.length; i += 2) {
    out.push((world[i] - cx) * zoom + hw, (world[i + 1] - cy) * zoom + hh)
  }
}

function polyLen(p: number[]): number {
  let s = 0
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
  return s
}

function strokePath(ctx: CanvasRenderingContext2D, p: number[]): void {
  ctx.beginPath()
  ctx.moveTo(p[0], p[1])
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
}

// ── outer side per route segment (away from the paired opposite-direction track) ──
interface SideInfo { sign: Int8Array; /** typical ob↔ib separation, world units */ sepWorld: number }
const outerCache = new WeakMap<RouteIndex, SideInfo>()
function outerSigns(route: RouteIndex): SideInfo {
  const hit = outerCache.get(route)
  if (hit) return hit
  const n = route.segs.length
  const s = new Int8Array(n).fill(1)
  const mid = new Float64Array(n * 2)
  const dir = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    const p = route.segs[i].pts
    const a = p[0]
    const b = p[p.length - 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    dir[i * 2] = (b.x - a.x) / len
    dir[i * 2 + 1] = (b.y - a.y) / len
    const m = interpolatePolyline(p, 0.5)
    mid[i * 2] = m.x
    mid[i * 2 + 1] = m.y
  }
  const pairD: number[] = []
  const pair = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let best = -1
    let bd = Infinity
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      if (dir[i * 2] * dir[j * 2] + dir[i * 2 + 1] * dir[j * 2 + 1] > -0.5) continue
      const d = Math.hypot(mid[i * 2] - mid[j * 2], mid[i * 2 + 1] - mid[j * 2 + 1])
      if (d < bd) { bd = d; best = j }
    }
    if (best >= 0) { pair[i] = best; pairD.push(bd) }
  }
  pairD.sort((a, b) => a - b)
  const median = pairD.length ? pairD[pairD.length >> 1] : Infinity
  for (let i = 0; i < n; i++) {
    const j = pair[i]
    if (j < 0) continue
    const d = Math.hypot(mid[i * 2] - mid[j * 2], mid[i * 2 + 1] - mid[j * 2 + 1])
    if (d > median * 3) continue
    // right-hand normal in y-down screen/world space: (-dy, dx)
    const nx = -dir[i * 2 + 1]
    const ny = dir[i * 2]
    s[i] = nx * (mid[i * 2] - mid[j * 2]) + ny * (mid[i * 2 + 1] - mid[j * 2 + 1]) >= 0 ? 1 : -1
  }
  const info = { sign: s, sepWorld: Number.isFinite(median) ? median : 0 }
  outerCache.set(route, info)
  return info
}

// ── legacy e-brake (injected events) ──
const ebrakeCache = new WeakMap<RuntimeState, Set<string>>()
function ebrakeTargets(rt: RuntimeState | null): Set<string> | null {
  if (!rt) return null
  let s = ebrakeCache.get(rt)
  if (!s) {
    s = new Set()
    for (const ev of rt.ops?.injected_events ?? []) {
      if (ev.active && ev.kind === 'emergency_brake' && ev.target_train_id) s.add(ev.target_train_id)
    }
    ebrakeCache.set(rt, s)
  }
  return s
}

const edgeMapCache = new WeakMap<Topology, Map<string, TopologyEdge>>()
function edgeMap(topology: Topology, route: RouteIndex | null): Map<string, TopologyEdge> {
  if (route && route.topology === topology) return route.edgeById
  let m = edgeMapCache.get(topology)
  if (!m) {
    m = new Map(topology.edges.map((e) => [e.id, e]))
    edgeMapCache.set(topology, m)
  }
  return m
}

function fillFor(t: TrainPosition, ebrake: boolean): string {
  if (ebrake || t.e_brake || t.stop_reason === 'emergency_brake') return PAL.ebrake()
  switch (t.state) {
    case 'dwelling': return PAL.dwelling()
    case 'stopped': return PAL.stopped()
    case 'arriving': return PAL.arriving()
    default: return PAL.running()
  }
}

function badgeFor(t: TrainPosition): { text: string; color: string } | null {
  if (t.dispatch_hold) return { text: 'HOLD', color: PAL.badgeHold() }
  if (t.dispatch_express) return { text: 'EXP', color: PAL.badgeExpress() }
  const n = t.dispatch_skip_remaining ?? 0
  if (n > 0) return { text: `SKIP×${n}`, color: PAL.badgeSkip() }
  return null
}

/**
 * Fill m.screenPts with the body polyline (tail → nose). The body follows the track behind the
 * nose for a length drawn at the layout's typical scale (`worldPerMetre`), so a train looks the
 * same size downtown, on the widened Union loop and in the suburbs; never below MIN_BODY_PX.
 */
function bodyGeometry(m: MotionTrain, vp: Viewport, route: RouteIndex | null, edges: Map<string, TopologyEdge>): boolean {
  m.screenPts.length = 0
  m.halfWidth = BODY_W / 2
  if (m.c != null && route) {
    worldBuf.length = 0
    appendRange(route, m.c - m.lengthM, m.lengthM, worldBuf)
    toScreen(vp, worldBuf, m.screenPts)
    const natural = polyLen(m.screenPts)
    const typical = m.lengthM * worldPerMetre(route.topology) * vp.camera.zoom
    m.naturalPx = typical
    const target = Math.max(MIN_BODY_PX, typical)
    if (Math.abs(natural - target) > target * 0.08) {
      const ext = natural > 0.05 ? Math.min((m.lengthM * target) / natural, route.lengthM * 0.05) : m.lengthM * 20
      worldBuf.length = 0
      appendRange(route, m.c - ext, ext, worldBuf)
      toScreen(vp, worldBuf, m.screenPts)
    }
    return m.screenPts.length >= 4
  }
  // Fallback: no route / off-route train — draw at edge/offset with a fixed screen length.
  const e = edges.get(m.train.edge_id)
  if (!e) return false
  const p = interpolatePolyline(e.points, m.train.offset)
  const u = tangentAtT(e.points, m.train.offset)
  const [nx, ny] = vp.worldToScreen(p.x, p.y)
  m.naturalPx = vp.toPixels(Math.max(1, e.length))
  m.screenPts.push(nx - u.x * MIN_BODY_PX, ny - u.y * MIN_BODY_PX, nx, ny)
  return true
}

function finitePts(p: number[]): boolean {
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false
  return true
}

function onScreen(p: number[], vp: Viewport, margin: number): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < minX) minX = p[i]
    if (p[i] > maxX) maxX = p[i]
    if (p[i + 1] < minY) minY = p[i + 1]
    if (p[i + 1] > maxY) maxY = p[i + 1]
  }
  return maxX >= -margin && minX <= vp.width + margin && maxY >= -margin && minY <= vp.height + margin
}

function drawBand(ctx: CanvasRenderingContext2D, vp: Viewport, route: RouteIndex, m: MotionTrain, now: number, quiet: number): void {
  if (m.c == null) return
  const L = route.lengthM
  let len: number
  if (m.eoa != null) {
    len = fwdDist(m.c, m.eoa, L)
    if (len > L * 0.75) len = 0
  } else {
    len = Number.isFinite(m.train.safe_zone_front) ? m.train.safe_zone_front : 0
  }
  if (!(len > 0.5)) return
  len = Math.min(len, MA_MAX_M)
  worldBuf.length = 0
  appendRange(route, m.c, len, worldBuf)
  toScreen(vp, worldBuf, bandBuf)
  if (bandBuf.length < 4 || !finitePts(bandBuf) || polyLen(bandBuf) < 1.5) return
  if (!onScreen(bandBuf, vp, 10)) return
  const tier = slackTier(m.train.atp_slack_m)
  const alpha = m.alpha
  let color = PAL.maBand()
  let width = MA_W
  let tickAlpha = 0.85
  if (tier === 'caution') { color = PAL.maCaution(); width = MA_W_CAUTION; tickAlpha = 1 }
  else if (tier === 'danger') { color = PAL.maDanger(); width = MA_W_DANGER; tickAlpha = 1 }
  // nominal authority recedes further when zoomed out (it reaches the train ahead almost
  // everywhere in moving block); low slack is always drawn at full strength
  const a = tier === 'nominal' ? alpha * quiet : alpha
  ctx.globalAlpha = Math.max(0, tier === 'danger' ? a * (0.7 + 0.3 * Math.sin(now / 140)) : a)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  strokePath(ctx, bandBuf)
  ctx.stroke()
  // limit-of-authority tick across the rail
  const n = bandBuf.length
  const ex = bandBuf[n - 2]
  const ey = bandBuf[n - 1]
  const dx = ex - bandBuf[n - 4]
  const dy = ey - bandBuf[n - 3]
  const dl = Math.hypot(dx, dy) || 1
  const px = -dy / dl
  const py = dx / dl
  const half = tier === 'nominal' ? 3.5 : 4.5
  ctx.globalAlpha = Math.max(0, a * tickAlpha)
  ctx.strokeStyle = tier === 'nominal' ? PAL.maEoa() : color
  ctx.lineWidth = tier === 'nominal' ? 1.5 : 2
  ctx.beginPath()
  ctx.moveTo(ex + px * half, ey + py * half)
  ctx.lineTo(ex - px * half, ey - py * half)
  ctx.stroke()
  ctx.globalAlpha = 1
}

function drawBody(ctx: CanvasRenderingContext2D, m: MotionTrain, t: TrainPosition, fill: string, hovered: boolean, selected: boolean, alert: boolean): void {
  const p = m.screenPts
  const outOfService = t.in_service === false
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  const alpha = m.alpha
  ctx.globalAlpha = alpha
  // nose geometry (pointed end → direction of travel at any zoom)
  const n = p.length
  const nx = p[n - 2]
  const ny = p[n - 1]
  let dx = nx - p[n - 4]
  let dy = ny - p[n - 3]
  const dl = Math.hypot(dx, dy) || 1
  dx /= dl
  dy /= dl
  const half = BODY_W / 2
  const tipX = nx + dx * (half + 1.5)
  const tipY = ny + dy * (half + 1.5)
  const nose = (grow: number) => {
    ctx.beginPath()
    ctx.moveTo(tipX + dx * grow, tipY + dy * grow)
    ctx.lineTo(nx - dy * (half + grow), ny + dx * (half + grow))
    ctx.lineTo(nx + dy * (half + grow), ny - dx * (half + grow))
    ctx.closePath()
  }

  if (selected || hovered) {
    strokePath(ctx, p)
    ctx.lineCap = 'round'
    ctx.strokeStyle = PAL.ring()
    ctx.lineWidth = BODY_W + (selected ? 8 : 6)
    ctx.globalAlpha = alpha * (selected ? 1 : 0.55)
    ctx.stroke()
    ctx.strokeStyle = PAL.ringGap()
    ctx.lineWidth = BODY_W + (selected ? 5 : 3.5)
    ctx.globalAlpha = alpha
    ctx.stroke()
    ctx.lineCap = 'butt'
  }

  // knockout outline (light for an emergency brake: shape cue as well as colour)
  const edge = alert ? PAL.alertOutline() : PAL.outline()
  strokePath(ctx, p)
  ctx.strokeStyle = edge
  ctx.lineWidth = BODY_W + 2
  ctx.stroke()
  nose(1)
  ctx.fillStyle = edge
  ctx.fill()

  if (outOfService) {
    // hollow: thin wall in the out-of-service grey
    strokePath(ctx, p)
    ctx.strokeStyle = PAL.outOfService()
    ctx.lineWidth = BODY_W
    ctx.stroke()
    nose(0)
    ctx.fillStyle = PAL.outOfService()
    ctx.fill()
    strokePath(ctx, p)
    ctx.strokeStyle = COLORS.BACKGROUND
    ctx.lineWidth = BODY_W - 2.5
    ctx.stroke()
    return
  }
  strokePath(ctx, p)
  ctx.strokeStyle = fill
  ctx.lineWidth = BODY_W
  ctx.stroke()
  nose(0)
  ctx.fillStyle = fill
  ctx.fill()
}

/** Midpoint of a polyline by arc length, plus the local direction there. */
function midOf(p: number[]): { x: number; y: number; dx: number; dy: number } {
  const total = polyLen(p)
  let acc = 0
  for (let i = 2; i < p.length; i += 2) {
    const sl = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
    if (acc + sl >= total / 2 && sl > 0) {
      const t = (total / 2 - acc) / sl
      return { x: p[i - 2] + (p[i] - p[i - 2]) * t, y: p[i - 1] + (p[i + 1] - p[i - 1]) * t, dx: (p[i] - p[i - 2]) / sl, dy: (p[i + 1] - p[i - 1]) / sl }
    }
    acc += sl
  }
  const n = p.length
  const dx = p[n - 2] - p[0]
  const dy = p[n - 1] - p[1]
  const dl = Math.hypot(dx, dy) || 1
  return { x: (p[0] + p[n - 2]) / 2, y: (p[1] + p[n - 1]) / 2, dx: dx / dl, dy: dy / dl }
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, border: string): void {
  ctx.beginPath()
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 3)
  ctx.fillStyle = PAL.labelBg()
  ctx.globalAlpha = 0.94
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.lineWidth = 1
  ctx.strokeStyle = border
  ctx.stroke()
}

/** Obstacles a train id tag keeps clear of (platform boxes are fine: trains sit in them). */
const TRAIN_LABEL_AVOID = Obstacle.track | Obstacle.signal | Obstacle.switch | Obstacle.yard

let reported = false
function reportOnce(what: string, err: unknown): void {
  if (reported) return
  reported = true
  console.warn(`[map] ${what} skipped a frame:`, err)
}

export function renderTrainLayer(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  topology: Topology,
  runtime: RuntimeState | null,
  frame: MotionFrame,
  opts: TrainDrawOptions,
): void {
  ctx.save()
  try {
    drawTrains(ctx, vp, topology, runtime, frame, opts)
  } catch (err) {
    reportOnce('train layer', err)
  } finally {
    ctx.restore()
  }
  // Resolve and draw every queued map label (stations, yards, signals, speed tags, trains) —
  // even if a layer above failed this frame.
  ctx.save()
  try {
    flushLabels(ctx, vp)
  } catch (err) {
    reportOnce('label pass', err)
  } finally {
    ctx.restore()
  }
}

function drawTrains(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  topology: Topology,
  runtime: RuntimeState | null,
  frame: MotionFrame,
  opts: TrainDrawOptions,
): void {
  const route = frame.route
  const edges = edgeMap(topology, route)
  const eb = ebrakeTargets(runtime)
  const now = frame.nowMs
  const trains = frame.trains

  // 1 ── geometry + culling
  for (const m of trains) {
    try {
      m.drawn = bodyGeometry(m, vp, route, edges) && finitePts(m.screenPts) && onScreen(m.screenPts, vp, 30)
    } catch {
      m.drawn = false // bad data for one train never stops the others
    }
  }

  ctx.save()
  // 2 ── movement-authority bands (under every body)
  if (opts.showSafeZones && route) {
    const sep = outerSigns(route).sepWorld * vp.camera.zoom
    const quiet = sep < 14 ? 0.6 : 1
    for (const m of trains) {
      if (m.c == null) continue
      try { drawBand(ctx, vp, route, m, now, quiet) } catch { /* skip this train's band */ }
    }
  }

  // 3 ── bodies
  const isAlert = (t: TrainPosition, id: string) => (eb?.has(id) ?? false) || !!t.e_brake || t.stop_reason === 'emergency_brake'
  const body = (m: MotionTrain, hovered: boolean, selected: boolean) => {
    const t = previewTrain(m.train)
    drawBody(ctx, m, t, fillFor(t, eb?.has(m.id) ?? false), hovered, selected, isAlert(t, m.id))
  }
  for (const m of trains) {
    if (!m.drawn) continue
    if (m.id === opts.selectedId || m.id === opts.hoveredId) continue // drawn last, on top
    body(m, false, false)
  }
  for (const id of [opts.hoveredId === opts.selectedId ? null : opts.hoveredId, opts.selectedId]) {
    const m = id ? frame.byId.get(id) : undefined
    if (m && m.drawn) body(m, id === opts.hoveredId, id === opts.selectedId)
  }
  ctx.restore()

  // 4 ── id tags + dispatch badges → shared label pass (priority order, never overlapping)
  order.length = 0
  for (let i = 0; i < trains.length; i++) if (trains[i].drawn) order.push(i)
  order.sort((a, b) => (trains[a].id < trains[b].id ? -1 : 1))
  const side = route ? outerSigns(route) : null
  const sepPx = side ? side.sepWorld * vp.camera.zoom : 0
  for (const i of order) {
    const m = trains[i]
    const focus = m.id === opts.selectedId || m.id === opts.hoveredId
    const badge = badgeFor(m.train)
    const showName = focus || (opts.showLabels && m.naturalPx >= LABEL_MIN_NATURAL_PX)
    if (!showName && !badge) continue
    const showSpeed = focus || (opts.showLabels && m.naturalPx >= SPEED_MIN_NATURAL_PX)

    const name = m.train.label || m.id
    const speedText = showSpeed ? ` ${m.displayKmh} km/h` : ''
    const nameW = showName ? measure(ctx, LABEL_FONT(), name) : 0
    const speedW = showSpeed && showName ? measure(ctx, SPEED_FONT(), speedText) : 0
    const labelW = showName ? Math.ceil(nameW + speedW + LABEL_PAD_X * 2) : 0
    const badgeW = badge ? Math.ceil(measure(ctx, BADGE_FONT(), badge.text) + 8) : 0
    const w = labelW + (labelW && badgeW ? 3 : 0) + badgeW
    const h = LABEL_H

    const mid = midOf(m.screenPts)
    let sign = 1
    if (side && m.c != null && route) sign = side.sign[segIndexAt(route, wrapC(m.c, route.lengthM))]
    // Candidate spots: outer side at mid-body, then shifted along the track, then the inner
    // side (only when the gap to the other track can hold the label). Last frame's spot first
    // so tags don't hop.
    const ox = -mid.dy * sign
    const oy = mid.dx * sign
    const acrossExt = Math.abs(ox) * w + Math.abs(oy) * h      // label size along the normal
    const alongExt = Math.abs(mid.dx) * w + Math.abs(mid.dy) * h // label size along the track
    const off = BODY_W / 2 + LABEL_GAP + acrossExt / 2
    const shift = alongExt / 2 + Math.max(6, Math.min(m.naturalPx, 40) / 2)
    const innerFits = sepPx - BODY_W - 2 * LABEL_GAP >= acrossExt + 2
    const prefer = lastSpot.get(m.id) ?? 0
    const cands: Box[] = []
    const kinds: number[] = []
    for (let n = 0; n < 5; n++) {
      const k = n === 0 ? prefer : n - 1
      if (n > 0 && k === prefer) continue
      let cx = mid.x + ox * off
      let cy = mid.y + oy * off
      if (k === 1) { cx += mid.dx * shift; cy += mid.dy * shift }
      else if (k === 2) { cx -= mid.dx * shift; cy -= mid.dy * shift }
      else if (k === 3) {
        if (!innerFits) continue
        cx = mid.x - ox * (BODY_W / 2 + LABEL_GAP + acrossExt / 2)
        cy = mid.y - oy * (BODY_W / 2 + LABEL_GAP + acrossExt / 2)
      }
      cands.push({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h })
      kinds.push(k)
    }
    if (!cands.length) continue
    const alpha = m.alpha
    addLabel({
      key: `train:${m.id}`,
      priority: focus ? LabelPriority.focus : badge ? LabelPriority.trainBadge : LabelPriority.train,
      candidates: cands,
      avoid: TRAIN_LABEL_AVOID,
      pad: 1,
      // hovered / selected trains always get a tag
      force: focus,
      placed: (b, idx) => {
        lastSpot.set(m.id, kinds[idx])
        if (lastSpot.size > 400) lastSpot.clear()
        m.labelRect = labelW ? { x: b.x, y: b.y, w: labelW, h } : null
        m.badgeRect = badge ? { x: b.x + (labelW ? labelW + 3 : 0), y: b.y, w: badgeW, h } : null
      },
      draw: (c, b) => {
        c.textBaseline = 'middle'
        c.textAlign = 'left'
        const ty = Math.round(b.y + h / 2) + 0.5
        if (labelW) {
          pill(c, b.x, b.y, labelW, h, focus ? PAL.ring() : PAL.labelBorder())
          c.globalAlpha = alpha
          c.font = LABEL_FONT()
          c.fillStyle = PAL.label()
          c.fillText(name, b.x + LABEL_PAD_X, ty)
          if (speedW) {
            c.font = SPEED_FONT()
            c.fillStyle = PAL.labelDim()
            c.fillText(speedText, b.x + LABEL_PAD_X + nameW, ty)
          }
        }
        if (badge) {
          const bx = b.x + (labelW ? labelW + 3 : 0)
          pill(c, bx, b.y, badgeW, h, badge.color)
          c.globalAlpha = alpha
          c.font = BADGE_FONT()
          c.fillStyle = badge.color
          c.fillText(badge.text, bx + 4, ty)
        }
      },
    })
  }
}

// ── hit testing (same geometry as drawn) ────────────────────────────────────

function distToPolyline(p: number[], x: number, y: number): number {
  let best = Infinity
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2]
    const ay = p[i - 1]
    const bx = p[i]
    const by = p[i + 1]
    const abx = bx - ax
    const aby = by - ay
    const l2 = abx * abx + aby * aby
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / l2)) : 0
    const d = Math.hypot(x - (ax + abx * t), y - (ay + aby * t))
    if (d < best) best = d
  }
  return best
}

const inRect = (r: { x: number; y: number; w: number; h: number } | null, x: number, y: number) =>
  !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/** Train id under screen point (sx, sy) in the last drawn frame, or null. */
export function hitTestTrains(frame: MotionFrame, sx: number, sy: number): string | null {
  let best: string | null = null
  let bestD = Infinity
  for (let i = frame.trains.length - 1; i >= 0; i--) {
    const m = frame.trains[i]
    if (!m.drawn) continue
    if (inRect(m.labelRect, sx, sy) || inRect(m.badgeRect, sx, sy)) return m.id
    const d = distToPolyline(m.screenPts, sx, sy)
    if (d <= Math.max(m.halfWidth + 5, 8) && d < bestD) {
      bestD = d
      best = m.id
    }
  }
  return best
}
