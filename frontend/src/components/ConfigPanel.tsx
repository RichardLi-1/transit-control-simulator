/**
 * Hidden sim config (Ctrl+Shift+C): dev mode, RL training, operations targets, rolling stock,
 * scheduled event injection. A non-modal sheet so the map keeps running behind it.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useRuntimeStore } from '../store/runtimeStore'
import { useUiStore } from '../store/uiStore'
import { useTrainingStore } from '../store/trainingStore'
import { cancelEvent, injectEvent } from '../api/client'
import { isMlEnabled } from '../config/ml'
import type { EventKind, RollingStockProfile } from '../types/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

const EVENT_KINDS: EventKind[] = ['emergency_brake', 'door_fault', 'slow_speed', 'signal_fail', 'station_hold']
const TRAINING_CONFIGS = ['ppo_smoke.yaml', 'ppo_baseline.yaml', 'rule_based_smoke.yaml']

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1 border-b px-4 py-3">
      <h3 className="micro mb-1">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3 text-xs">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {hint && <span className="num shrink-0 text-[11px] text-faint">{hint}</span>}
    </div>
  )
}

function NumInput({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="num h-7 w-20 px-2"
    />
  )
}

function Pick<T extends string>({ value, options, onChange, disabled, placeholder, className }: {
  value: T | ''
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  return (
    <Select value={value || undefined} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger size="sm" className={className ?? 'w-full text-xs'}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-64">
        {options.map((o) => <SelectItem key={o.value} value={o.value} className="num text-xs">{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

export function ConfigPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { config, runtime, updateConfig } = useRuntimeStore()
  const { devMode, setDevMode } = useUiStore()
  const {
    persistCheckpoints,
    resumeTraining,
    configName,
    status: trainingStatus,
    error: trainingError,
    setPersistCheckpoints,
    setResumeTraining,
    setConfigName,
    start: startTraining,
    stop: stopTraining,
    startPolling: startTrainingPoll,
    stopPolling: stopTrainingPoll,
    refreshStatus,
  } = useTrainingStore()
  const [newEventKind, setNewEventKind] = useState<EventKind>('emergency_brake')
  const [newEventTrain, setNewEventTrain] = useState('T01')
  const [newEventSignal, setNewEventSignal] = useState('')
  const [newEventDur, setNewEventDur] = useState(30)
  const [newEventDelay, setNewEventDelay] = useState(0)
  const [newEventTsr, setNewEventTsr] = useState(25)
  const [injectError, setInjectError] = useState<string | null>(null)

  const activeIncidents = runtime?.ops?.injected_events ?? []

  useEffect(() => {
    if (!open) {
      stopTrainingPoll()
      return
    }
    void refreshStatus()
    startTrainingPoll()
    return () => stopTrainingPoll()
  }, [open, refreshStatus, startTrainingPoll, stopTrainingPoll])

  const trainingRunning = Boolean(trainingStatus?.running)
  const done = trainingStatus?.completed_timesteps ?? 0
  const total = trainingStatus?.total_timesteps ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  const activeProfile: RollingStockProfile | undefined = config.profiles.find((p) => p.id === config.active_profile)

  function patchProfile(patch: Partial<RollingStockProfile>) {
    if (!activeProfile) return
    updateConfig({ profiles: config.profiles.map((p) => (p.id === activeProfile.id ? { ...p, ...patch } : p)) })
  }

  async function addEvent() {
    setInjectError(null)
    try {
      await injectEvent({
        kind: newEventKind,
        target_train_id: newEventKind === 'signal_fail' ? undefined : newEventTrain,
        target_signal_id: newEventKind === 'signal_fail' ? newEventSignal : undefined,
        speed_limit_kph: newEventKind === 'slow_speed' ? newEventTsr : undefined,
        duration_s: newEventDur,
        starts_in_s: newEventDelay,
      })
    } catch (err) {
      setInjectError(String(err))
    }
  }

  async function removeEvent(id: string) {
    setInjectError(null)
    try {
      await cancelEvent(id)
    } catch (err) {
      setInjectError(String(err))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        showCloseButton={false}
        className="w-[380px] gap-0 p-0 sm:max-w-[380px] md:data-[side=right]:top-10 md:data-[side=right]:bottom-7 md:data-[side=right]:h-auto"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-4">
          <SheetTitle className="text-xs font-medium">Sim config</SheetTitle>
          <SheetDescription className="flex items-center gap-1 text-[11px]">
            <KbdGroup><Kbd>Ctrl</Kbd><Kbd>Shift</Kbd><Kbd>C</Kbd></KbdGroup>
          </SheetDescription>
          <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close" onClick={() => onOpenChange(false)}><X /></Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <Group title="Developer">
            <Row label="Dev mode" hint={<KbdGroup><Kbd>Ctrl</Kbd><Kbd>Shift</Kbd><Kbd>D</Kbd></KbdGroup>}>
              <Switch checked={devMode} onCheckedChange={setDevMode} aria-label="Dev mode" />
            </Row>
          </Group>

          {isMlEnabled() && (
            <Group title="RL training">
              <Row label="Experiment">
                <Pick
                  value={configName}
                  onChange={setConfigName}
                  disabled={trainingRunning}
                  options={TRAINING_CONFIGS.map((c) => ({ value: c, label: c }))}
                />
              </Row>
              <Row label="Save checkpoints">
                <Checkbox checked={persistCheckpoints} onCheckedChange={(v) => setPersistCheckpoints(v === true)} disabled={trainingRunning} aria-label="Save checkpoints" />
                <span className="text-[11px] text-faint">persist across runs</span>
              </Row>
              <Row label="Resume">
                <Checkbox checked={resumeTraining} onCheckedChange={(v) => setResumeTraining(v === true)} disabled={trainingRunning} aria-label="Resume" />
                <span className="text-[11px] text-faint">from last checkpoint</span>
              </Row>
              <div className="flex items-center gap-1.5 pt-1">
                <Button size="xs" onClick={() => void startTraining()} disabled={trainingRunning}>Start</Button>
                <Button size="xs" variant="outline" onClick={() => void stopTraining()} disabled={!trainingRunning}>Stop</Button>
                <span className="num ml-1 truncate text-[11px] text-muted-foreground">
                  {trainingRunning ? 'running' : (trainingStatus?.status ?? 'idle')}
                  {total > 0 ? ` · ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)` : ''}
                </span>
              </div>
              {trainingStatus?.last_checkpoint && <p className="num truncate text-[11px] text-faint">{trainingStatus.last_checkpoint}</p>}
              {trainingError && <p className="num text-[11px] text-danger">{trainingError}</p>}
              <p className="text-[11px] leading-relaxed text-faint">
                Needs the ML API on :8001 (<span className="num">npm run dev</span>). Checkpoints go to runs/&lt;name&gt;/latest/;
                copy policy.zip to ml/models/deployed/ to ship it.
              </p>
            </Group>
          )}

          <Group title="Operations">
            <Row label="Rolling stock" hint={`${config.rolling_stock_pct}%`}>
              <Slider
                min={10}
                max={100}
                step={5}
                value={[config.rolling_stock_pct]}
                onValueChange={([v]) => updateConfig({ rolling_stock_pct: v })}
                aria-label="Rolling stock percentage"
              />
            </Row>
            <Row label="Headway target" hint="s">
              <NumInput value={config.headway_target} min={30} max={600} step={10} onChange={(v) => updateConfig({ headway_target: v })} />
            </Row>
          </Group>

          {activeProfile && (
            <Group title={`Rolling stock · ${activeProfile.name}`}>
              <Row label="Max speed" hint={`m/s · ${(activeProfile.max_speed * 3.6).toFixed(0)} km/h`}>
                <NumInput value={activeProfile.max_speed} min={5} max={35} step={0.5} onChange={(v) => patchProfile({ max_speed: v })} />
              </Row>
              <Row label="Acceleration" hint="m/s²">
                <NumInput value={activeProfile.accel} min={0.3} max={3} step={0.1} onChange={(v) => patchProfile({ accel: v })} />
              </Row>
              <Row label="Deceleration" hint="m/s²">
                <NumInput value={activeProfile.decel} min={0.5} max={4} step={0.1} onChange={(v) => patchProfile({ decel: v })} />
              </Row>
              <Row label="Length" hint="m">
                <NumInput value={activeProfile.length} min={20} max={200} step={1} onChange={(v) => patchProfile({ length: v })} />
              </Row>
              <Row label="Mass" hint="t">
                <NumInput value={activeProfile.mass} min={50} max={500} step={10} onChange={(v) => patchProfile({ mass: v })} />
              </Row>
            </Group>
          )}

          <Group title="Scheduled events">
            <Row label="Kind">
              <Pick value={newEventKind} onChange={setNewEventKind} options={EVENT_KINDS.map((k) => ({ value: k, label: k }))} />
            </Row>
            {newEventKind === 'signal_fail' ? (
              <Row label="Signal">
                <Pick
                  value={newEventSignal}
                  onChange={setNewEventSignal}
                  placeholder="Select…"
                  options={(runtime?.signals ?? []).map((s) => ({ value: s.signal_id, label: s.signal_id }))}
                />
              </Row>
            ) : (
              <Row label="Train">
                <Pick
                  value={newEventTrain}
                  onChange={setNewEventTrain}
                  options={(runtime?.trains ?? []).map((t) => ({ value: t.train_id, label: t.label || t.train_id }))}
                />
              </Row>
            )}
            <Row label="Duration" hint="s"><NumInput value={newEventDur} min={5} max={300} step={5} onChange={setNewEventDur} /></Row>
            <Row label="Starts in" hint="s"><NumInput value={newEventDelay} min={0} max={120} step={5} onChange={setNewEventDelay} /></Row>
            {newEventKind === 'slow_speed' && (
              <Row label="Speed limit" hint="km/h"><NumInput value={newEventTsr} min={5} max={80} step={5} onChange={setNewEventTsr} /></Row>
            )}
            <div className="flex justify-end pt-1">
              <Button size="xs" onClick={() => void addEvent()}>Schedule</Button>
            </div>
            {injectError && <p className="num text-[11px] text-danger">{injectError}</p>}
          </Group>

          <Group title="Active events">
            {activeIncidents.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
            <ul className="flex flex-col">
              {activeIncidents.map((evt) => (
                <li key={evt.id} className="flex h-7 items-center gap-2 text-xs">
                  <Badge variant={evt.active ? 'caution' : 'neutral'}>{evt.active ? 'Active' : 'Queued'}</Badge>
                  <span className="num min-w-0 flex-1 truncate">
                    {evt.target_train_id ?? evt.target_signal_id ?? '—'} {evt.kind}
                  </span>
                  <span className="num text-[11px] text-faint">
                    {evt.active ? `${evt.remaining_s.toFixed(0)} s left` : `in ${evt.starts_in_s.toFixed(0)} s`}
                  </span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Cancel ${evt.kind}`} onClick={() => void removeEvent(evt.id)}><X /></Button>
                </li>
              ))}
            </ul>
          </Group>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
