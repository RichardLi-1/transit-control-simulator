import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../types/domain'
import { acceptState } from './runtimeStore'

const st = (t: number): RuntimeState => ({ trains: [], blocks: [], switches: [], signals: [], timestamp: 0, sim_time_s: t })

describe('acceptState rewind protection', () => {
  it('accepts forward progress and drops a stale replica response', () => {
    expect(acceptState(st(100), st(100.5), 0)).toBe(true)
    expect(acceptState(st(100.5), st(99), 100)).toBe(false)   // stale replica
    expect(acceptState(st(100.5), st(101), 300)).toBe(true)   // newer again → resets the rewind timer
    expect(acceptState(st(101), st(99), 3_000)).toBe(false)
  })

  it('accepts an obvious restart immediately', () => {
    expect(acceptState(st(500), st(3), 0)).toBe(true)
  })

  it('accepts a restart first seen after its first 15 s once the rewind persists', () => {
    let t = 10_000
    expect(acceptState(st(500), st(40), t)).toBe(false)
    for (let k = 0; k < 10; k++) { t += 200; acceptState(st(500), st(40 + k * 0.2), t) }
    t += 1_500
    expect(acceptState(st(500), st(45), t)).toBe(true)
  })
})
