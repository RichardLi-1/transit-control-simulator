/**
 * Static line geometry: running rails, platforms, permanent speed limits and yard leads.
 *
 * This is the first map layer each frame, so it also opens the shared label pass
 * (`motion/labels`): every track segment, platform and yard fan it draws is registered as an
 * obstacle, and its own text (yard names, speed tags) is queued there instead of being drawn
 * directly — TrainLayer flushes the pass once everything is on the canvas.
 */
import type { Topology, Vec2 } from '../../types/domain'
import type { Viewport } from '../Viewport'
import { COLORS } from '../../constants/colors'
import { polylineBounds } from '../../utils/geometry'
import { getLayoutMeta, type LayoutMeta } from '../../layout/meta'
import { chainagePoint, chainageRange, legOf, worldPerMetre } from '../../layout/chainage'
import { signalGlyphExtent } from '../../layout/labels'
import {
  addLabel, addObstaclePolyline, addObstacleRect, addObstacleSegment, beginLabelFrame, LabelPriority, Obstacle, type Box,
} from '../../motion/labels'
import { drawText, ensureMapFonts, MAP_TYPE, mapFont, measureText, monoFont, snap } from '../text'
import { useRuntimeStore } from '../../store/runtimeStore'
import { installMapDebug } from '../debugHook'

/** Drawn platform length, metres (TR trains are 138 m). */
const PLATFORM_M = 160
/** Track separation (px) from which civil speed limits are drawn (quiet at fit zoom). */
const SPEED_FROM_SEP_PX = 14

const scr: number[] = []

function toScreen(vp: Viewport, pts: Vec2[], out: number[], crisp = 0): number[] {
  out.length = 0
  for (const p of pts) {
    const [x, y] = vp.worldToScreen(p.x, p.y)
    if (crisp) out.push(snap(x, crisp % 2 === 1), snap(y, crisp % 2 === 1))
    else out.push(x, y)
  }
  return out
}

function strokeFlat(ctx: CanvasRenderingContext2D, p: number[]): void {
  if (p.length < 4) return
  ctx.beginPath()
  ctx.moveTo(p[0], p[1])
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
  ctx.stroke()
}

/** Offset a flat screen polyline sideways by d px (right-hand normal of travel, miter-free). */
function offsetFlat(p: number[], d: number, out: number[]): number[] {
  out.length = 0
  const n = p.length / 2
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    let dx = p[b * 2] - p[a * 2]
    let dy = p[b * 2 + 1] - p[a * 2 + 1]
    const L = Math.hypot(dx, dy) || 1
    dx /= L
    dy /= L
    out.push(p[i * 2] - dy * d, p[i * 2 + 1] + dx * d)
  }
  return out
}

/**
 * Platforms: a crisp box around both tracks (the rails pass through it), drawn under the rails.
 * Interchanges get a lighter outline; terminals are distinguished by their label weight only.
 */
