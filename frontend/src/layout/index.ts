/**
 * Map layouts. `applyLayout` returns one stable topology object per (source topology, layout,
 * target size bucket), so every consumer (renderers, motion route index, hit tests) sees
 * consistent geometry.
 *
 * The schematic is sized for the usable map area (see `schematic.ts`). By default that area is
 * measured from the page when the layout is applied (the map canvas minus `setFitInsets`);
 * `setLayoutTarget` overrides it, and `layoutTargetChanged` tells the caller when a resize is
 * big enough (portrait ↔ landscape, or > 15 % aspect change) to be worth re-applying.
 */
import type { Topology } from '../types/domain'
import { buildSchematic, DEFAULT_TARGET, schematicVariantFor, type LayoutTarget } from './schematic'
import { getLayoutMeta, setLayoutMeta } from './meta'
import { getFitInsets } from '../render/Viewport'

export type MapLayout = 'schematic' | 'geographic'

const CACHE = new WeakMap<Topology, Map<string, Topology>>()

let override: LayoutTarget | null = null
let lastUsed: LayoutTarget | null = null

/** Force the schematic target size (CSS px of usable map area); null = measure the page. */
export function setLayoutTarget(target: LayoutTarget | null): void {
  override = target ? { width: Math.round(target.width), height: Math.round(target.height) } : null
}

/** The (bucketed) target the schematic was last laid out for (debug / tests). */
export function lastLayoutTarget(): LayoutTarget | null {
  return lastUsed
}

/** Usable map area right now: the largest canvas on the page minus the fit insets. */
export function measureLayoutTarget(): LayoutTarget {
  if (override) return override
  if (typeof window === 'undefined' || typeof document === 'undefined') return DEFAULT_TARGET
  let w = 0
  let h = 0
  for (const c of Array.from(document.querySelectorAll('canvas'))) {
    if (c.clientWidth * c.clientHeight > w * h) {
      w = c.clientWidth
      h = c.clientHeight
    }
  }
  if (w < 200 || h < 200) {
    // Canvas not laid out yet: estimate from the window (top bar + status bar).
    w = window.innerWidth
    h = window.innerHeight - (window.innerWidth < 720 ? 140 : 84)
  }
  const ins = getFitInsets()
  let uw = w - ins.left - ins.right
  let uh = h - ins.top - ins.bottom
  // Same guard as Viewport.fitToBounds: insets that leave too little room are ignored.
  if (uw < w * 0.45) uw = w
  if (uh < h * 0.45) uh = h
  return { width: Math.max(200, Math.round(uw)), height: Math.max(200, Math.round(uh)) }
}

/**
 * One cached layout per ~3 % step of each dimension. Targets snap DOWN to their bucket, so a
 * layout is never built for more room than the screen really has (labels stay on screen).
 */
const STEP = Math.log(1.03)

function snapToBucket(t: LayoutTarget): LayoutTarget {
  const q = (v: number) => Math.floor(Math.exp(Math.floor(Math.log(v) / STEP + 1e-9) * STEP))
  return { width: q(t.width), height: q(t.height) }
}

function bucket(t: LayoutTarget): string {
  return `${schematicVariantFor(t)}:${t.width}x${t.height}`
}

/**
 * True when the usable map area has changed enough since the schematic was last laid out that
 * re-applying the layout would noticeably improve it (orientation flip or > 15 % aspect change).
 */
export function layoutTargetChanged(): boolean {
  if (!lastUsed) return false
  const now = measureLayoutTarget()
  if (schematicVariantFor(now) !== schematicVariantFor(lastUsed)) return true
  const a = now.width / now.height
  const b = lastUsed.width / lastUsed.height
  return Math.abs(Math.log(a / b)) > Math.log(1.15)
}

export function applyLayout(src: Topology, layout: MapLayout, target?: LayoutTarget): Topology {
  let entry = CACHE.get(src)
  if (!entry) {
    entry = new Map()
    CACHE.set(src, entry)
  }
  if (layout === 'geographic') {
    const hit = entry.get('geographic')
    if (hit) return hit
    const meta = getLayoutMeta(src)
    setLayoutMeta(src, { ...meta, kind: 'geographic' })
    entry.set('geographic', src)
    return src
  }
  const t = snapToBucket(target ?? measureLayoutTarget())
  const key = bucket(t)
  lastUsed = t
  const hit = entry.get(key)
  if (hit) return hit
  const out = buildSchematic(src, { target: t })?.topology ?? src
  entry.set(key, out)
  return out
}

export { getLayoutMeta } from './meta'
export type { LayoutMeta, StationMeta } from './meta'
export type { LayoutTarget } from './schematic'
