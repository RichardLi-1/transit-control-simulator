/**
 * Read-outs for a train / signal / switch, shared by the map hover card and the inspector.
 * Trains are described as DRAWN (motion engine render time), so numbers match the map.
 */
import type { HoveredEntity, RuntimeState, SignalAspect, Topology, TrainPosition } from '../types/domain'
import { motion } from '../motion/engine'
import { slackTier } from '../utils/safeZone'
import { fmtDist } from './format'

export type Tone = 'normal' | 'ok' | 'caution' | 'danger'

export interface Readout {
  k: string
  v: string
  tone?: Tone
  /** Value is a number / id: render in mono. */
  mono?: boolean
}

export interface EntityInfo {
  title: string
  subtitle?: string
  status?: { text: string; tone: Tone }
  rows: Readout[]
  aspect?: SignalAspect
}

/** Tailwind text colour for a tone. */
export const TONE_TEXT: Record<Tone, string> = {
  normal: 'text-foreground',
  ok: 'text-ok',
  caution: 'text-caution',
  danger: 'text-danger',
}

/** Plain-English one-liner for what a train is doing. */
export function trainStatus(t: TrainPosition): { text: string; tone: Tone } {
  const at = t.station_name || null
  const next = t.next_station_name || null
  const dwellLeft = t.dwell_remaining_sec != null && t.dwell_remaining_sec > 0.5 ? Math.ceil(t.dwell_remaining_sec) : null
  switch (t.stop_reason) {
    case 'emergency_brake':
      return { text: 'Emergency brake applied', tone: 'danger' }
    case 'dispatcher_hold':
      return { text: at ? `Held at ${at} by dispatcher` : 'Held by dispatcher', tone: 'caution' }
    case 'turnback':
      return { text: at ? `Changing ends at ${at}` : 'Changing ends at the terminal', tone: 'normal' }
    default:
      break
  }
  if (t.state === 'dwelling') {
    if (t.stop_reason === 'train_ahead') return { text: `At ${at ?? 'platform'}, waiting for the train ahead`, tone: 'caution' }
    if (t.dispatch_hold) return { text: at ? `Held at ${at} by dispatcher` : 'Held by dispatcher', tone: 'caution' }
    return { text: `At ${at ?? 'platform'}${dwellLeft != null ? `, departs in ${dwellLeft} s` : ''}`, tone: 'normal' }
  }
  if (t.state === 'stopped') {
    if (t.stop_reason === 'train_ahead') return { text: 'Stopped, waiting for the train ahead', tone: 'caution' }
    if (t.stop_reason === 'signal') return { text: 'Stopped at a red signal', tone: 'caution' }
    return { text: 'Stopped between stations', tone: 'caution' }
  }
  if (t.state === 'arriving') return { text: `Arriving at ${at ?? next ?? 'the next stop'}`, tone: 'normal' }
  return { text: next ? `Running to ${next}` : 'Running', tone: 'ok' }
}

/** Active dispatcher override, or null. */
export function trainOverride(t: TrainPosition): string | null {
  if (t.dispatch_hold) return 'Hold at platform'
  if (t.dispatch_express) return 'Express'
  if ((t.dispatch_skip_remaining ?? 0) > 0) return `Skip next ${t.dispatch_skip_remaining}`
  return null
}

/** Train as drawn (falls back to the newest snapshot). */
export function drawnTrain(id: string, runtime: RuntimeState | null): TrainPosition | undefined {
  return motion.getTrain(id)?.train ?? runtime?.trains.find((x) => x.train_id === id)
}

export function shownKmh(t: TrainPosition): number {
  return motion.getTrain(t.train_id)?.displayKmh ?? Math.round(Math.max(0, t.speed) * 3.6)
}

