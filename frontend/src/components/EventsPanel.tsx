/**
 * Inspector → Events: the operations log (newest first) and the disruption injector.
 */
import { useMemo, useState } from 'react'
import posthog from 'posthog-js'
import { Pause, Play } from 'lucide-react'
import { useEventsStore, type EventSeverity, type SimEvent } from '../store/eventsStore'
import { useRuntimeStore } from '../store/runtimeStore'
import { useTopologyStore } from '../store/topologyStore'
import { injectEvent } from '../api/client'
import { fmtSimClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'

/** Visible events + how many are warnings/errors (the tab shows the count). */
export function useVisibleEvents() {
  const events = useEventsStore((s) => s.events)
  const showSignals = useEventsStore((s) => s.showSignals)
  return useMemo(() => {
    const visible = showSignals ? events : events.filter((e) => e.kind !== 'SIG')
    return { visible, alerts: visible.filter((e) => e.severity !== 'info').length }
  }, [events, showSignals])
}

export function EventsPanel() {
  const { events, paused, injectOpen, showSignals, togglePaused, toggleShowSignals, clear, setInjectOpen } = useEventsStore()
  const { visible } = useVisibleEvents()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <Toggle size="sm" pressed={showSignals} onPressedChange={toggleShowSignals} title="Include routine signal changes">
          Signals
        </Toggle>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-pressed={paused}
          onClick={togglePaused}
          aria-label={paused ? 'Resume log' : 'Pause log'}
          title={paused ? 'Resume log' : 'Pause log'}
        >
          {paused ? <Play /> : <Pause />}
        </Button>
        <Button variant="ghost" size="xs" onClick={clear} disabled={events.length === 0}>Clear</Button>
        <div className="flex-1" />
        <span data-help="inject" className="inline-flex">
          <Button variant="outline" size="xs" aria-expanded={injectOpen} onClick={() => setInjectOpen(!injectOpen)}>
            Inject
          </Button>
        </span>
      </div>

      {injectOpen && <InjectForm onDone={() => setInjectOpen(false)} />}

      <ScrollArea className="min-h-0 flex-1">
        <ol role="log" aria-live="polite" aria-label="Events">
          {visible.map((e) => <EventRow key={e.id} e={e} />)}
        </ol>
        {visible.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {events.length === 0
              ? 'No events yet. Commands, holds and faults appear here.'
              : 'Only routine signal changes so far. Turn on Signals to see them.'}
          </p>
        )}
      </ScrollArea>
      {paused && (
        <p className="shrink-0 border-t px-3 py-1.5 text-[11px] text-caution">Log paused. New events are not recorded.</p>
      )}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  SIG: 'SIGNAL',
  SW: 'SWITCH',
  TRAIN: 'TRAIN',
  ATP: 'SAFETY',
  EB: 'E-BRAKE',
  CMD: 'CMD',
  LINK: 'LINK',
  INIT: 'SYSTEM',
  DISP: 'DISPATCH',
  PLAN: 'PLANNED',
  TSR: 'SPEED',
  HOLD: 'HOLD',
  NOTE: 'NOTE',
}

const SEV_TEXT: Record<EventSeverity, string> = {
  info: 'text-faint',
  warn: 'text-caution',
  error: 'text-danger',
}

function EventRow({ e }: { e: SimEvent }) {
  const planned = e.kind === 'PLAN'
  return (
    <li className="grid grid-cols-[52px_58px_1fr] items-baseline gap-x-2 border-b border-border/60 px-3 py-1 text-xs">
      <span className="num text-[11px] text-faint">{fmtSimClock(e.simT)}</span>
      <span className={cn('num truncate text-[10px] tracking-wide', SEV_TEXT[e.severity])}>{KIND_LABEL[e.kind] ?? e.kind}</span>
      <span className={cn('min-w-0 leading-snug', e.severity === 'info' ? 'text-muted-foreground' : 'text-foreground', planned && 'text-faint')}>
        {e.message}
      </span>
    </li>
  )
}

// ── Inject form ────────────────────────────────────────────────────────────

type InjectKind = 'eb_apply' | 'eb_release' | 'switch_fail' | 'speed_restrict' | 'station_hold' | 'note'

const INJECT_LABEL: Record<InjectKind, string> = {
  speed_restrict: 'Temporary speed restriction',
  station_hold: 'Hold at station',
  eb_apply: 'Emergency brake, apply',
  eb_release: 'Emergency brake, release',
  switch_fail: 'Switch failure',
  note: 'Operator note',
}

const INJECT_SOURCE: Record<InjectKind, 'driver' | 'manual' | 'wayside'> = {
  eb_apply: 'driver',
  eb_release: 'driver',
  switch_fail: 'wayside',
  speed_restrict: 'wayside',
  station_hold: 'wayside',
  note: 'manual',
}

const TARGET_LABEL: Record<InjectKind, string | null> = {
  eb_apply: 'Train', eb_release: 'Train', station_hold: 'Train',
  switch_fail: 'Switch', speed_restrict: 'Train', note: null,
}

function FormRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[56px_1fr] items-center gap-2">
      <Label htmlFor={htmlFor} className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function InjectForm({ onDone }: { onDone: () => void }) {
  const { runtime, sendSwitchCommand } = useRuntimeStore()
  const topology = useTopologyStore((s) => s.topology)
  const append = useEventsStore((s) => s.append)

  const [kind, setKind] = useState<InjectKind>('speed_restrict')
  const [target, setTarget] = useState<string>('')
  const [value, setValue] = useState<string>('')
  const [note, setNote] = useState<string>('')

  const targets = useMemo(() => {
    if (kind === 'switch_fail') return (topology?.switches ?? []).map((s) => ({ id: s.id, label: s.id }))
    if (kind === 'note') return []
    return (runtime?.trains ?? []).map((t) => ({ id: t.train_id, label: t.label || t.train_id }))
  }, [kind, runtime?.trains, topology?.switches])

  const needsValue = kind === 'speed_restrict'
  const targetLabel = TARGET_LABEL[kind]
  const ready = (targetLabel == null || target !== '') && (!needsValue || value !== '')

  async function submit() {
    try {
      if (kind === 'note') {
        await injectEvent({ kind: 'operator_note', note: note.trim() || INJECT_LABEL.note })
      } else if (kind === 'eb_apply' && target) {
        await injectEvent({ kind: 'emergency_brake', target_train_id: target, duration_s: 30 })
      } else if (kind === 'eb_release' && target) {
        await injectEvent({ kind: 'emergency_brake_release', target_train_id: target, duration_s: 5 })
      } else if (kind === 'speed_restrict' && target && value) {
        await injectEvent({
          kind: 'slow_speed',
          target_train_id: target,
          speed_limit_kph: Number(value),
          duration_s: 120,
          note: note.trim(),
        })
      } else if (kind === 'station_hold' && target) {
        await injectEvent({ kind: 'station_hold', target_train_id: target, duration_s: 60, note: note.trim() })
      } else if (kind === 'switch_fail' && target) {
        const sw = topology?.switches.find((x) => x.id === target)
        const sigOnEdge = topology?.signals.find((s) => s.edge_id === sw?.normal_edge_id)
        if (sigOnEdge) {
          await injectEvent({
            kind: 'signal_fail',
            target_signal_id: sigOnEdge.id,
            duration_s: 45,
            note: note.trim() || `switch ${target} failed`,
          })
        } else {
          const cur = runtime?.switches.find((s) => s.switch_id === target)?.state
          sendSwitchCommand(target, cur === 'normal' ? 'reverse' : 'normal')
          await injectEvent({ kind: 'operator_note', note: note.trim() || `switch ${target} failed (no signal mapped)` })
        }
      } else {
        append({ source: INJECT_SOURCE[kind], severity: 'warn', kind: 'CMD', message: 'Pick a target first.' })
        return
      }
    } catch (err) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)), { inject_kind: kind, target })
      append({ source: 'system', severity: 'error', kind: 'CMD', message: 'Inject failed. The simulator did not accept it.' })
      return
    }

    posthog.capture('event_injected', { kind, target, ...(needsValue && value ? { speed_limit_kph: Number(value) } : {}) })
    setNote('')
    setValue('')
  }

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-b bg-muted/40 px-3 py-2.5"
      onSubmit={(e) => { e.preventDefault(); void submit() }}
    >
      <FormRow label="Type" htmlFor="inject-kind">
        <Select value={kind} onValueChange={(v) => { setKind(v as InjectKind); setTarget(''); setValue('') }}>
          <SelectTrigger id="inject-kind" size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {(Object.keys(INJECT_LABEL) as InjectKind[]).map((k) => (
              <SelectItem key={k} value={k} className="text-xs">{INJECT_LABEL[k]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormRow>

      {targetLabel && (
        <FormRow label={targetLabel} htmlFor="inject-target">
          <Select value={target || undefined} onValueChange={setTarget}>
            <SelectTrigger id="inject-target" size="sm" className="w-full text-xs">
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-64">
              {targets.map((t) => <SelectItem key={t.id} value={t.id} className="text-xs">{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormRow>
      )}

      {needsValue && (
        <FormRow label="Limit" htmlFor="inject-limit">
          <div className="flex items-center gap-2">
            <Input
              id="inject-limit"
              className="num h-7 w-20"
              type="number" min={0} max={120} inputMode="numeric"
              value={value} onChange={(e) => setValue(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">km/h for 2 min</span>
          </div>
        </FormRow>
      )}

      <FormRow label="Note" htmlFor="inject-note">
        <Input
          id="inject-note"
          className="h-7"
          type="text" placeholder="Optional"
          value={note} onChange={(e) => setNote(e.target.value)}
        />
      </FormRow>

      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="xs" disabled={!ready}>Inject</Button>
      </div>
    </form>
  )
}
