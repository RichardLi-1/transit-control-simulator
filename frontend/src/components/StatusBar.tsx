/**
 * Bottom status bar: link state, service summary, dev tools, legend.
 */
import { useRuntimeStore } from '../store/runtimeStore'
import { useConnectionStore } from '../store/connectionStore'
import { useUiStore } from '../store/uiStore'
import { useIsMobile } from '../hooks/useIsMobile'
import { fmtDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import { LegendPopover } from './Legend'
import { SimSpeedControl } from './SimSpeedControl'
import { EndpointHealth } from './EndpointHealth'
import { StatusDot, type LinkTone } from './StatusDot'

export function useLinkState(): { tone: LinkTone; label: string; detail: string } {
  const mockMode = useConnectionStore((s) => s.mockMode)
  const stateHealth = useConnectionStore((s) => s.endpoints.state.health)
  const stale = useRuntimeStore((s) => s.stale)
  const hasRuntime = useRuntimeStore((s) => s.runtime != null)
  if (mockMode) return { tone: 'caution', label: 'Demo data', detail: 'Simulator unreachable. Showing a local demo run.' }
  if (stateHealth === 'error') return { tone: 'danger', label: 'Offline', detail: 'Lost contact with the simulator.' }
  if (stale) return { tone: 'caution', label: 'Reconnecting', detail: 'No fresh data for 2 s. Retrying.' }
  if (!hasRuntime) return { tone: 'off', label: 'Connecting', detail: 'Waiting for the first update.' }
  return { tone: 'ok', label: 'Live', detail: 'Connected to the simulator.' }
}

const LINK_TEXT: Record<LinkTone, string> = {
  ok: 'text-foreground',
  caution: 'text-caution',
  danger: 'text-danger',
  off: 'text-muted-foreground',
}

function LinkStatus() {
  const link = useLinkState()
  return (
    <span role="status" aria-live="polite" title={link.detail} className="flex items-center gap-1.5">
      <StatusDot tone={link.tone} />
      <span className={cn('font-medium', LINK_TEXT[link.tone])}>
        {link.label}
      </span>
    </span>
  )
}

function ServiceSummary({ compact }: { compact?: boolean }) {
  const runtime = useRuntimeStore((s) => s.runtime)
  const svc = runtime?.ops?.service
  const trains = svc?.trains_in_service ?? runtime?.trains?.length ?? 0
  const target = svc?.target_headway_s ?? runtime?.ops?.dispatch?.target_headway_sec ?? null
  const actual = svc?.mean_headway_s ?? null
  return (
    <>
      <span title="Trains in passenger service">
        <span className="num text-foreground">{trains}</span> trains
      </span>
      <span title="Measured headway / target">
        {compact ? 'hw' : 'Headway'} <span className="num text-foreground">{fmtDuration(actual ?? target)}</span>
        {actual != null && target != null && <span className="num"> / {fmtDuration(target)}</span>}
      </span>
      {svc?.period && !compact && <span>{svc.period}</span>}
    </>
  )
}

export function StatusBar() {
  const devMode = useUiStore((s) => s.devMode)
  const isMobile = useIsMobile()
  return (
    <footer data-help="status" className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t bg-card px-3 text-[11px] whitespace-nowrap text-muted-foreground">
      <LinkStatus />
      {devMode && <EndpointHealth />}
      <Separator orientation="vertical" className="h-3!" />
      <ServiceSummary compact={isMobile} />
      <div className="flex-1" />
      {devMode && !isMobile && <SimSpeedControl />}
      <LegendPopover />
    </footer>
  )
}
