/**
 * Map typography: IBM Plex Sans for names, IBM Plex Mono for ids / numbers — the same families
 * as the DOM console theme. Every canvas layer builds its font strings here so the map has one
 * type scale:
 *
 *   station names        12 px (11 px on phones)  400 regular · 500 interchange · 600 terminal
 *   train ids            10 px mono 500
 *   secondary (km/h, signal names, speed tags, yards)  10 px mono / sans
 *
 * Text is drawn at whole CSS pixels (the canvas is already scaled by devicePixelRatio), with a
 * thin knockout in the background colour instead of a glow.
 */
import { COLORS } from '../constants/colors'

export const MAP_FONT = {
  sans: "'IBM Plex Sans', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const

export const MAP_TYPE = {
  station: 12,
  stationPhone: 11,
  train: 10,
  secondary: 10,
  tiny: 9,
} as const

export function mapFont(px: number, weight: number = 400, family: string = MAP_FONT.sans): string {
  return `${weight} ${px}px ${family}`
}

export const monoFont = (px: number, weight = 500) => mapFont(px, weight, MAP_FONT.mono)

// ── font loading ────────────────────────────────────────────────────────────
// Canvas text only uses a web font once the browser has loaded it, and a face declared with
// @font-face is only fetched when something asks for it. Ask once for every face the map uses;
// when they arrive, measurements are invalidated so labels re-measure with the real metrics.
let fontEpoch = 0
let requested = false

/** Bumped whenever map fonts finish loading (measure caches key on it). */
export function mapFontEpoch(): number {
  return fontEpoch
}

export function ensureMapFonts(): void {
  if (requested || typeof document === 'undefined' || !document.fonts) return
  requested = true
  const faces = [
    mapFont(12, 400), mapFont(12, 500), mapFont(12, 600),
    monoFont(10, 400), monoFont(10, 500), monoFont(10, 600),
  ]
  void Promise.all(faces.map((f) => document.fonts.load(f).catch(() => [])))
    .then(() => document.fonts.ready)
    .then(() => { fontEpoch++ })
  document.fonts.addEventListener?.('loadingdone', () => { fontEpoch++ })
}

// ── measuring ───────────────────────────────────────────────────────────────
const widths = new Map<string, number>()
let widthsEpoch = -1
let scratch: CanvasRenderingContext2D | null = null

/** Text width in CSS px (memoised per font + text, invalidated when fonts load). */
export function measureText(ctx: CanvasRenderingContext2D | null, font: string, text: string): number {
  if (widthsEpoch !== fontEpoch) {
    widths.clear()
    widthsEpoch = fontEpoch
  }
  const key = font + '|' + text
  let w = widths.get(key)
  if (w != null) return w
  const c = ctx ?? scratch
  if (!c) return text.length * parseFloat(font.split(' ')[1] || '11') * 0.56
  scratch = c
  const prev = c.font
  c.font = font
  w = c.measureText(text).width
  c.font = prev
  if (widths.size > 4000) widths.clear()
  widths.set(key, w)
  return w
}

// ── drawing ─────────────────────────────────────────────────────────────────

/**
 * Fill text with a background-coloured knockout so it stays legible over the MA line or a
 * passing train label. `knock` is the knockout stroke width (0 = none).
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = 'left',
  knock = 3,
): void {
  ctx.font = font
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  const rx = Math.round(x)
  const ry = Math.round(y)
  if (knock > 0) {
    ctx.lineJoin = 'round'
    ctx.lineWidth = knock
    ctx.strokeStyle = COLORS.BACKGROUND
    ctx.strokeText(text, rx, ry)
  }
  ctx.fillStyle = color
  ctx.fillText(text, rx, ry)
}

/** Snap a CSS-px coordinate to the device-pixel grid (crisp 1 px lines: pass odd = true). */
export function snap(v: number, odd = false): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const s = Math.round(v * dpr) / dpr
  return odd ? s + 0.5 / dpr : s
}
