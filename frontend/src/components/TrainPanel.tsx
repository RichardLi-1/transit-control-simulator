/**
 * Inspector → Train. With a train selected: live read-outs and dispatcher commands. Otherwise the
 * fleet roster, which doubles as a way to select a train without finding it on the map.
 */
import { useMemo } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { DispatchAction, TrainPosition } from '../types/domain'
import { COLORS } from '../constants/colors'
import { useRuntimeStore } from '../store/runtimeStore'
import { useUiStore } from '../store/uiStore'
import { drawnTrain, shownKmh, trainOverride, trainReadouts, trainStatus, TONE_TEXT } from '@/lib/trainInfo'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Field, Fields, Section } from './Readouts'

/** Same colour the map draws the train body in (see Legend). */
function trainColor(t: TrainPosition): string {
  if (t.stop_reason === 'emergency_brake' || t.e_brake) return COLORS.TRAIN_EBRAKE
  if (t.state === 'dwelling') return COLORS.TRAIN_DWELL
  if (t.state === 'stopped') return COLORS.TRAIN_STOPPED
  return COLORS.TRAIN_FILL
}

function Swatch({ t }: { t: TrainPosition }) {
  // Out of service is drawn hollow on the map.
  const hollow = t.in_service === false
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-3 shrink-0 rounded-[1px]"
      style={hollow ? { boxShadow: `inset 0 0 0 1.25px ${COLORS.TRAIN_OUT_OF_SERVICE}` } : { background: trainColor(t) }}
    />
  )
}

const COMMANDS: { action: DispatchAction; label: string; hint: string; count?: number }[] = [
  { action: 'hold', label: 'Hold', hint: 'Hold at the next platform to close the gap behind' },
  { action: 'express', label: 'Express', hint: 'Run non-stop until released' },
  { action: 'skip', label: 'Skip next', hint: 'Pass the next stop, then resume', count: 1 },
  { action: 'release', label: 'Release', hint: 'Clear all overrides' },
]

function isActive(t: TrainPosition, action: DispatchAction): boolean {
  if (action === 'hold') return Boolean(t.dispatch_hold)
  if (action === 'express') return Boolean(t.dispatch_express)
  if (action === 'skip') return (t.dispatch_skip_remaining ?? 0) > 0
  return false
}

function SelectedTrain({ id }: { id: string }) {
  const runtime = useRuntimeStore((s) => s.runtime)
  const setSelected = useRuntimeStore((s) => s.setSelectedTrain)
  const send = useRuntimeStore((s) => s.sendTrainCommand)
  useUiStore((s) => s.highContrast)
  const t = drawnTrain(id, runtime)

  if (!t) {
    return (
      <div className="flex flex-col gap-3 px-3 py-4 text-xs text-muted-foreground">
        <p>{id} is no longer in service.</p>
        <Button variant="outline" size="sm" className="self-start" onClick={() => setSelected(null)}>All trains</Button>
      </div>
    )
  }

  const status = trainStatus(t)
  const override = trainOverride(t)
  const command = (action: DispatchAction, count?: number) => { void send(t.train_id, action, count) }

  return (
    <div className="flex flex-col">
      <div className="border-b px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-xs" className="-ml-1.5" aria-label="All trains" title="All trains (Esc)" onClick={() => setSelected(null)}>
            <ChevronLeft />
          </Button>
          <Swatch t={t} />
          <h2 className="text-sm font-medium">{t.label || t.train_id}</h2>
          {t.destination && <span className="truncate text-xs text-muted-foreground">to {t.destination}</span>}
        </div>
        <p className={cn('mt-1 text-xs', TONE_TEXT[status.tone])}>{status.text}</p>
      </div>

      <Section title="Telemetry">
        <Fields>
          {trainReadouts(t).map((r) => (
            <Field key={r.k} k={r.k} mono={r.mono} className={r.tone && r.tone !== 'normal' ? TONE_TEXT[r.tone] : undefined}>
              {r.v}
            </Field>
          ))}
        </Fields>
      </Section>

      <Section
        title="Dispatch"
        aside={override ? <Badge variant="caution">{override}</Badge> : <span className="text-[11px] text-faint">No override</span>}
      >
        <div className="grid grid-cols-2 gap-1.5 pt-0.5">
          {COMMANDS.map((c) => {
            const active = isActive(t, c.action)
            return (
              <Button
                key={c.action}
                variant="outline"
                size="sm"
                title={c.hint}
                aria-pressed={c.action === 'release' ? undefined : active}
                disabled={c.action === 'release' && !override}
                className={cn('justify-start', active && 'border-highlight text-foreground')}
                onClick={() => command(c.action, c.count)}
              >
                {c.label}
              </Button>
            )
          })}
        </div>
      </Section>
    </div>
  )
}

function trainNo(t: TrainPosition): number {
  const m = (t.label || t.train_id).match(/\d+/)
  return m ? Number(m[0]) : 0
}

function Roster() {
  const trains = useRuntimeStore((s) => s.runtime?.trains)
  const setSelected = useRuntimeStore((s) => s.setSelectedTrain)
  useUiStore((s) => s.highContrast)
  const sorted = useMemo(() => [...(trains ?? [])].sort((a, b) => trainNo(a) - trainNo(b)), [trains])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b px-3 py-2.5 text-xs text-muted-foreground">
        No train selected. Click one on the map or pick it here.
      </p>
      <div className="grid grid-cols-[1fr_1.6fr_44px] gap-2 border-b px-3 py-1">
        <span className="micro">Run</span>
        <span className="micro">Next stop</span>
        <span className="micro text-right">km/h</span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul aria-label="Trains">
          {sorted.map((t) => (
            <li key={t.train_id}>
              <button
                type="button"
                onClick={() => setSelected(t.train_id)}
                className="grid h-7 w-full grid-cols-[1fr_1.6fr_44px] items-center gap-2 border-b border-border/60 px-3 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Swatch t={t} />
                  <span className="truncate">{t.label || t.train_id}</span>
                </span>
                <span className="truncate text-muted-foreground">
                  {t.state === 'dwelling' && t.station_name ? `At ${t.station_name}` : t.next_station_name ?? '—'}
                </span>
                <span className="num text-right text-[11px] text-muted-foreground">{shownKmh(t)}</span>
              </button>
            </li>
          ))}
          {sorted.length === 0 && <li className="px-3 py-3 text-xs text-muted-foreground">Waiting for trains.</li>}
        </ul>
      </ScrollArea>
    </div>
  )
}

export function TrainPanel() {
  const selected = useRuntimeStore((s) => s.selectedTrainId)
  return selected ? (
    <ScrollArea className="h-full">
      <SelectedTrain id={selected} />
    </ScrollArea>
  ) : (
    <Roster />
  )
}
