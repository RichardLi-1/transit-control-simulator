import { create } from 'zustand'
import { useRuntimeStore } from './runtimeStore'
import type { RuntimeState, TrainState } from '../types/domain'

export type EventSeverity = 'info' | 'warn' | 'error'
export type EventSource = 'system' | 'wayside' | 'driver' | 'manual'

export interface SimEvent {
  id: number
  t: number            // wall time ms
  simT: number | null  // sim timestamp if available
  source: EventSource
  severity: EventSeverity
  kind: string         // short tag e.g. 'SIG' / 'SW' / 'TRAIN' / 'EB' / 'CMD'
  message: string
}

const MAX_EVENTS = 200

interface EventsStore {
  events: SimEvent[]
  paused: boolean
  injectOpen: boolean
  /** Routine signal flips stay out of the list unless this is on. */
  showSignals: boolean
  append: (e: Omit<SimEvent, 'id' | 't' | 'simT'> & { simT?: number | null }) => void
  clear: () => void
  togglePaused: () => void
  toggleShowSignals: () => void
  setInjectOpen: (v: boolean) => void
}

let _nextId = 1

export const useEventsStore = create<EventsStore>((set, get) => ({
  events: [],
  paused: false,
  injectOpen: false,
  showSignals: false,
  append: (e) => {
    if (get().paused) return
    const rt = useRuntimeStore.getState().runtime
    const { simT: simTOverride, ...rest } = e
    const simT = simTOverride ?? rt?.sim_time_s ?? rt?.timestamp ?? null
    const ev: SimEvent = {
      id: _nextId++,
      t: Date.now(),
      simT,
      ...rest,
    }
    set((s) => ({ events: [ev, ...s.events].slice(0, MAX_EVENTS) }))
  },
  clear: () => set({ events: [] }),
  togglePaused: () => set((s) => ({ paused: !s.paused })),
  toggleShowSignals: () => set((s) => ({ showSignals: !s.showSignals })),
  setInjectOpen: (v) => set({ injectOpen: v }),
}))

function trainMoveLine(name: string, from: TrainState, to: TrainState, station?: string | null): string {
  const at = station?.trim()
  if (to === 'dwelling' || (from === 'arriving' && to === 'running' && at)) {
    return at ? `${name} arrived and stopped at ${at}` : `${name} arrived and stopped`
  }
  if (from === 'dwelling' && to === 'running') {
    return at ? `${name} left ${at}` : `${name} left the station`
  }
  if (from === 'running' && to === 'arriving') {
    return at ? `${name} approaching ${at}` : `${name} approaching the next station`
  }
  if (from === 'dwelling' && to === 'arriving') {
    return at ? `${name} left ${at}` : `${name} left the station`
  }
  if (from === 'arriving' && to === 'running') {
    return `${name} back underway`
  }
  return `${name} underway`
}

// ── Auto-derive events from runtime state changes ──────────────────────────

let _prev: RuntimeState | null = null
let _prevStale = false
let _prevCommandError: string | null = null
let _prevDispatchCount = 0
let _prevDispatchPlan = ''
const _seenLogKeys = new Set<string>()
const _seenPlannedIds = new Set<string>()

