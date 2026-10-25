import type { TrainPosition } from '../types/domain'
import type { HelpTargetId } from './guide'
import { motion } from '../motion/engine'

export interface HelpReply {
  reply: string
  point: HelpTargetId | null
}

/** Pull a run number from "where is run 4", "T04", "run 16", "run 104", etc. */
export function parseRunNumber(question: string): number | null {
  const tagged = question.match(/\b(?:run|t)\s*0*(\d{1,4})\b/i)
  if (!tagged) return null
  const n = Number(tagged[1])
  return Number.isFinite(n) ? n : null
}

function findTrain(trains: TrainPosition[], n: number): TrainPosition | undefined {
  const id = `T${String(n).padStart(2, '0')}`
  return trains.find(
    (t) =>
      t.train_id === id
      || t.train_id === `T${n}`
      || new RegExp(`\\brun\\s*0*${n}\\b`, 'i').test(t.label),
  )
}

/** km/h as shown on the map (interpolated + hysteresis); falls back to the raw snapshot. */
function shownKmh(t: TrainPosition): number | null {
  const m = motion.getTrain(t.train_id)
  if (m) return m.displayKmh
  return Number.isFinite(t.speed) ? Math.round(Math.max(0, t.speed) * 3.6) : null
}

const STOP_REASON_TEXT: Record<string, string> = {
  train_ahead: 'waiting for the train ahead to move',
  signal: 'held at a red signal',
  emergency_brake: 'stopped by an emergency brake application',
  dispatcher_hold: 'held by the dispatcher',
  turnback: 'changing ends to head back',
}

export function describeTrain(t: TrainPosition): string {
  const name = t.label || t.train_id
  const kmh = shownKmh(t)
  const dest = t.destination ? `, heading to ${t.destination}` : ''
  const next = t.next_station_name
  const override = t.dispatch_hold
    ? ' Dispatch has it on hold.'
    : t.dispatch_express
      ? ' It is running express (skipping stops).'
      : (t.dispatch_skip_remaining ?? 0) > 0
        ? ` It will skip the next ${t.dispatch_skip_remaining} stop(s).`
        : ''
  const reason = t.stop_reason ? STOP_REASON_TEXT[t.stop_reason] : null

  if (t.state === 'dwelling') {
    const where = t.station_name ?? next ?? 'a platform'
    const left = t.dwell_remaining_sec != null && t.dwell_remaining_sec > 0.5 ? ` It departs in about ${Math.ceil(t.dwell_remaining_sec)} s.` : ''
    const why = reason ? ` (${reason})` : ''
    const after = next && next !== t.station_name ? ` Next stop: ${next}.` : ''
    return `${name} is stopped at ${where}${why}${dest}.${reason ? '' : left}${after}${override}`
  }
  if (t.state === 'stopped') {
    const before = next ? ` before ${next}` : ' between stations'
    return `${name} is stopped${before}${reason ? ` — ${reason}` : ''}${dest}.${override}`
  }
  if (t.state === 'arriving') {
    const where = t.station_name ?? next
    return `${name} is arriving at ${where ?? 'the next stop'}${kmh != null ? ` (${kmh} km/h)` : ''}${dest}.${override}`
  }
  if (next) {
    return `${name} is running towards ${next}${kmh != null ? ` at ${kmh} km/h` : ''}${dest}.${override}`
  }
  if (t.station_name) {
    return `${name} is near ${t.station_name}${kmh != null ? `, moving at ${kmh} km/h` : ''}${dest}.${override}`
  }
  return `${name} is on the line${kmh != null ? ` at ${kmh} km/h` : ''}, not at a platform right now${dest}.${override}`
}

export function answerWhereIs(question: string, trains: TrainPosition[]): HelpReply | null {
  const n = parseRunNumber(question)
  if (n == null) return null
  const placeAsk =
    /\b(where|find|locate|how's|how is|status)\b/i.test(question)
    || /^(?:run|t)\s*0*\d{1,4}\??$/i.test(question.trim())
  if (!placeAsk) return null

  if (trains.length === 0) {
    return { reply: `I don't have live train data yet — wait for /state, then ask again.`, point: 'map' }
  }
  const t = findTrain(trains, n)
  if (!t) {
    const sample = trains.slice(0, 8).map((x) => x.label).join(', ')
    return {
      reply: `I don't see a Run ${n} out there right now. On the board: ${sample}.`,
      point: 'map',
    }
  }
  // Prefer the state as drawn on the map (interpolated render time) so the answer matches it.
  return { reply: describeTrain(motion.getTrain(t.train_id)?.train ?? t), point: 'map' }
}
