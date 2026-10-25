/**
 * Render-clock regressions found by the independent review (pause/resume, speed changes,
 * backend not keeping up, legacy stalls, outages). Driven by a fake backend that mirrors
 * backend main._sim_loop (DT 0.2, sequential 200 ms polls, latency jitter, 60 fps).
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../types/domain'
import { MotionInterpolator } from './interpolator'
import { Backend, drive, resolver, steps, type Frame } from './fakeBackend'

const FRAME = 1000 / 60

/** Worst per-frame render-time advance (sim s) within a wall window. */
function worstTStep(frames: Frame[], from: number, to: number): number {
  let w = 0
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].now < from || frames[i].now > to) continue
    w = Math.max(w, frames[i].T - frames[i - 1].T)
  }
  return w
}

function maxStepChange(list: { d: number }[]): number {
  let j = 0
  for (let i = 1; i < list.length; i++) j = Math.max(j, Math.abs(list[i].d - list[i - 1].d))
  return j
}

const snap = (simT: number, c: number, paused: boolean, speed = 1): RuntimeState => ({
  trains: [{ train_id: 'A', label: 'A', edge_id: 'x', offset: 0, speed: 20, state: 'running', safe_zone_front: 0, safe_zone_rear: 0, chainage_m: c, accel_mps2: 0, authority_eoa_m: c + 2000 }],
  blocks: [], switches: [], signals: [], timestamp: 0, sim_time_s: simT, sim_speed: speed, paused, step_s: 0.2,
})

describe('resume after pause', () => {
  it('no leap when the first resumed snapshot still carries the paused sim time', () => {
    const m = new MotionInterpolator()
    let now = 0
    let simT = 100
    let c = 1000
    const frame = () => m.sample(now, resolver)[0].c!
    for (; now < 5000; now += FRAME) {
      if (Math.floor(now / 200) !== Math.floor((now - FRAME) / 200)) { simT += 0.2; c += 4; m.push(snap(simT, c, false), now) }
      frame()
    }
    for (; now < 35_000; now += FRAME) {
      if (Math.floor(now / 200) !== Math.floor((now - FRAME) / 200)) m.push(snap(simT, c, true), now)
      frame()
    }
    const before = frame()
    expect(before).toBe(c) // glided to the paused snapshot
    m.push(snap(simT, c, false), now)
    now += FRAME
    expect(frame() - before).toBeLessThan(0.01)
  })

  for (const sp of [1, 10]) {
    it(`resume at ${sp}× across 40 phases: no jump, then normal speed (no freeze, no crawl)`, () => {
      const normal = (sp * 22) / 60
      for (let k = 0; k < 40; k++) {
        const at = 40_000 + k * 23
        const be = new Backend([{ c: 0, v: 22, stopAt: 76_000 }])
        be.speed = sp
        const r = drive(be, { seconds: 50, onFrame: (now, x) => { x.paused = now >= 10_000 && now < at } })
        expect(worstTStep(r.frames, at, at + 5000)).toBeLessThan((sp / 60) * 3)
        const s = steps(r.frames, 'T0', at, at + 8000)
        expect(s.worstBack).toBeGreaterThanOrEqual(0)
        expect(s.worstFwd).toBeLessThan(normal * 1.5)
        // after the short re-anchor hold, the train runs at true speed
        const later = s.list.filter((x) => x.now > at + 2500)
        const mean = later.reduce((a, x) => a + x.d, 0) / later.length
        expect(mean).toBeGreaterThan(normal * 0.85)
        expect(mean).toBeLessThan(normal * 1.15)
      }
    })
  }
})

describe('sim speed changes', () => {
  for (const from of [10, 5]) {
    it(`${from}× → 1× across 40 phases: render time never snaps`, () => {
      for (let k = 0; k < 40; k++) {
        const at = 15_000 + k * 37
        const be = new Backend([{ c: 0, v: 22, stopAt: 76_000 }])
        be.speed = from
        const r = drive(be, { seconds: 25, onFrame: (now, x) => { if (now >= at) x.speed = 1 } })
        // after the 1× snapshot is ingested a frame advances ≈ 1/60 s (≤ 1.2× while the carried lag bleeds off)
        expect(worstTStep(r.frames, at + 400, at + 9000)).toBeLessThan(0.05)
        const s = steps(r.frames, 'T0', at + 400, at + 9000)
        expect(s.worstBack).toBeGreaterThanOrEqual(0)
        expect(s.worstFwd).toBeLessThan(0.6)
      }
    })
  }

  it('1× → 10× ramps up without jumps', () => {
    const be = new Backend([{ c: 0, v: 22, stopAt: 76_000 }])
    const r = drive(be, { seconds: 30, onFrame: (now, b) => { if (now >= 15_000) b.speed = 10 } })
    const s = steps(r.frames, 'T0', 14_000, 25_000)
    expect(s.worstBack).toBeGreaterThanOrEqual(0)
    expect(s.worstFwd).toBeLessThan((22 * 10) / 60 * 1.1)
  })
})

