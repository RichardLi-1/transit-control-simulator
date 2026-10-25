/**
 * One label-placement pass for every piece of text on the map.
 *
 * Each frame, layers register
 *   • obstacles — screen-space things text must never cover: track segments, platforms, signal
 *     glyphs, crossovers, yard fans (tagged by kind so a label can opt out of some kinds), and
 *   • label requests — a priority, a few candidate boxes in preference order and a draw callback.
 *
 * `flushLabels` (called by the last layer, TrainLayer) sorts requests by priority and gives each
 * the first candidate that touches neither an obstacle it avoids nor a label already placed;
 * a request with no free candidate is culled (focus labels are forced). Text is then drawn on
 * top of all geometry. Lower-priority text therefore moves or disappears — it never overlaps.
 *
 * Priority (lower = placed first):
 *   focus train · terminals · interchanges · stations · yards · hovered signal · signal names ·
 *   speed tags · trains with a dispatch badge · other trains
 *
 * The solver (`placeLabels`) is pure; the frame queue is a module singleton like a canvas state.
 */

export interface Box { x: number; y: number; w: number; h: number }

export const LabelPriority = {
  focus: 0,
  terminal: 10,
  interchange: 11,
  station: 12,
  yard: 20,
  signalHover: 24,
  signal: 30,
  speed: 40,
  trainBadge: 50,
  train: 60,
} as const

/** Obstacle kinds (bit flags). */
export const Obstacle = {
  track: 1,
  platform: 2,
  signal: 4,
  switch: 8,
  yard: 16,
  all: 31,
} as const

export interface LabelRequest {
  /** Stable id (debugging, tests). */
  key: string
  priority: number
  /** Candidate boxes, best first. */
  candidates: Box[]
  /** Obstacle kinds this label must keep clear of (default: all). */
  avoid?: number
  /** Clearance kept around the box, px (default 1). */
  pad?: number
  /** Place the first candidate even if every candidate is blocked. */
  force?: boolean
  draw?: (ctx: CanvasRenderingContext2D, box: Box, index: number) => void
  /** Called with the chosen candidate once placed (before drawing). */
  placed?: (box: Box, index: number) => void
}

export interface Placement { request: LabelRequest; box: Box; index: number }

/** Flat, allocation-light obstacle store. */
export class ObstacleSet {
  /** x, y, w, h, kind */
  rects: number[] = []
  /** ax, ay, bx, by, halfWidth, kind */
  segs: number[] = []

  clear(): void {
    this.rects.length = 0
    this.segs.length = 0
  }

  rect(x: number, y: number, w: number, h: number, kind: number): void {
    this.rects.push(x, y, w, h, kind)
  }

  segment(ax: number, ay: number, bx: number, by: number, halfWidth: number, kind: number): void {
    this.segs.push(ax, ay, bx, by, halfWidth, kind)
  }

  /** Screen polyline given as flat [x0, y0, x1, y1, …]. */
  polyline(pts: ArrayLike<number>, halfWidth: number, kind: number): void {
    for (let i = 2; i + 1 < pts.length; i += 2) this.segs.push(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], halfWidth, kind)
  }

  /** Does box (grown by pad) touch any obstacle whose kind is in `mask`? */
  hits(b: Box, mask: number, pad: number): boolean {
    if (!mask) return false
    const x0 = b.x - pad
    const y0 = b.y - pad
    const x1 = b.x + b.w + pad
    const y1 = b.y + b.h + pad
    const r = this.rects
    for (let i = 0; i < r.length; i += 5) {
      if (!(r[i + 4] & mask)) continue
      if (x0 < r[i] + r[i + 2] && x1 > r[i] && y0 < r[i + 1] + r[i + 3] && y1 > r[i + 1]) return true
    }
    const s = this.segs
    for (let i = 0; i < s.length; i += 6) {
      if (!(s[i + 5] & mask)) continue
      if (capsuleHitsRect(s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4], x0, y0, x1, y1)) return true
    }
    return false
  }
}

function distPointRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0
  return Math.hypot(dx, dy)
}

function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax
  const aby = by - ay
  const l2 = abx * abx + aby * aby
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2)) : 0
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
}

/** Exact test: does the capsule (segment a→b, radius hw) touch the rect [x0,x1]×[y0,y1]? */
export function capsuleHitsRect(ax: number, ay: number, bx: number, by: number, hw: number, x0: number, y0: number, x1: number, y1: number): boolean {
  if (Math.max(ax, bx) + hw < x0 || Math.min(ax, bx) - hw > x1 || Math.max(ay, by) + hw < y0 || Math.min(ay, by) - hw > y1) return false
  if (segmentHitsRect(ax, ay, bx, by, x0, y0, x1, y1)) return true
  if (hw <= 0) return false
  if (distPointRect(ax, ay, x0, y0, x1, y1) <= hw || distPointRect(bx, by, x0, y0, x1, y1) <= hw) return true
  return (
    distPointSeg(x0, y0, ax, ay, bx, by) <= hw || distPointSeg(x1, y0, ax, ay, bx, by) <= hw ||
    distPointSeg(x1, y1, ax, ay, bx, by) <= hw || distPointSeg(x0, y1, ax, ay, bx, by) <= hw
  )
}

/** Liang–Barsky: does segment a→b intersect the axis-aligned rect [x0,x1]×[y0,y1]? */
export function segmentHitsRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  // quick reject on bounding boxes
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) return false
  const dx = bx - ax
  const dy = by - ay
  let t0 = 0
  let t1 = 1
  for (let k = 0; k < 4; k++) {
    const p = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dy : dy
    const q = k === 0 ? ax - x0 : k === 1 ? x1 - ax : k === 2 ? ay - y0 : y1 - ay
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
      else { if (t < t0) return false; if (t < t1) t1 = t }
    }
  }
  return t0 <= t1
}