useRuntimeStore.subscribe((state) => {
  const append = useEventsStore.getState().append

  // Command error edge-trigger
  if (state.commandError && state.commandError !== _prevCommandError) {
    append({ source: 'system', severity: 'error', kind: 'CMD', message: state.commandError })
  }
  _prevCommandError = state.commandError

  // Stale edge-trigger
  if (state.stale !== _prevStale) {
    append({
      source: 'system',
      severity: state.stale ? 'warn' : 'info',
      kind: 'LINK',
      message: state.stale ? 'state feed went stale' : 'state feed recovered',
    })
    _prevStale = state.stale
  }

  const cur = state.runtime
  if (!cur) return

  if (!_prev) {
    append({
      source: 'system', severity: 'info', kind: 'INIT',
      message: `runtime online — ${cur.trains.length} trains, ${cur.switches.length} switches, ${cur.signals.length} signals`,
    })
    _prev = cur
    _prevDispatchCount = cur.ops?.dispatch?.count ?? 0
    return
  }

  for (const row of cur.ops?.event_log ?? []) {
    const key = `${row.sim_t}:${row.kind}:${row.message}`
    if (_seenLogKeys.has(key)) continue
    _seenLogKeys.add(key)
    const src = (row.source === 'manual' || row.source === 'driver' || row.source === 'wayside'
      ? row.source
      : 'system') as EventSource
    append({
      source: src,
      severity: row.severity,
      kind: row.kind,
      message: row.message,
      simT: row.sim_t,
    })
  }

  for (const inc of cur.ops?.injected_events ?? []) {
    if (inc.active || inc.starts_in_s <= 0) continue
    if (_seenPlannedIds.has(inc.id)) continue
    _seenPlannedIds.add(inc.id)
    const target = inc.target_train_id ?? inc.target_signal_id ?? ''
    append({
      source: 'manual',
      severity: 'info',
      kind: 'PLAN',
      message: `${inc.kind}${target ? ` → ${target}` : ''} in ~${Math.ceil(inc.starts_in_s)}s`,
    })
  }

  // Dispatch telemetry (actual + future/next)
  const dispatch = cur.ops?.dispatch
  if (dispatch) {
    const count = dispatch.count ?? 0
    if (count > _prevDispatchCount) {
      append({
        source: 'wayside',
        severity: 'info',
        kind: 'DISP',
        message: `train dispatched (count=${count})`,
      })
      _prevDispatchCount = count
    }

    const eta = dispatch.next_due_in_s
    if (eta != null) {
      let bucket = ''
      if (dispatch.blocked) bucket = 'blocked'
      else if (eta <= 5) bucket = 'eta<=5'
      else if (eta <= 15) bucket = 'eta<=15'
      else if (eta <= 30) bucket = 'eta<=30'
      else if (eta <= 60) bucket = 'eta<=60'
      const planKey = `${bucket}:${dispatch.blocked ? 1 : 0}`
      if (bucket && planKey !== _prevDispatchPlan) {
        append({
          source: 'system',
          severity: dispatch.blocked ? 'warn' : 'info',
          kind: 'PLAN',
          message: dispatch.blocked
            ? 'next dispatch blocked (yard occupied or max trains)'
            : `next dispatch due in ~${Math.ceil(eta)}s`,
        })
        _prevDispatchPlan = planKey
      }
    }
  }

  // Train roster diff
  const prevIds = new Set(_prev.trains.map((t) => t.train_id))
  const curIds = new Set(cur.trains.map((t) => t.train_id))
  for (const id of curIds) if (!prevIds.has(id)) {
    const name = cur.trains.find((t) => t.train_id === id)?.label ?? id
    append({ source: 'wayside', severity: 'info', kind: 'TRAIN', message: `${name} entered service` })
  }
  for (const id of prevIds) if (!curIds.has(id)) {
    const name = _prev.trains.find((t) => t.train_id === id)?.label ?? id
    append({ source: 'wayside', severity: 'warn', kind: 'TRAIN', message: `${name} left service` })
  }

  // Train state changes (running ↔ dwelling ↔ arriving)
  const prevTrains = new Map(_prev.trains.map((t) => [t.train_id, t]))
  for (const t of cur.trains) {
    const p = prevTrains.get(t.train_id)
    if (p && p.state !== t.state) {
      append({
        source: 'wayside', severity: 'info', kind: 'TRAIN',
        message: trainMoveLine(t.label, p.state, t.state, t.station_name || p.station_name),
      })
    }
    // Skip a second DWELL line — the TRAIN state change already says it.
    // ATP slack edge-triggers: only fire on the crossing, not every tick.
    if (p && p.atp_slack_m != null && t.atp_slack_m != null) {
      if (p.atp_slack_m >= 0 && t.atp_slack_m < 0) {
        append({
          source: 'wayside', severity: 'error', kind: 'ATP',
          message: `${t.label} authority breached — slack ${t.atp_slack_m.toFixed(1)} m`,
        })
      } else if (p.atp_slack_m < 0 && t.atp_slack_m >= 0) {
        append({
          source: 'wayside', severity: 'info', kind: 'ATP',
          message: `${t.label} authority recovered`,
        })
      } else if (p.atp_slack_m >= 15 && t.atp_slack_m < 15) {
        append({
          source: 'wayside', severity: 'warn', kind: 'ATP',
          message: `${t.label} slack tightening — ${t.atp_slack_m.toFixed(1)} m`,
        })
      }
    }
  }

  // Switch state changes
  const prevSw = new Map(_prev.switches.map((s) => [s.switch_id, s.state]))
  for (const s of cur.switches) {
    const pv = prevSw.get(s.switch_id)
    if (pv && pv !== s.state) {
      append({
        source: 'wayside', severity: 'info', kind: 'SW',
        message: `${s.switch_id} ${pv} → ${s.state}`,
      })
    }
  }

  // Signal aspect changes — one summary per tick, not 20 rows of green↔yellow.
  const prevSig = new Map(_prev.signals.map((s) => [s.signal_id, s.aspect]))
  let sigN = 0
  let toRed = 0
  for (const s of cur.signals) {
    const pv = prevSig.get(s.signal_id)
    if (pv && pv !== s.aspect) {
      sigN += 1
      if (s.aspect === 'red') toRed += 1
    }
  }
  if (sigN > 0) {
    append({
      source: 'wayside',
      severity: toRed > 0 ? 'warn' : 'info',
      kind: 'SIG',
      message: sigN === 1
        ? `${cur.signals.find((s) => prevSig.get(s.signal_id) !== s.aspect)?.signal_id ?? 'signal'} changed`
        : `${sigN} signals changed${toRed ? ` · ${toRed} to red` : ''}`,
    })
  }

  _prev = cur
})
