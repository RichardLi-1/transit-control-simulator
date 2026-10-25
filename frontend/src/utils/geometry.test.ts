import { describe, expect, it } from 'vitest'
import {
  boundsUnion,
  distPointToSegment,
  interpolatePolyline,
  polylineBounds,
  polylineLength,
  tangentAtT,
} from './geometry'

describe('polylineLength', () => {
  it('returns 0 for fewer than two points', () => {
    expect(polylineLength([])).toBe(0)
    expect(polylineLength([{ x: 1, y: 2 }])).toBe(0)
  })

  it('sums segment lengths', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 0 },
    ]
    expect(polylineLength(pts)).toBeCloseTo(5 + 4, 10)
  })
})

describe('interpolatePolyline', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]

  it('returns origin for empty polyline', () => {
    expect(interpolatePolyline([], 0.5)).toEqual({ x: 0, y: 0 })
  })

  it('returns the only point for a singleton', () => {
    const p = { x: 7, y: -3 }
    expect(interpolatePolyline([p], 0)).toEqual(p)
    expect(interpolatePolyline([p], 0.5)).toEqual(p)
  })

  it('clamps t to endpoints', () => {
    expect(interpolatePolyline(line, -1)).toEqual({ x: 0, y: 0 })
    expect(interpolatePolyline(line, 0)).toEqual({ x: 0, y: 0 })
    expect(interpolatePolyline(line, 1)).toEqual({ x: 10, y: 0 })
    expect(interpolatePolyline(line, 2)).toEqual({ x: 10, y: 0 })
  })

  it('interpolates at fractional arclength', () => {
    expect(interpolatePolyline(line, 0.25)).toEqual({ x: 2.5, y: 0 })
    expect(interpolatePolyline(line, 0.5)).toEqual({ x: 5, y: 0 })
  })

  it('follows a bent path by cumulative length', () => {
    const bent = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ]
    // halfway along total length 20 → corner
    expect(interpolatePolyline(bent, 0.5)).toEqual({ x: 0, y: 10 })
    // three quarters → halfway along second segment
    expect(interpolatePolyline(bent, 0.75)).toEqual({ x: 5, y: 10 })
  })
})

describe('tangentAtT', () => {
  it('defaults when there are fewer than two points', () => {
    expect(tangentAtT([], 0.5)).toEqual({ x: 1, y: 0 })
    expect(tangentAtT([{ x: 1, y: 1 }], 0.5)).toEqual({ x: 1, y: 0 })
  })

  it('is unit length along a horizontal segment', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    const v = tangentAtT(line, 0.33)
    expect(v.x).toBeCloseTo(1, 10)
    expect(v.y).toBeCloseTo(0, 10)
  })
})

describe('polylineBounds', () => {
  it('returns infinities for an empty list', () => {
    expect(polylineBounds([])).toEqual({
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    })
  })

  it('wraps a single point', () => {
    expect(polylineBounds([{ x: 2, y: -5 }])).toEqual({
      minX: 2,
      minY: -5,
      maxX: 2,
      maxY: -5,
    })
  })

  it('expands over multiple points', () => {
    const b = polylineBounds([
      { x: 1, y: 4 },
      { x: -2, y: 0 },
      { x: 0, y: 7 },
    ])
    expect(b).toEqual({ minX: -2, minY: 0, maxX: 1, maxY: 7 })
  })
})

describe('boundsUnion', () => {
  it('takes the extrema of both rectangles', () => {
    const a = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
    const b = { minX: -1, minY: 2, maxX: 3, maxY: 4 }
    expect(boundsUnion(a, b)).toEqual({ minX: -1, minY: 0, maxX: 3, maxY: 4 })
  })
})

describe('distPointToSegment', () => {
  it('treats a zero-length segment as distance to A', () => {
    const a = { x: 0, y: 0 }
    const p = { x: 3, y: 4 }
    expect(distPointToSegment(p, a, a)).toBeCloseTo(5, 10)
  })

  it('is perpendicular distance when projection lies on segment', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 0 }
    expect(distPointToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 10)
  })

  it('clamps to endpoints when projection is outside', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 0 }
    expect(distPointToSegment({ x: -4, y: 3 }, a, b)).toBeCloseTo(5, 10)
    expect(distPointToSegment({ x: 14, y: 3 }, a, b)).toBeCloseTo(5, 10)
  })
})