/** Full read-out list for a train; `brief` drops the rows the hover card has no room for. */
export function trainReadouts(t: TrainPosition, opts: { brief?: boolean } = {}): Readout[] {
  const rows: Readout[] = [{ k: 'Speed', v: `${shownKmh(t)} km/h`, mono: true }]
  const status = trainStatus(t)
  if (t.next_station_name && (!opts.brief || !status.text.includes(t.next_station_name))) {
    rows.push({ k: 'Next stop', v: t.next_station_name })
  }
  if (t.gap_to_leader_m != null) rows.push({ k: 'Train ahead', v: fmtDist(t.gap_to_leader_m), mono: true })
  const tier = slackTier(t.atp_slack_m)
  const tierTone: Tone = tier === 'danger' ? 'danger' : tier === 'caution' ? 'caution' : 'normal'
  const ma = motion.authorityAheadM(t.train_id)
  if (ma != null) rows.push({ k: 'Authority', v: `${fmtDist(ma)} ahead`, mono: true, tone: tierTone })
  if (t.atp_slack_m != null) {
    const sign = t.atp_slack_m < 0 ? '−' : '+'
    rows.push({ k: 'Brake margin', v: `${sign}${Math.abs(t.atp_slack_m).toFixed(0)} m`, mono: true, tone: tier === 'nominal' ? 'normal' : tierTone })
  }
  if (t.passengers != null && t.passenger_capacity != null && t.passenger_capacity > 0) {
    const pct = Math.round((t.load_pct ?? t.passengers / t.passenger_capacity) * 100)
    rows.push({ k: 'Load', v: `${pct}% · ${t.passengers}`, mono: true })
  }
  if (!opts.brief) {
    if (t.chainage_m != null) rows.push({ k: 'Chainage', v: `${(t.chainage_m / 1000).toFixed(2)} km`, mono: true })
    if (t.fleet) rows.push({ k: 'Fleet', v: t.fleet })
  }
  const override = trainOverride(t)
  if (override && opts.brief) rows.push({ k: 'Override', v: override, tone: 'caution' })
  return rows
}

const KIND_LABEL: Record<string, string> = {
  home: 'Home signal',
  starter: 'Starter signal',
  yard_exit: 'Yard exit signal',
  intermediate: 'Signal',
}

/**
 * Human name for a switch: mid-line crossovers are named for the stations either side (from the
 * normal edge `ob_<i>_<j>`), terminal turn-backs for their terminal.
 */
export function switchName(id: string, topology: Topology): { title: string; place?: string } {
  const sw = topology.switches.find((s) => s.id === id)
  const station = (i: number) => topology.stations?.find((st) => st.stop_index === i)?.name
  if (!sw) return { title: id }
  const edge = sw.normal_edge_id.match(/^(?:ob|ib)_(\d+)_(\d+)$/)
  const node = sw.node_id.match(/_(\d+)$/)
  const isTurnback = /xover_(start|end)/.test(sw.reverse_edge_id) || id === 'sw_start' || id === 'sw_end'
  if (isTurnback && node) {
    const at = station(Number(node[1]))
    if (at) return { title: 'Turn-back', place: at }
  }
  if (edge) {
    const a = station(Number(edge[1]))
    const b = station(Number(edge[2]))
    if (a && b) return { title: 'Crossover', place: `${a} – ${b}` }
  }
  return { title: 'Switch', place: id }
}

/** Hover-card content for whatever is under the pointer. */
export function entityInfo(hovered: HoveredEntity, topology: Topology, runtime: RuntimeState): EntityInfo {
  const { kind, id } = hovered
  if (kind === 'train') {
    const t = drawnTrain(id, runtime)
    if (!t) return { title: id, rows: [] }
    return {
      title: t.label || id,
      subtitle: t.destination ? `to ${t.destination}` : t.fleet,
      status: trainStatus(t),
      rows: trainReadouts(t, { brief: true }),
    }
  }
  if (kind === 'signal') {
    const sig = topology.signals.find((s) => s.id === id)
    const aspect = runtime.signals.find((s) => s.signal_id === id)?.aspect ?? 'dark'
    const rows: Readout[] = [{ k: 'Aspect', v: aspect.replace('_', ' ') }]
    if (sig?.interlocking) rows.push({ k: 'Interlocking', v: sig.interlocking })
    return { title: sig?.name ?? id, subtitle: KIND_LABEL[sig?.kind ?? ''] ?? 'Signal', rows, aspect }
  }
  if (kind === 'switch') {
    const s = runtime.switches.find((x) => x.switch_id === id)
    const name = switchName(id, topology)
    return { title: name.title, subtitle: name.place, rows: [{ k: 'Points', v: s?.state ?? '—' }, { k: 'Id', v: id, mono: true }] }
  }
  return { title: id, rows: [] }
}