function drawPlatforms(ctx: CanvasRenderingContext2D, vp: Viewport, meta: LayoutMeta, sepPx: number, topology: Topology): void {
  // a platform is a little longer than a train at the same (typical) scale
  const hl = Math.round(Math.max(8.5, (PLATFORM_M * worldPerMetre(topology) * vp.camera.zoom) / 2))
  const hw = Math.round(sepPx / 2 + Math.max(3, Math.min(6, sepPx * 0.22)))
  for (const st of meta.stations) {
    const [sx, sy] = vp.worldToScreen(st.center.x, st.center.y)
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue
    if (sx < -60 || sx > vp.width + 60 || sy < -60 || sy > vp.height + 60) continue
    // interchanges only (terminals are emphasised by their label weight, not decoration)
    const major = st.connections.length > 0
    const ang = Math.atan2(st.along.y, st.along.x)
    ctx.save()
    ctx.translate(snap(sx), snap(sy))
    ctx.rotate(ang)
    ctx.beginPath()
    ctx.rect(-hl + 0.5, -hw + 0.5, hl * 2 - 1, hw * 2 - 1)
    ctx.fillStyle = COLORS.STATION_MARKER_FILL
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = major ? COLORS.INTERCHANGE_BORDER : COLORS.STATION_MARKER_BORDER
    ctx.stroke()
    ctx.restore()
    // obstacle: exact box on straight N–S / E–W runs, a capsule along a diagonal
    if (Math.abs(st.along.x) < 1e-3 || Math.abs(st.along.y) < 1e-3) {
      const ex = Math.abs(st.along.x) > 0.5 ? hl : hw
      const ey = Math.abs(st.along.x) > 0.5 ? hw : hl
      addObstacleRect(sx - ex, sy - ey, ex * 2, ey * 2, Obstacle.platform)
    } else {
      const k = Math.max(0, hl - hw)
      addObstacleSegment(sx - st.along.x * k, sy - st.along.y * k, sx + st.along.x * k, sy + st.along.y * k, hw, Obstacle.platform)
    }
  }
}

/**
 * Permanent civil speed limits: a thin amber line beside the affected rail (right-hand side of
 * travel, like the trackside boards), with a small boxed value once zoomed in.
 */
function drawSpeedRestrictions(ctx: CanvasRenderingContext2D, vp: Viewport, topology: Topology, sepPx: number, labels: boolean): void {
  const list = topology.speed_restrictions
  if (!list?.length || !topology.route || sepPx < SPEED_FROM_SEP_PX) return
  const off = COLORS.TRACK_WIDTH / 2 + 2
  const side: number[] = []
  ctx.save()
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = COLORS.SPEED_RESTRICTION
  ctx.lineWidth = sepPx >= 24 ? 1.5 : 1
  for (const r of list) {
    if (!r || !Number.isFinite(r.start_m) || !Number.isFinite(r.end_m)) continue
    for (const part of chainageRange(topology, r.start_m, r.end_m)) {
      if (part.edge.id.startsWith('xover') || !validPts(part.points)) continue
      toScreen(vp, part.points, scr)
      offsetFlat(scr, off, side)
      strokeFlat(ctx, side)
      addObstaclePolyline(side, 1, Obstacle.track)
    }
  }
  ctx.restore()

  if (!labels || sepPx < 16) return
  const font = monoFont(MAP_TYPE.secondary, 500)
  const h = 13
  const glyph = signalGlyphExtent(sepPx)
  for (const r of list) {
    if (!r || !(r.end_m - r.start_m >= 40) || !Number.isFinite(r.limit_kph)) continue
    const text = String(Math.round(r.limit_kph))
    const w = Math.ceil(measureText(ctx, font, text)) + 6
    const cands: Box[] = []
    // along the restriction: middle first, then towards either end; beside the rail, then a bit
    // further out (past any signal glyph there)
    for (const out of [off + 3, glyph + 4]) {
      for (const f of [0.5, 0.3, 0.7, 0.12, 0.88]) {
        const at = chainagePoint(topology, r.start_m + (r.end_m - r.start_m) * f)
        if (!at || at.leg === 'other' || !Number.isFinite(at.point.x) || !Number.isFinite(at.dir.x)) continue
        const [sx, sy] = vp.worldToScreen(at.point.x, at.point.y)
        const nx = -at.dir.y
        const ny = at.dir.x
        // centre of the box: `out` px from the rail plus half the box's extent along the normal
        const ext = (Math.abs(nx) * w + Math.abs(ny) * h) / 2
        const cx = sx + nx * (out + ext)
        const cy = sy + ny * (out + ext)
        cands.push({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h })
      }
    }
    if (!cands.length) continue
    addLabel({
      key: `speed:${r.start_m}`,
      priority: LabelPriority.speed,
      candidates: cands,
      pad: 1,
      draw: (c, b) => {
        c.beginPath()
        c.rect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1)
        c.fillStyle = COLORS.SPEED_TAG_BG
        c.fill()
        c.lineWidth = 1
        c.strokeStyle = COLORS.SPEED_RESTRICTION
        c.stroke()
        drawText(c, text, b.x + b.w / 2, b.y + b.h / 2, font, COLORS.SPEED_RESTRICTION_TEXT, 'center', 0)
      },
    })
  }
}