export function boxesTouch(a: Box, b: Box, pad = 0): boolean {
  return a.x - pad < b.x + b.w && b.x - pad < a.x + a.w && a.y - pad < b.y + b.h && b.y - pad < a.y + a.h
}

function offScreen(b: Box, view: { width: number; height: number } | null): boolean {
  if (!view) return false
  return b.x > view.width || b.x + b.w < 0 || b.y > view.height || b.y + b.h < 0
}

/**
 * Resolve requests (pure). Returns the placed labels in placement order (highest priority first).
 * Candidates entirely off screen are skipped.
 */
export function placeLabels(requests: LabelRequest[], obstacles: ObstacleSet, view: { width: number; height: number } | null = null): Placement[] {
  const order = requests.map((_, i) => i)
  order.sort((a, b) => requests[a].priority - requests[b].priority || a - b)
  const out: Placement[] = []
  for (const i of order) {
    const r = requests[i]
    const mask = r.avoid ?? Obstacle.all
    const pad = r.pad ?? 1
    let chosen = -1
    let firstOnScreen = -1
    for (let k = 0; k < r.candidates.length; k++) {
      const c = r.candidates[k]
      if (offScreen(c, view)) continue
      if (firstOnScreen < 0) firstOnScreen = k
      if (obstacles.hits(c, mask, pad)) continue
      let clash = false
      for (const p of out) if (boxesTouch(p.box, c, pad)) { clash = true; break }
      if (clash) continue
      chosen = k
      break
    }
    if (chosen < 0 && r.force && r.candidates.length) chosen = firstOnScreen >= 0 ? firstOnScreen : 0
    if (chosen < 0) continue
    out.push({ request: r, box: r.candidates[chosen], index: chosen })
  }
  return out
}

// ── per-frame queue ─────────────────────────────────────────────────────────

const queue: LabelRequest[] = []
const frameObstacles = new ObstacleSet()
let lastPlaced: Placement[] = []
let lastQueue: LabelRequest[] = []
const lastObstacles = new ObstacleSet()

/** Start a frame: forget last frame's requests and obstacles. Called by the first map layer. */
export function beginLabelFrame(): void {
  queue.length = 0
  frameObstacles.clear()
}

export function addLabel(r: LabelRequest): void {
  queue.push(r)
}

export function addObstacleRect(x: number, y: number, w: number, h: number, kind: number): void {
  frameObstacles.rect(x, y, w, h, kind)
}

export function addObstacleSegment(ax: number, ay: number, bx: number, by: number, halfWidth: number, kind: number): void {
  frameObstacles.segment(ax, ay, bx, by, halfWidth, kind)
}

export function addObstaclePolyline(pts: ArrayLike<number>, halfWidth: number, kind: number): void {
  frameObstacles.polyline(pts, halfWidth, kind)
}

/** Obstacles registered so far this frame (read-only use). */
export function labelObstacles(): ObstacleSet {
  return frameObstacles
}

/**
 * Place every queued label and draw them (lowest priority first, so the most important text is
 * painted last). Clears the queue.
 */
export function flushLabels(ctx: CanvasRenderingContext2D | null, view: { width: number; height: number }): Placement[] {
  const placed = placeLabels(queue, frameObstacles, view)
  for (const p of placed) p.request.placed?.(p.box, p.index)
  if (ctx) {
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]
      if (!p.request.draw) continue
      ctx.save()
      p.request.draw(ctx, p.box, p.index)
      ctx.restore()
    }
  }
  lastQueue = queue.slice()
  lastObstacles.rects = frameObstacles.rects.slice()
  lastObstacles.segs = frameObstacles.segs.slice()
  queue.length = 0
  lastPlaced = placed
  return placed
}

/**
 * Debug: why was a label (by key prefix) culled last frame? For each candidate, the first
 * obstacle kind or placed label it touches.
 */
export function explainLabel(keyPrefix: string): { key: string; candidates: { box: Box; blockedBy: string }[] }[] {
  const out: { key: string; candidates: { box: Box; blockedBy: string }[] }[] = []
  for (const r of lastQueue) {
    if (!r.key.startsWith(keyPrefix)) continue
    const mask = r.avoid ?? Obstacle.all
    const pad = r.pad ?? 1
    out.push({
      key: r.key,
      candidates: r.candidates.map((c) => {
        let blockedBy = 'free'
        for (const [name, kind] of Object.entries(Obstacle)) {
          if (name === 'all' || !(kind & mask)) continue
          if (lastObstacles.hits(c, kind, pad)) {
            const r5 = lastObstacles.rects
            let at = ''
            for (let i = 0; i < r5.length; i += 5) {
              if ((r5[i + 4] & kind) && boxesTouch({ x: r5[i], y: r5[i + 1], w: r5[i + 2], h: r5[i + 3] }, c, pad)) at = ` @${r5.slice(i, i + 4).map((v) => Math.round(v)).join(',')}`
            }
            blockedBy = `obstacle:${name}${at}`
            break
          }
        }
        if (blockedBy === 'free') {
          const p = lastPlaced.find((q) => q.request !== r && boxesTouch(q.box, c, pad))
          if (p) blockedBy = `label:${p.request.key}`
        }
        return { box: c, blockedBy }
      }),
    })
  }
  return out
}

/** Labels placed in the last flushed frame (debug / tests). */
export function lastPlacements(): Placement[] {
  return lastPlaced
}
