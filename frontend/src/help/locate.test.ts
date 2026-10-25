import { describe, expect, it } from 'vitest'
import type { TrainPosition } from '../types/domain'
import { answerWhereIs, describeTrain, parseRunNumber } from './locate'

const base: TrainPosition = {
  train_id: 'T04', label: 'Run 4', edge_id: 'ob_3_4', offset: 0.4, speed: 0, state: 'running',
  safe_zone_front: 0, safe_zone_rear: 138, destination: 'Finch', next_station_name: 'Finch West',
}

describe('GUIDE locate (contract v2 fields)', () => {
  it('explains a train stopped behind its leader', () => {
    const r = describeTrain({ ...base, state: 'stopped', stop_reason: 'train_ahead' })
    expect(r).toContain('stopped before Finch West')
    expect(r).toContain('waiting for the train ahead')
    expect(r).toContain('heading to Finch')
  })

  it('names the next stop and destination while running, speed as displayed', () => {
    const r = describeTrain({ ...base, speed: 12.5 })
    expect(r).toBe('Run 4 is running towards Finch West at 45 km/h, heading to Finch.')
  })

  it('a dwelling train reports its platform and departure', () => {
    const r = answerWhereIs('where is run 4', [{ ...base, state: 'dwelling', station_name: 'York University', dwell_remaining_sec: 12.2 }])
    expect(r?.reply).toContain('stopped at York University')
    expect(r?.reply).toContain('departs in about 13 s')
    expect(r?.reply).toContain('Next stop: Finch West')
  })

  it('a dispatcher hold is described', () => {
    const r = describeTrain({ ...base, state: 'dwelling', station_name: 'Union', stop_reason: 'dispatcher_hold', dispatch_hold: true })
    expect(r).toContain('held by the dispatcher')
  })

  it('handles run numbers past 99 (backend run numbers keep growing)', () => {
    const t104: TrainPosition = { ...base, train_id: 'T104', label: 'Run 104' }
    expect(parseRunNumber('where is run 104')).toBe(104)
    expect(parseRunNumber('T104?')).toBe(104)
    expect(answerWhereIs('where is run 104', [base, t104])?.reply).toContain('Run 104')
    expect(answerWhereIs('run 104', [t104])?.reply).toContain('Run 104')
    expect(parseRunNumber('what happened at 1500')).toBeNull()
  })
})

