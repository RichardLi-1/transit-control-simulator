/**
 * Points / crossovers, drawn the way an ATS overview shows points position.
 *
 * A mid-line crossover is one symmetric 45° diagonal between the parallel tracks, on a straight
 * piece clear of both platforms (see layout/schematic). The route that is NOT set through the
 * points is drawn broken:
 *   normal  — rails continuous, the diagonal stands off both rails by a small gap (quiet grey);
 *   reverse — the diagonal is solid amber and joins both rails, and each rail shows a gap just
 *             past its points (the straight route is not set).
 * Terminal turn-backs are plain track unless reversed, when the turn-back path is drawn amber.
 * No text: internal ids never reach the map (the hover card names the crossover).
 *
 * `switchGlyphs` is the single geometry path for drawing and `switchHitAreas` (hit-testing).
 */
import type { Topology, RuntimeState, TopologySwitch, Vec2 } from '../../types/domain'
import type { Viewport } from '../Viewport'
import { COLORS } from '../../constants/colors'
import { getLayoutMeta } from '../../layout/meta'
import { addObstacleSegment, Obstacle } from '../../motion/labels'
import { useRuntimeStore } from '../../store/runtimeStore'
import { finite, type HitArea } from '../hit'
import { previewSwitch } from '../debugHook'

export interface SwitchGlyph {
  sw: TopologySwitch
  kind: 'crossover' | 'turnback'
  /** crossover: diagonal end on the ob rail (a) and on the ib rail (b), screen px */
  ax: number; ay: number
  bx: number; by: number
  /** unit direction of the running rails (ob travel) at the crossover */
  along: Vec2
  /** turn-back: the loop polyline, flat screen [x0, y0, …] */
  path: number[]
}

function validPts(pts: unknown): pts is Vec2[] {
  return Array.isArray(pts) && pts.length >= 2 && pts.every((p) => p && finite((p as Vec2).x, (p as Vec2).y))
}

/** Unit direction of the running rail (screen) nearest the diagonal's ob end. */
function railDir(points: Vec2[] | undefined, vp: Viewport, ax: number, ay: number, bx: number, by: number): Vec2 {
  if (points && validPts(points)) {
    let best = { x: bx - ax, y: by - ay }
    let bd = Infinity
    for (let i = 1; i < points.length; i++) {
      const [px, py] = vp.worldToScreen(points[i - 1].x, points[i - 1].y)
      const [qx, qy] = vp.worldToScreen(points[i].x, points[i].y)
      if (Math.hypot(qx - px, qy - py) <= 0.5) continue
      const mx = (px + qx) / 2 - ax
      const my = (py + qy) / 2 - ay
      const d = mx * mx + my * my
      if (d < bd) {
        bd = d
        best = { x: qx - px, y: qy - py }
      }
    }
    const L = Math.hypot(best.x, best.y) || 1
    return { x: best.x / L, y: best.y / L }
  }
  const L = Math.hypot(bx - ax, by - ay) || 1
  return { x: (bx - ax) / L, y: (by - ay) / L }
}

/** Screen geometry of every switch glyph within (margin px of) the viewport. Never throws on bad data. */
export function switchGlyphs(vp: Viewport, topology: Topology, margin = 40): SwitchGlyph[] {
  const out: SwitchGlyph[] = []
  const edgesById = new Map((topology.edges ?? []).filter(Boolean).map((e) => [e.id, e]))
  for (const sw of topology.switches ?? []) {
    if (!sw) continue
    const xover = edgesById.get(sw.reverse_edge_id)
    if (!xover || !validPts(xover.points)) continue
    if (xover.points.length === 2) {
      const [ax, ay] = vp.worldToScreen(xover.points[0].x, xover.points[0].y)
      const [bx, by] = vp.worldToScreen(xover.points[1].x, xover.points[1].y)
      const cx = (ax + bx) / 2
      const cy = (ay + by) / 2
      if (cx < -margin || cx > vp.width + margin || cy < -margin || cy > vp.height + margin) continue
      const along = railDir(edgesById.get(sw.normal_edge_id)?.points, vp, ax, ay, bx, by)
      out.push({ sw, kind: 'crossover', ax, ay, bx, by, along, path: [] })
      continue
    }
    const path: number[] = []
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of xover.points) {
      const [x, y] = vp.worldToScreen(p.x, p.y)
      path.push(x, y)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    if (maxX < -margin || minX > vp.width + margin || maxY < -margin || minY > vp.height + margin) continue
    const n = path.length
    out.push({ sw, kind: 'turnback', ax: path[0], ay: path[1], bx: path[n - 2], by: path[n - 1], along: { x: 1, y: 0 }, path })
  }
  return out
}

/**
 * Hit areas for switches: the crossover diagonal itself (a thin capsule that stays between the
 * rails), or the far end of a terminal turn-back loop.
 */
