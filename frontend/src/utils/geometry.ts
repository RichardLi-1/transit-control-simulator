import type { Vec2, Bounds } from '../types/domain'

export function polylineLength(points: Vec2[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

/** Interpolate a point at fraction t (0–1) along a polyline. */
export function interpolatePolyline(points: Vec2[], t: number): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return { ...points[0] }
  if (t <= 0) return { ...points[0] }
  if (t >= 1) return { ...points[points.length - 1] }

  const totalLen = polylineLength(points)
  const target = t * totalLen
  let accum = 0
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x
    const dy = points[i].y - points[i - 1].y
    const segLen = Math.sqrt(dx * dx + dy * dy)
    if (accum + segLen >= target) {
      const segT = (target - accum) / segLen
      return {
        x: points[i - 1].x + segT * dx,
        y: points[i - 1].y + segT * dy,
      }
    }
    accum += segLen
  }
  return { ...points[points.length - 1] }
}

/** Tangent direction at fraction t along a polyline (normalized). */
export function tangentAtT(points: Vec2[], t: number): Vec2 {
  if (points.length < 2) return { x: 1, y: 0 }
  const eps = 0.001
  const a = interpolatePolyline(points, Math.max(0, t - eps))
  const b = interpolatePolyline(points, Math.min(1, t + eps))
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  return { x: dx / len, y: dy / len }
}

export function polylineBounds(points: Vec2[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export function boundsUnion(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** Distance from point P to line segment AB, all in the same space. */
export function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  if (len2 === 0) {
    const dx = p.x - a.x, dy = p.y - a.y
    return Math.sqrt(dx * dx + dy * dy)
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
  const nearX = a.x + t * abx
  const nearY = a.y + t * aby
  const dx = p.x - nearX, dy = p.y - nearY
  return Math.sqrt(dx * dx + dy * dy)
}
