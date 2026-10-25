/**
 * Quick-look card for the train / signal / switch under the pointer. Positioned in canvas
 * coordinates inside the map area; never takes pointer events.
 */
import { memo, useEffect, useState } from 'react'
import type { HoveredEntity, SignalAspect } from '../types/domain'
import { COLORS } from '../constants/colors'
import { useRuntimeStore } from '../store/runtimeStore'
import { useTopologyStore } from '../store/topologyStore'
import { entityInfo, TONE_TEXT, type EntityInfo } from '../lib/trainInfo'
import { cn } from '../lib/utils'

interface Props {
  hovered: HoveredEntity
  /** Size of the map area. */
  bounds: { w: number; h: number }
}

/** Re-evaluate at this rate; React only re-renders when the visible text changes. */
const REFRESH_MS = 100
const CARD_W = 224
const CARD_H_GUESS = 180

const ASPECT_COLOR: Record<SignalAspect, () => string> = {
  green: () => COLORS.SIGNAL_GREEN,
  yellow: () => COLORS.SIGNAL_YELLOW,
  flashing_yellow: () => COLORS.SIGNAL_FLASHING_YELLOW,
  red: () => COLORS.SIGNAL_RED,
  dark: () => COLORS.SIGNAL_DARK,
}

function compute(hovered: HoveredEntity): { key: string; info: EntityInfo } | null {
  const topology = useTopologyStore.getState().topology
  const runtime = useRuntimeStore.getState().runtime
  if (!topology || !runtime) return null
  const info = entityInfo(hovered, topology, runtime)
  return { key: JSON.stringify(info), info }
}

function MapHoverCardImpl({ hovered, bounds }: Props) {
  const [state, setState] = useState(() => compute(hovered))

  useEffect(() => {
    const refresh = () => {
      const next = compute(hovered)
      setState((prev) => (prev?.key === next?.key ? prev : next))
    }
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [hovered.kind, hovered.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return null
  const { info } = state
  // Prefer below-right of the pointer; flip when it would leave the map.
  const right = hovered.screenX + 14 + CARD_W > bounds.w
  const below = hovered.screenY + 14 + CARD_H_GUESS <= bounds.h
  const x = Math.max(6, right ? hovered.screenX - 14 - CARD_W : hovered.screenX + 14)
  const y = below ? hovered.screenY + 14 : Math.max(6, hovered.screenY - 14 - CARD_H_GUESS)

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 rounded-sm border border-border-strong bg-popover text-xs text-popover-foreground"
      style={{ left: x, top: y, width: CARD_W }}
    >
      <div className="flex items-baseline justify-between gap-2 border-b px-2.5 py-1.5">
        <span className="shrink-0 text-sm font-medium">{info.title}</span>
        {info.subtitle && <span className="min-w-0 truncate text-2xs text-muted-foreground">{info.subtitle}</span>}
      </div>
      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        {info.aspect && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[1px]" style={{ background: ASPECT_COLOR[info.aspect]() }} />
            <span className="capitalize">{info.aspect.replace('_', ' ')}</span>
          </span>
        )}
        {info.status && <p className={cn('leading-snug', TONE_TEXT[info.status.tone])}>{info.status.text}</p>}
        {info.rows.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {info.rows.filter((r) => !(info.aspect && r.k === 'Aspect')).map((r) => (
              <div key={r.k} className="contents">
                <dt className="text-muted-foreground">{r.k}</dt>
                <dd className={cn('truncate text-right', r.mono && 'num text-[11px]', TONE_TEXT[r.tone ?? 'normal'])}>{r.v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}

export const MapHoverCard = memo(MapHoverCardImpl, (a, b) =>
  a.hovered.kind === b.hovered.kind
  && a.hovered.id === b.hovered.id
  && Math.abs(a.hovered.screenX - b.hovered.screenX) < 1
  && Math.abs(a.hovered.screenY - b.hovered.screenY) < 1
  && a.bounds.w === b.bounds.w
  && a.bounds.h === b.bounds.h,
)
