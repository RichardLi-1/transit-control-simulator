/**
 * Station label geometry (screen space) + greedy priority culling.
 * Pure: the LabelLayer passes a real canvas measure, the layout and tests an approximate one.
 *
 * Labels sit on the outer side of the track pair (the ob track side), clear of the wayside
 * signal glyphs that share that side. Terminals are emphasised by weight, interchanges by a
 * brighter weight plus small real line bullets (2, 4) — Line 1 itself needs no bullet.
 */
import type { LayoutMeta, StationMeta } from './meta'
import { MAP_TYPE, mapFont } from '../render/text'

export interface ViewLike {
  width: number
  height: number
  camera: { zoom: number }
  worldToScreen(wx: number, wy: number): [number, number]
}

export type LabelSide = 'left' | 'right' | 'above' | 'below'

export interface LabelBox {
  station: StationMeta
  side: LabelSide
  font: string
  fontPx: number
  /** Text anchor (screen). For left/right: vertical centre of the text; above/below: horizontal centre. */
  textX: number
  textY: number
  textAlign: CanvasTextAlign
  textW: number
  /** Bullet centres (screen) for connections, track side of the text. */
  roundels: { x: number; y: number; text: string }[]
  roundelR: number
  /** Collision box (screen), includes roundels + a small pad. */
  x: number
  y: number
  w: number
  h: number
}

export type Measure = (text: string, font: string, fontPx: number) => number

/** Width estimate used by the layout / tests / before fonts load: IBM Plex Sans ≈ 0.58 em. */
export const approxMeasure: Measure = (text, _font, fontPx) => text.length * fontPx * 0.58

export interface LabelOptions {
  /** Base font px for station names. */
  basePx?: number
}

/**
 * Wayside signal glyph scale for a given track separation in px — shared by the SignalLayer
 * (drawing) and label clearance, so names never sit on a signal head.
 */
export function signalGlyphScale(sepPx: number): number {
  return Math.max(0.75, Math.min(1.5, sepPx / 12))
}

/** How far a signal glyph reaches out from its rail, px. */
export function signalGlyphExtent(sepPx: number): number {
  const g = signalGlyphScale(sepPx)
  return 2.5 + 7.75 * g
}

/** Clearance from the station centre line to the label edge, screen px. */
export function labelClearance(sepPx: number): number {
  return sepPx / 2 + Math.max(13, signalGlyphExtent(sepPx) + 5)
}

function roundelWidth(text: string, r: number): number {
  return text.length > 1 ? r * 2 + 8 : r * 2
}

export function stationLabelBoxes(meta: LayoutMeta, vp: ViewLike, measure: Measure, opts: LabelOptions = {}): LabelBox[] {
  const zoom = vp.camera.zoom
  const sepPx = meta.trackSep * zoom
  const basePx = opts.basePx ?? (vp.width < 520 ? MAP_TYPE.stationPhone : MAP_TYPE.station)
  const clear = labelClearance(sepPx)
  const out: LabelBox[] = []

  for (const st of meta.stations) {
    const fontPx = basePx
    const weight = st.terminal ? 600 : st.priority === 2 ? 500 : 400
    const font = mapFont(fontPx, weight)
    const textW = measure(st.name, font, fontPx)
    const h = Math.round(fontPx * 1.3)
    const roundelR = Math.max(4, Math.round(fontPx * 0.4))
    const bullets = st.connections
    const bulletW = bullets.reduce((acc, b) => acc + roundelWidth(b, roundelR) + 3, 0)

    const [cx, cy] = vp.worldToScreen(st.center.x, st.center.y)
    const o = st.outward
    let side: LabelSide
    if (Math.abs(o.x) >= 0.38) side = o.x < 0 ? 'left' : 'right'
    else side = o.y < 0 ? 'above' : 'below'

    const roundels: LabelBox['roundels'] = []
    let textX: number
    let textY: number
    let textAlign: CanvasTextAlign
    let bx: number
    let by: number
    const bw = bulletW + textW
    const bh = h

    if (side === 'left' || side === 'right') {
      const ax = Math.abs(o.x)
      // On a diagonal the track crosses the label's vertical band; push further out.
      const dx = clear / ax + (h / 2) * (Math.abs(o.y) / ax)
      const sign = side === 'left' ? -1 : 1
      const edge = cx + sign * dx
      // Track side first: bullets, then the name.
      let cursor = edge
      for (const b of bullets) {
        const rw = roundelWidth(b, roundelR)
        roundels.push({ x: cursor + sign * (rw / 2), y: cy, text: b })
        cursor += sign * (rw + 3)
      }
      textAlign = side === 'left' ? 'right' : 'left'
      textX = cursor
      textY = cy
      bx = side === 'left' ? edge - bw : edge
      by = cy - h / 2
    } else {
      const sign = side === 'above' ? -1 : 1
      const ay = Math.abs(o.y) || 1
      const centreY = cy + sign * (clear / ay + h / 2)
      bx = cx - bw / 2
      let cursor = bx
      for (const b of bullets) {
        const rw = roundelWidth(b, roundelR)
        roundels.push({ x: cursor + rw / 2, y: centreY, text: b })
        cursor += rw + 3
      }
      textAlign = 'left'
      textX = cursor
      textY = centreY
      by = centreY - h / 2
    }

    const pad = 2
    out.push({
      station: st, side, font, fontPx, textX, textY, textAlign, textW, roundels, roundelR,
      x: bx - pad, y: by - pad, w: bw + pad * 2, h: bh + pad * 2,
    })
  }
  return out
}

export function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Keep the most important labels that don't collide: terminals, then interchanges, then the rest
 * (in line order). Labels fully off screen are dropped. (The map itself resolves station labels
 * in the shared placement pass, `motion/labels`, with the same priorities; this pure version is
 * used by the layout and tests.)
 */
export function cullLabels(boxes: LabelBox[], vp: { width: number; height: number }): LabelBox[] {
  const order = [...boxes].sort((a, b) => b.station.priority - a.station.priority || a.station.index - b.station.index)
  const kept: LabelBox[] = []
  for (const b of order) {
    if (b.x > vp.width || b.x + b.w < 0 || b.y > vp.height || b.y + b.h < 0) continue
    if (kept.some((k) => boxesOverlap(k, b))) continue
    kept.push(b)
  }
  return kept
}
