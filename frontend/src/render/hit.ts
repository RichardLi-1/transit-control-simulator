/**
 * Screen-space hit areas for map glyphs, produced by the same geometry functions the layers
 * draw with (SignalLayer.signalGlyphs, SwitchLayer.switchGlyphs), so clicks always match what
 * is on screen. An area is a capsule: the segment a→b grown by r (a == b gives a circle).
 */
export interface HitArea {
  id: string
  ax: number
  ay: number
  bx: number
  by: number
  r: number
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax
  const aby = by - ay
  const l2 = abx * abx + aby * aby
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / l2)) : 0
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
}

/** Id of the area under (sx, sy) — the one whose edge is nearest — or null. */
export function pickHitArea(areas: HitArea[], sx: number, sy: number): string | null {
  let best: string | null = null
  let bestD = Infinity
  for (const a of areas) {
    const d = distToSegment(sx, sy, a.ax, a.ay, a.bx, a.by) - a.r
    if (d <= 0 && d < bestD) {
      bestD = d
      best = a.id
    }
  }
  return best
}

/** Finite-number guard for geometry coming from the network. */
export function finite(...v: number[]): boolean {
  for (const x of v) if (!Number.isFinite(x)) return false
  return true
}
