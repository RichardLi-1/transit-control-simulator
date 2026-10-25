import { describe, expect, it } from 'vitest'
import { HYSTERESIS_KMH, SpeedDisplay, nextDisplayedKmh } from './speedDisplay'

describe('displayed speed hysteresis', () => {
  it('does not toggle on noise around 19.5 km/h', () => {
    const sd = new SpeedDisplay()
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const shown = new Set<number>()
    sd.update('T1', 19.5, false)
    for (let i = 0; i < 2000; i++) {
      const v = 19.5 + (rand() * 2 - 1) * 0.35
      shown.add(sd.update('T1', v, false))
    }
    expect(shown.size).toBe(1)
  })

  it('also ignores a bang-bang wobble of ±0.4 around 20', () => {
    let d: number | null = null
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) {
      d = nextDisplayedKmh(d, i % 2 ? 20.4 : 19.6, false)
      seen.add(d)
    }
    expect(seen.size).toBe(1)
  })

  it('tracks a real ramp 0 → 60 km/h continuously', () => {
    const sd = new SpeedDisplay()
    const shown: number[] = []
    // 1 m/s² ≈ 3.6 km/h/s sampled at 60 fps
    for (let i = 0; i <= 60 * 60 / 3.6; i++) {
      const v = Math.min(60, i * 3.6 / 60)
      const d = sd.update('T1', v, i === 0)
      shown.push(d)
      expect(Math.abs(d - v)).toBeLessThanOrEqual(HYSTERESIS_KMH + 0.5)
    }
    expect(shown[0]).toBe(0)
    expect(shown[shown.length - 1]).toBe(60)
    // monotone non-decreasing, unit steps (never jumps by more than 1 km/h at 60 fps)
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1])
      expect(shown[i] - shown[i - 1]).toBeLessThanOrEqual(1)
    }
    // and actually passes through every integer from 1 to 60
    for (let k = 1; k <= 60; k++) expect(shown).toContain(k)
  })

  it('braking reads correctly and ends at exactly 0 when stationary', () => {
    let d: number | null = 45
    for (let v = 45; v > 0.3; v -= 0.06) d = nextDisplayedKmh(d, v, false)
    expect(d).toBeLessThanOrEqual(2)
    expect(d).toBeGreaterThanOrEqual(1) // still moving → never 0
    expect(nextDisplayedKmh(d, 0.2, true)).toBe(0)
  })

  it('a moving train never shows 0', () => {
    expect(nextDisplayedKmh(0, 0.3, false)).toBe(1)
  })
})