export function switchHitAreas(vp: Viewport, topology: Topology): HitArea[] {
  try {
    const out: HitArea[] = []
    for (const g of switchGlyphs(vp, topology, 10)) {
      if (g.kind === 'crossover') {
        // shrink the ends so a click on either running rail is not taken as the crossover
        const L = Math.hypot(g.bx - g.ax, g.by - g.ay) || 1
        const ux = (g.bx - g.ax) / L
        const uy = (g.by - g.ay) / L
        const inset = Math.min(L * 0.3, 4)
        out.push({ id: g.sw.id, ax: g.ax + ux * inset, ay: g.ay + uy * inset, bx: g.bx - ux * inset, by: g.by - uy * inset, r: Math.max(4, Math.min(8, L * 0.25)) })
      } else {
        // the tip of the loop beyond the platform
        const p = g.path
        let tx = p[0], ty = p[1], best = -1
        for (let i = 0; i < p.length; i += 2) {
          const d = Math.hypot(p[i] - g.ax, p[i + 1] - g.ay) + Math.hypot(p[i] - g.bx, p[i + 1] - g.by)
          if (d > best) { best = d; tx = p[i]; ty = p[i + 1] }
        }
        out.push({ id: g.sw.id, ax: tx, ay: ty, bx: tx, by: ty, r: 8 })
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * World point that represents each switch on the map: the middle of its crossover diagonal
 * (mid-line crossovers) or its node (terminal turn-backs).
 */
export function switchAnchor(topology: Topology, switchId: string): Vec2 | null {
  const sw = topology.switches?.find((s) => s.id === switchId)
  if (!sw) return null
  const e = topology.edges?.find((x) => x.id === sw.reverse_edge_id)
  if (e && validPts(e.points) && e.points.length === 2) {
    return { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 }
  }
  const n = topology.nodes?.find((x) => x.id === sw.node_id)
  return n && finite(n.x, n.y) ? { x: n.x, y: n.y } : null
}

let reported = false

export function renderSwitchLayer(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  topology: Topology,
  runtime: RuntimeState,
): void {
  ctx.save()
  try {
    drawSwitches(ctx, vp, topology, runtime)
  } catch (err) {
    if (!reported) {
      reported = true
      console.warn('[map] switch layer skipped a frame:', err)
    }
  } finally {
    ctx.restore()
  }
}

function drawSwitches(ctx: CanvasRenderingContext2D, vp: Viewport, topology: Topology, runtime: RuntimeState): void {
  const swMap = new Map((runtime?.switches ?? []).map((s) => [s.switch_id, s.state]))
  const sepPx = getLayoutMeta(topology).trackSep * vp.camera.zoom
  const hovered = useRuntimeStore.getState().hovered
  const hoveredId = hovered?.kind === 'switch' ? hovered.id : null
  const tw = COLORS.TRACK_WIDTH

  ctx.lineCap = 'butt'
  for (const g of switchGlyphs(vp, topology)) {
    const reversed = (previewSwitch(g.sw.id) ?? swMap.get(g.sw.id) ?? g.sw.state) === 'reverse'
    if (g.kind === 'crossover') {
      const { ax, ay, bx, by, along } = g
      const L = Math.hypot(bx - ax, by - ay) || 1
      const ux = (bx - ax) / L
      const uy = (by - ay) / L
      const gap = Math.max(1.5, Math.min(6, sepPx * 0.14 + 1))

      if (hoveredId === g.sw.id) {
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.lineWidth = tw + 5
        ctx.strokeStyle = COLORS.BORDER_STRONG
        ctx.stroke()
      }
      if (reversed) {
        // break the straight rails just past each set of points
        const g0 = tw + 1
        const g1 = g0 + Math.max(3, Math.min(8, sepPx * 0.3))
        ctx.strokeStyle = COLORS.BACKGROUND
        ctx.lineWidth = tw + 2
        ctx.beginPath()
        ctx.moveTo(ax + along.x * g0, ay + along.y * g0)
        ctx.lineTo(ax + along.x * g1, ay + along.y * g1)
        ctx.moveTo(bx - along.x * g0, by - along.y * g0)
        ctx.lineTo(bx - along.x * g1, by - along.y * g1)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.lineWidth = tw
        ctx.strokeStyle = COLORS.SWITCH_REVERSE
        ctx.stroke()
      } else {
        // same weight as the running rails, broken at both points: the diverging route is not set
        ctx.beginPath()
        ctx.moveTo(ax + ux * gap, ay + uy * gap)
        ctx.lineTo(bx - ux * gap, by - uy * gap)
        ctx.lineWidth = sepPx >= 14 ? tw : COLORS.TRACK_CROSSOVER_WIDTH
        ctx.strokeStyle = COLORS.TRACK_CROSSOVER
        ctx.stroke()
      }
      addObstacleSegment(ax, ay, bx, by, tw, Obstacle.switch)
      continue
    }

    // Terminal turn-backs: plain track (TrackLayer) unless reversed or hovered.
    if (!reversed && hoveredId !== g.sw.id) continue
    const p = g.path
    ctx.beginPath()
    ctx.moveTo(p[0], p[1])
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
    ctx.lineJoin = 'miter'
    if (hoveredId === g.sw.id) {
      ctx.lineWidth = tw + 4
      ctx.strokeStyle = COLORS.BORDER_STRONG
      ctx.stroke()
    }
    ctx.lineWidth = tw
    ctx.strokeStyle = reversed ? COLORS.SWITCH_REVERSE : COLORS.TRACK_CLEAR
    ctx.stroke()
  }
}