/**
 * Yard leads: a turnout off the running line on the inside of the U, a short lead and a fan of
 * three sidings. A lead from the outer (ob) track crosses the inner rail on its way in.
 * The yard name is queued for the label pass, so it never crosses track.
 */
function drawYards(ctx: CanvasRenderingContext2D, vp: Viewport, topology: Topology, sepPx: number, labels: boolean): void {
  const yards = topology.yards
  if (!yards?.length || !topology.route) return
  const fan: number[] = []
  ctx.save()
  ctx.strokeStyle = COLORS.YARD
  ctx.lineWidth = Math.max(1, Math.min(1.75, COLORS.TRACK_WIDTH * 0.75))
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'
  const k = Math.max(0.8, Math.min(2.2, sepPx / 10))
  for (const y of yards) {
    if (!y || !Number.isFinite(y.chainage_m)) continue
    const at = chainagePoint(topology, y.chainage_m)
    if (!at || at.leg === 'other' || !Number.isFinite(at.point.x) || !Number.isFinite(at.dir.x)) continue
    const leg = y.leg ?? at.leg
    const d = at.dir
    const r = { x: -d.y, y: d.x } // right of travel
    // ob is the outer track, so inward is to its left; ib is the inner track: inward = right.
    const inward = leg === 'ob' ? { x: -r.x, y: -r.y } : r
    const [px, py] = vp.worldToScreen(at.point.x, at.point.y)
    // trailing connection: the lead leaves against the direction of travel on this leg
    const back = { x: -d.x, y: -d.y }
    const diag = { x: (inward.x + back.x) * Math.SQRT1_2, y: (inward.y + back.y) * Math.SQRT1_2 }
    // diagonal from the rail until clear of the inner track, then a short straight lead
    const cross = (leg === 'ob' ? sepPx : 0) + 6 * k
    const s = { x: px, y: py }
    const m = { x: s.x + diag.x * cross * Math.SQRT2, y: s.y + diag.y * cross * Math.SQRT2 }
    const e = { x: m.x + back.x * 10 * k, y: m.y + back.y * 10 * k }
    if (Math.max(s.x, e.x) < -80 || Math.min(s.x, e.x) > vp.width + 80 || Math.max(s.y, e.y) < -80 || Math.min(s.y, e.y) > vp.height + 80) continue
    let fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity
    const grow = (q: Vec2) => {
      if (q.x < fx0) fx0 = q.x
      if (q.x > fx1) fx1 = q.x
      if (q.y < fy0) fy0 = q.y
      if (q.y > fy1) fy1 = q.y
    }
    fan.length = 0
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(m.x, m.y)
    ctx.lineTo(e.x, e.y)
    fan.push(s.x, s.y, m.x, m.y, e.x, e.y)
    addObstaclePolyline(fan, 1.5, Obstacle.yard)
    grow(m)
    grow(e)
    // three parallel sidings fanning inward off the lead, each ending in a buffer stop
    const sid = 4 * k
    for (let j = 0; j < 3; j++) {
      const q = { x: m.x + back.x * (j * 3 * k), y: m.y + back.y * (j * 3 * k) }
      const b = { x: q.x + diag.x * sid * j * Math.SQRT2, y: q.y + diag.y * sid * j * Math.SQRT2 }
      const t = { x: b.x + back.x * (16 * k - j * 2 * k), y: b.y + back.y * (16 * k - j * 2 * k) }
      const from = j > 0 ? q : e
      ctx.moveTo(from.x, from.y)
      if (j > 0) ctx.lineTo(b.x, b.y)
      ctx.lineTo(t.x, t.y)
      ctx.moveTo(t.x - inward.x * 2, t.y - inward.y * 2)
      ctx.lineTo(t.x + inward.x * 2, t.y + inward.y * 2)
      fan.length = 0
      fan.push(from.x, from.y, b.x, b.y, t.x, t.y)
      addObstaclePolyline(fan, 2, Obstacle.yard)
      grow(b)
      grow(t)
    }
    ctx.stroke()

    if (!labels || sepPx < 6) continue
    const name = String(y.name ?? 'Yard')
    const font = mapFont(MAP_TYPE.secondary, 500)
    const w = Math.ceil(measureText(ctx, font, name)) + 4
    const h = 14
    const fcx = (fx0 + fx1) / 2
    const fcy = (fy0 + fy1) / 2
    const gap = 5
    const cands: Box[] = []
    const push = (cx: number, cy: number) => cands.push({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h })
    // beyond the fan (further inward), then beside it along the track, then above / below
    push(fcx + inward.x * ((fx1 - fx0) / 2 + gap + w / 2), fcy + inward.y * ((fy1 - fy0) / 2 + gap + h / 2))
    push(fcx, fy1 + gap + h / 2)
    push(fcx, fy0 - gap - h / 2)
    push(fx1 + gap + w / 2, fcy)
    push(fx0 - gap - w / 2, fcy)
    addLabel({
      key: `yard:${name}`,
      priority: LabelPriority.yard,
      candidates: cands,
      pad: 2,
      draw: (c, b) => drawText(c, name, b.x + b.w / 2, b.y + b.h / 2, font, COLORS.YARD_LABEL, 'center', 3),
    })
  }
  ctx.restore()
}

