/**
 * Wayside signals drawn the way an ATS overview does: a small glyph beside its own track on the
 * right-hand side of travel (the outer side of each track), a short post with the head pointing
 * the way trains run on that leg. Kinds are distinguished subtly:
 *   home         — round head, foot bar (protects points ahead)
 *   starter      — square head, foot bar (platform-end starting signal)
 *   intermediate — small round head, no foot
 *   yard_exit    — hollow ring head (shunt-style), no foot
 * At fit zoom only the post and head are drawn (no foot, no names). Names ("SPA 1") appear when
 * zoomed in or hovered, placed through the shared label pass so they never sit on a station
 * name, a train label or track. Positions come from edge_id + offset, so the glyph follows
 * whichever layout is active; nothing is regularised — we draw exactly what we get.
 *
 * `signalGlyphs` is the single geometry path: drawing and `signalHitAreas` (hit-testing) both
 * use it, so a click lands exactly on what is drawn.
 */
import type { Topology, RuntimeState, SignalAspect, TopologySignal, Vec2 } from '../../types/domain'
import type { Viewport } from '../Viewport'
import { COLORS } from '../../constants/colors'
import { interpolatePolyline } from '../../utils/geometry'
import { getLayoutMeta } from '../../layout/meta'
import { signalGlyphScale } from '../../layout/labels'
import { addLabel, addObstacleSegment, LabelPriority, Obstacle, type Box } from '../../motion/labels'
import { useRuntimeStore } from '../../store/runtimeStore'
import { drawText, MAP_TYPE, measureText, monoFont } from '../text'
import { finite, type HitArea } from '../hit'

type SignalKind = 'home' | 'starter' | 'yard_exit' | 'intermediate'

interface SignalV2 extends TopologySignal {
  leg?: 'ob' | 'ib'
  kind?: SignalKind
  name?: string
}

/** Track separation (px) from which signal names are shown without hovering. */
export const SIGNAL_NAMES_FROM_SEP_PX = 22

function aspectColor(aspect: SignalAspect): string {
  switch (aspect) {
    case 'green': return COLORS.SIGNAL_GREEN
    case 'yellow': return COLORS.SIGNAL_YELLOW
    case 'red': return COLORS.SIGNAL_RED
    case 'flashing_yellow': return COLORS.SIGNAL_FLASHING_YELLOW
    case 'dark': return COLORS.SIGNAL_DARK
    default: return COLORS.SIGNAL_DARK
  }
}

