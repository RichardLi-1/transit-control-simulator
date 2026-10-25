/**
 * Station names: horizontal, on the outer side of the track pair. Queued into the shared label
 * pass (`motion/labels`) at the top priorities — terminals, then interchanges, then the rest —
 * so every other piece of map text (train ids, signal names, speed tags, yards) moves or gives
 * way around them. Drawn when TrainLayer flushes the pass.
 *
 * Interchanges carry small real line bullets (2 = Bloor–Danforth, 4 = Sheppard) and a neutral
 * GO tag at Union; terminals are set in a heavier weight, no decoration.
 */
import type { Topology } from '../../types/domain'
import type { Viewport } from '../Viewport'
import { COLORS } from '../../constants/colors'
import { getLayoutMeta } from '../../layout/meta'
import { stationLabelBoxes, type LabelBox, type Measure } from '../../layout/labels'
import { addLabel, LabelPriority } from '../../motion/labels'
import { drawText, mapFont, measureText } from '../text'

let measureCtx: CanvasRenderingContext2D | null = null
const measure: Measure = (text, font) => measureText(measureCtx, font, text)

function roundelColors(text: string): { fill: string; ink: string; stroke?: string } {
  if (text === '1') return { fill: COLORS.ACCENT, ink: COLORS.ACCENT_TEXT }
  if (text === '2') return { fill: COLORS.LINE_2, ink: '#ffffff' }
  if (text === '4') return { fill: COLORS.LINE_4, ink: '#ffffff' }
  return { fill: COLORS.BACKGROUND, ink: COLORS.TEXT_2, stroke: COLORS.BORDER_STRONG }
}

function drawRoundels(ctx: CanvasRenderingContext2D, b: LabelBox): void {
  const r = b.roundelR
  for (const rd of b.roundels) {
    const c = roundelColors(rd.text)
    const x = Math.round(rd.x)
    const y = Math.round(rd.y)
    ctx.beginPath()
    if (rd.text.length > 1) {
      const w = r * 2 + 8
      ctx.roundRect(x - w / 2 + 0.5, y - r + 0.5, w - 1, r * 2 - 1, 2)
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
    ctx.fillStyle = c.fill
    ctx.fill()
    if (c.stroke) {
      ctx.lineWidth = 1
      ctx.strokeStyle = c.stroke
      ctx.stroke()
    }
    const px = rd.text.length > 1 ? Math.max(7, r * 1.45) : Math.max(7, Math.round(r * 1.6))
    drawText(ctx, rd.text, x, y, mapFont(px, 600), c.ink, 'center', 0)
  }
}

function priorityOf(b: LabelBox): number {
  if (b.station.terminal) return LabelPriority.terminal
  if (b.station.priority === 2) return LabelPriority.interchange
  return LabelPriority.station
}

function colorOf(b: LabelBox): string {
  if (b.station.terminal) return COLORS.STATION_LABEL_TERMINAL
  if (b.station.priority === 2) return COLORS.STATION_LABEL_MAJOR
  return COLORS.STATION_LABEL
}

/** Queue station names for the shared label pass. */
export function renderLabelLayer(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  topology: Topology,
  showLabels: boolean = true,
): void {
  if (!showLabels) return
  try {
    queueStations(ctx, vp, topology)
  } catch (err) {
    if (!reported) {
      reported = true
      console.warn('[map] station labels skipped a frame:', err)
    }
  }
}

let reported = false

function queueStations(ctx: CanvasRenderingContext2D, vp: Viewport, topology: Topology): void {
  measureCtx = ctx
  const meta = getLayoutMeta(topology)
  if (!meta.stations.length) return

  for (const b of stationLabelBoxes(meta, vp, measure)) {
    if (![b.x, b.y, b.w, b.h, b.textX, b.textY].every(Number.isFinite)) continue
    if (b.x > vp.width + 40 || b.x + b.w < -40 || b.y > vp.height + 40 || b.y + b.h < -40) continue
    addLabel({
      key: `station:${b.station.name}`,
      priority: priorityOf(b),
      candidates: [{ x: b.x, y: b.y, w: b.w, h: b.h }],
      pad: 0,
      draw: (c) => {
        drawRoundels(c, b)
        drawText(c, b.station.name, b.textX, b.textY, b.font, colorOf(b), b.textAlign, 3)
      },
    })
  }
}
