/**
 * Displayed-speed hysteresis.
 *
 * The shown integer km/h only changes when the true (interpolated) speed moves more than
 * HYSTERESIS_KMH away from it, so sensor-style noise around x.5 can't make "19 ↔ 20"
 * flicker, while a real ramp still updates every ~1 km/h (lag ≤ HYSTERESIS_KMH, i.e.
 * ~0.25 s at 1 m/s²). A stationary train always shows exactly 0; a moving one never
 * shows 0 (min 1) so "stopped" and "creeping" are distinguishable.
 *
 * 0.9 rather than ~0.6: with a 0.6 band, ±0.2 noise around 19.5 is ≥0.6 from both
 * 19 and 20 and still toggles. 0.9 tolerates ±0.35 noise around any x.5.
 */
export const HYSTERESIS_KMH = 0.9

export function nextDisplayedKmh(prev: number | null | undefined, trueKmh: number, stationary: boolean): number {
  if (stationary || !Number.isFinite(trueKmh)) return 0
  const k = Math.max(0, trueKmh)
  if (prev == null || prev === 0) return Math.max(1, Math.round(k))
  if (Math.abs(k - prev) > HYSTERESIS_KMH) return Math.max(1, Math.round(k))
  return prev
}

/** Per-train displayed speed memory. */
export class SpeedDisplay {
  private shown = new Map<string, number>()

  update(id: string, trueKmh: number, stationary: boolean): number {
    const v = nextDisplayedKmh(this.shown.get(id), trueKmh, stationary)
    this.shown.set(id, v)
    return v
  }

  get(id: string): number | undefined {
    return this.shown.get(id)
  }

  /** Drop trains no longer present. */
  retain(ids: Set<string>): void {
    for (const id of this.shown.keys()) if (!ids.has(id)) this.shown.delete(id)
  }

  clear(): void {
    this.shown.clear()
  }
}