function tangentAt(points: Vec2[], t: number): Vec2 {
  const a = interpolatePolyline(points, Math.max(0, t - 0.004))
  const b = interpolatePolyline(points, Math.min(1, t + 0.004))
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  if (!(L > 1e-9)) {
    const p = points[0]
    const q = points[points.length - 1]
    const M = Math.hypot(q.x - p.x, q.y - p.y) || 1
    return { x: (q.x - p.x) / M, y: (q.y - p.y) / M }
  }
  return { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
}

function inferKind(sig: SignalV2): SignalKind {
  const k = sig.kind
  return k === 'home' || k === 'starter' || k === 'yard_exit' ? k : 'intermediate'
}

/** Screen geometry of one drawn signal glyph. */
export interface SignalGlyph {
  sig: SignalV2
  kind: SignalKind
  /** rail point, post foot, post top, head centre (screen px) */
  sx: number; sy: number
  bx: number; by: number
  tx: number; ty: number
  hx: number; hy: number
  /** head radius, arm length, glyph scale */
  rad: number
  arm: number
  g: number
  /** travel direction and its right-hand normal (screen) */
  d: Vec2
  r: Vec2
}

const glyphCache = new WeakMap<Topology, Map<string, { pts: Vec2[] }>>()

function edgeIndex(topology: Topology): Map<string, { pts: Vec2[] }> {
  let m = glyphCache.get(topology)
  if (!m) {
    m = new Map()
    for (const e of topology.edges ?? []) {
      if (e && Array.isArray(e.points) && e.points.length >= 2 && e.points.every((p) => p && finite(p.x, p.y))) {
        m.set(e.id, { pts: e.points })
      }
    }
    glyphCache.set(topology, m)
  }
  return m
}

/**
 * Geometry of every signal glyph currently within (margin px of) the viewport — the one code
 * path used for both drawing and hit-testing. Signals with bad data are skipped, never thrown on.
 */
export function signalGlyphs(vp: Viewport, topology: Topology, margin = 40): SignalGlyph[] {
  const out: SignalGlyph[] = []
  const edges = edgeIndex(topology)
  const sepPx = getLayoutMeta(topology).trackSep * vp.camera.zoom
  const g = signalGlyphScale(sepPx)
  for (const raw of topology.signals ?? []) {
    const sig = raw as SignalV2
    if (!sig) continue
    const edge = edges.get(sig.edge_id)
    const t = sig.offset
    if (!edge || !finite(t)) continue
    const tt = Math.max(0, Math.min(1, t))
    const wp = interpolatePolyline(edge.pts, tt)
    const [sx, sy] = vp.worldToScreen(wp.x, wp.y)
    if (!finite(sx, sy)) continue
    if (sx < -margin || sx > vp.width + margin || sy < -margin || sy > vp.height + margin) continue

    // Edges are directed in travel order, so the tangent is the direction of travel on this leg.
    const d = tangentAt(edge.pts, tt)
    if (!finite(d.x, d.y)) continue
    const r = { x: -d.y, y: d.x } // right-hand side of travel = outer side of this track
    const kind = inferKind(sig)
    const small = kind === 'intermediate' || kind === 'yard_exit'
    const rad = (small ? COLORS.SIGNAL_RADIUS * 0.85 : COLORS.SIGNAL_RADIUS) * g
    const base = COLORS.TRACK_WIDTH / 2 + 1.5
    const postLen = 5 * g
    const bx = sx + r.x * base
    const by = sy + r.y * base
    const tx = sx + r.x * (base + postLen)
    const ty = sy + r.y * (base + postLen)
    const arm = 2.25 * g
    const hx = tx + d.x * (arm + rad)
    const hy = ty + d.y * (arm + rad)
    out.push({ sig, kind, sx, sy, bx, by, tx, ty, hx, hy, rad, arm, g, d, r })
  }
  return out
}

/**
 * Hit areas for signals: a capsule from the post foot to the head, grown so the small glyph is
 * comfortable to click (but never reaches the opposite track).
 */
export function signalHitAreas(vp: Viewport, topology: Topology): HitArea[] {
  try {
    return signalGlyphs(vp, topology, 10).map((s) => ({
      id: s.sig.id,
      ax: s.bx, ay: s.by,
      bx: s.hx, by: s.hy,
      r: Math.max(5, s.rad + 3),
    }))
  } catch {
    return []
  }
}

export function renderSignalLayer(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  topology: Topology,
  runtime: RuntimeState,
  flashPhase: boolean,
): void {
  ctx.save()
  try {
    drawSignals(ctx, vp, topology, runtime, flashPhase)
  } catch (err) {
    reportOnce(err)
  } finally {
    ctx.restore()
  }
}

let reported = false
function reportOnce(err: unknown): void {
  if (reported) return
  reported = true
  console.warn('[map] signal layer skipped a frame:', err)
}

function drawSignals(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  topology: Topology,
  runtime: RuntimeState,
  flashPhase: boolean,
): void {
  const sigMap = new Map((runtime?.signals ?? []).map((s) => [s.signal_id, s.aspect]))
  const sepPx = getLayoutMeta(topology).trackSep * vp.camera.zoom
  const detailed = sepPx >= 14
  const store = useRuntimeStore.getState()
  const showNames = store.showLabels !== false && sepPx >= SIGNAL_NAMES_FROM_SEP_PX
  const hoveredId = store.hovered?.kind === 'signal' ? store.hovered.id : null
  const nameFont = monoFont(MAP_TYPE.secondary, 500)

  ctx.lineCap = 'butt'
  for (const s of signalGlyphs(vp, topology)) {
    const { sig, kind, bx, by, tx, ty, hx, hy, rad, arm, g, d, r } = s
    const aspect = sigMap.get(sig.id) ?? sig.aspect ?? 'dark'
    const lit = aspect === 'flashing_yellow' ? flashPhase : true
    const head = lit ? aspectColor(aspect) : COLORS.SIGNAL_DARK

    // post + arm (+ foot bar for home / starter when zoomed in)
    ctx.strokeStyle = COLORS.SIGNAL_MAST
    ctx.lineWidth = detailed ? 1.25 : 1
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.lineTo(tx, ty)
    ctx.lineTo(tx + d.x * arm, ty + d.y * arm)
    if (detailed && (kind === 'home' || kind === 'starter')) {
      const f = 2.25 * g
      ctx.moveTo(bx - d.x * f, by - d.y * f)
      ctx.lineTo(bx + d.x * f, by + d.y * f)
    }
    ctx.stroke()

    // head
    ctx.beginPath()
    if (kind === 'starter') {
      const q = rad * 0.92
      ctx.save()
      ctx.translate(hx, hy)
      ctx.rotate(Math.atan2(d.y, d.x))
      ctx.rect(-q, -q, q * 2, q * 2)
      ctx.restore()
    } else {
      ctx.arc(hx, hy, rad, 0, Math.PI * 2)
    }
    if (kind === 'yard_exit') {
      ctx.fillStyle = COLORS.BACKGROUND
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = head
      ctx.stroke()
    } else {
      ctx.fillStyle = head
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = COLORS.SIGNAL_BORDER
      ctx.stroke()
    }

    const isHovered = hoveredId === sig.id
    if (isHovered) {
      ctx.beginPath()
      ctx.arc(hx, hy, rad + 2.5, 0, Math.PI * 2)
      ctx.lineWidth = 1
      ctx.strokeStyle = COLORS.TEXT_1
      ctx.stroke()
    }

    // glyph footprint (post, arm, head): nothing else may be drawn over it
    addObstacleSegment(bx, by, tx, ty, 1, Obstacle.signal)
    addObstacleSegment(tx, ty, hx, hy, 1, Obstacle.signal)
    addObstacleSegment(hx, hy, hx, hy, rad + 0.5, Obstacle.signal)

    if (!(showNames || isHovered)) continue
    const label = sig.name ?? String(sig.id).replace(/^sig_/, '').replace(/_/g, ' ')
    const w = Math.ceil(measureText(ctx, nameFont, label)) + 4
    const h = 13
    const gap = 3
    const cands: Box[] = []
    const at = (cx: number, cy: number) => cands.push({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h })
    const acrossExt = (Math.abs(r.x) * w + Math.abs(r.y) * h) / 2
    const alongExt = (Math.abs(d.x) * w + Math.abs(d.y) * h) / 2
    // 1 beyond the head, away from the track · 2 ahead of the head · 3 behind the post ·
    // 4/5 beyond the head, shifted along the track
    at(hx + r.x * (rad + gap + acrossExt), hy + r.y * (rad + gap + acrossExt))
    at(hx + d.x * (rad + gap + alongExt), hy + d.y * (rad + gap + alongExt))
    const px = (bx + tx) / 2
    const py = (by + ty) / 2
    at(px - d.x * (gap + 1 + alongExt), py - d.y * (gap + 1 + alongExt))
    for (const k of [1, -1]) {
      at(
        hx + r.x * (rad + gap + acrossExt) + d.x * k * (alongExt + rad),
        hy + r.y * (rad + gap + acrossExt) + d.y * k * (alongExt + rad),
      )
    }
    addLabel({
      key: `signal:${sig.id}`,
      priority: isHovered ? LabelPriority.signalHover : LabelPriority.signal,
      candidates: cands,
      pad: 1,
      draw: (c, b) => drawText(c, label, b.x + b.w / 2, b.y + b.h / 2, nameFont, isHovered ? COLORS.TEXT_1 : COLORS.SIGNAL_LABEL, 'center', 3),
    })
  }
}