let reported = false

export function renderTrackLayer(ctx: CanvasRenderingContext2D, vp: Viewport, topology: Topology): void {
  beginLabelFrame()
  ctx.save()
  try {
    drawTrack(ctx, vp, topology)
  } catch (err) {
    if (!reported) {
      reported = true
      console.warn('[map] track layer skipped a frame:', err)
    }
  } finally {
    ctx.restore()
  }
}

function validPts(pts: unknown): pts is Vec2[] {
  return Array.isArray(pts) && pts.length >= 2 && pts.every((p) => p && Number.isFinite((p as Vec2).x) && Number.isFinite((p as Vec2).y))
}

function drawTrack(ctx: CanvasRenderingContext2D, vp: Viewport, topology: Topology): void {
  ensureMapFonts()
  installMapDebug(vp, topology)
  const meta = getLayoutMeta(topology)
  const sepPx = meta.trackSep * vp.camera.zoom
  const labels = useRuntimeStore.getState().showLabels !== false

  drawSpeedRestrictions(ctx, vp, topology, sepPx, labels)
  drawYards(ctx, vp, topology, sepPx, labels)
  drawPlatforms(ctx, vp, meta, sepPx, topology)

  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'
  ctx.miterLimit = 4
  ctx.strokeStyle = COLORS.TRACK_CLEAR
  ctx.lineWidth = COLORS.TRACK_WIDTH
  const hw = COLORS.TRACK_WIDTH / 2 + 0.5
  for (const edge of topology.edges ?? []) {
    if (!edge || !validPts(edge.points)) continue
    // Mid-line crossovers are drawn by the switch layer (state-aware).
    if (edge.id.startsWith('xover_mid')) continue
    if (legOf(edge.id) === 'other' && edge.points.length <= 2 && edge.id.startsWith('xover')) continue
    if (!vp.isVisible(polylineBounds(edge.points))) continue
    // rails snapped to the device-pixel grid so straight runs stay crisp
    toScreen(vp, edge.points, scr, Math.round(COLORS.TRACK_WIDTH))
    strokeFlat(ctx, scr)
    addObstaclePolyline(scr, hw, Obstacle.track)
  }
}