describe('backend reports more sim_speed than it achieves', () => {
  for (const [rep, ach] of [[10, 5], [10, 7], [50, 20]]) {
    it(`reported ${rep}×, achieved ${ach}×: smooth, no freeze/jump cycles`, () => {
      const be = new Backend([{ c: 0, v: 22, stopAt: 76_000 }])
      be.speed = rep
      be.maxRate = ach
      const r = drive(be, { seconds: 40 })
      const s = steps(r.frames, 'T0', 10_000, 40_000)
      expect(s.list.filter((x) => x.d === 0).length).toBe(0)
      expect(maxStepChange(s.list)).toBeLessThan(0.05)
      expect(s.worstFwd).toBeLessThan((22 * ach) / 60 * 1.1)
    })
  }
})

describe('legacy backend (sim_time_s only, DT 0.5)', () => {
  const legacy = (rt: RuntimeState) => { delete rt.sim_speed; delete rt.paused; delete rt.step_s; return rt }
  for (const pauseS of [3, 15]) {
    it(`pause ${pauseS} s then resume: no crawl, no overshoot`, () => {
      const be = new Backend([{ c: 1000, v: 22, stopAt: 70_000 }])
      be.step = 0.5
      const resumeAt = 10_000 + pauseS * 1000
      const r = drive(be, { seconds: 20 + pauseS, onFrame: (now, b) => { b.paused = now > 10_000 && now < resumeAt }, mutate: legacy })
      const s = steps(r.frames, 'T0', resumeAt, resumeAt + 10_000)
      expect(s.worstBack).toBeGreaterThanOrEqual(0)
      expect(s.worstFwd).toBeLessThan(0.6)
      for (let k = 2; k < 10; k++) {
        const seg = s.list.filter((x) => x.now >= resumeAt + k * 1000 && x.now < resumeAt + (k + 1) * 1000)
        const mps = seg.reduce((a, x) => a + x.d, 0)
        expect(mps).toBeGreaterThan(22 * 0.75)
        expect(mps).toBeLessThan(22 * 1.25)
      }
    })
  }

  it('steady legacy stream stays smooth', () => {
    const be = new Backend([{ c: 1000, v: 22, stopAt: 70_000 }])
    be.step = 0.5
    const r = drive(be, { seconds: 30, mutate: legacy })
    const s = steps(r.frames, 'T0', 5000)
    expect(s.worstBack).toBeGreaterThanOrEqual(0)
    expect(maxStepChange(s.list)).toBeLessThan(0.01)
    expect(s.list.filter((x) => x.d === 0).length).toBe(0)
  })
})

describe('outages', () => {
  for (const outS of [1.2, 5, 12]) {
    it(`${outS} s without responses: bounded catch-up glide, never a jump`, () => {
      const be = new Backend([{ c: 0, v: 22, stopAt: 70_000 }])
      const r = drive(be, { seconds: 40, deliver: (now) => !(now >= 10_000 && now < 10_000 + outS * 1000) })
      const s = steps(r.frames, 'T0', 9_000, 35_000)
      expect(s.worstBack).toBeGreaterThanOrEqual(0)
      expect(s.worstFwd).toBeLessThan((22 / 60) * 3.2) // ≤ ~3× speed while catching up
      // and the backlog is actually closed afterwards
      const tail = s.list.filter((x) => x.now > 10_000 + outS * 1000 + 8000)
      const mean = tail.reduce((a, x) => a + x.d, 0) / tail.length
      expect(mean).toBeGreaterThan((22 / 60) * 0.9)
      expect(mean).toBeLessThan((22 / 60) * 1.1)
    })
  }
})
