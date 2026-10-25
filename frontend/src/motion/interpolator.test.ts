import { describe, expect, it } from 'vitest'
import type { RuntimeState, TrainPosition, TrainState } from '../types/domain'
import { MotionInterpolator, deadReckon, hermiteDisp, type Resolver } from './interpolator'
import { fwdDist, signedDelta } from './routeIndex'
import { SpeedDisplay } from './speedDisplay'
import { Backend, drive as driveBackend, steps } from './fakeBackend'

const L = 10_000

const resolver: Resolver = {
  key: 'test',
  L,
  chainage: (t) => (Number.isFinite(t.chainage_m) ? (t.chainage_m as number) : null),
  eoa: (t) => (Number.isFinite(t.authority_eoa_m) ? (t.authority_eoa_m as number) : null),
}

interface SimTrain { id: string; c: number; v: number; a: number; state: TrainState; dwell: number; stopAt: number }

/** Tiny stand-in for the backend: 0.5 s steps, accelerate/cruise/brake/dwell between stops. */
class FakeBackend {
  t = 0
  paused = false
  speed = 1
  trains: SimTrain[]
  readonly step = 0.5
  constructor(trains: Partial<SimTrain>[]) {
    this.trains = trains.map((t, i) => ({ id: `T${i}`, c: 0, v: 0, a: 0, state: 'running', dwell: 0, stopAt: 800, ...t }))
  }
  advance(dt: number) {
    for (const tr of this.trains) {
      if (tr.state === 'dwelling') {
        tr.dwell -= dt
        tr.a = 0
        if (tr.dwell <= 0) { tr.state = 'running'; tr.stopAt = (tr.stopAt + 1200) % L }
        continue
      }
      const d = fwdDist(tr.c, tr.stopAt, L)
      const vCap = Math.min(22, Math.sqrt(2 * 1.0 * Math.max(0, d - tr.v * dt)))
      const a = Math.max(-1.3, Math.min(1.0, (vCap - tr.v) / dt))
      const v1 = Math.max(0, tr.v + a * dt)
      let move = (tr.v + v1) / 2 * dt
      if (move >= d - 0.3 && v1 < 1.5) { move = d; tr.v = 0; tr.a = 0; tr.state = 'dwelling'; tr.dwell = 6 }
      else { tr.v = v1; tr.a = a; tr.state = a < -0.2 ? 'arriving' : 'running' }
      tr.c = (tr.c + Math.min(move, d)) % L
    }
    this.t += dt
  }
  /** Advance by wall time (respecting sim speed and step quantization). */
  private acc = 0
  tick(wallS: number) {
    if (this.paused) return
    this.acc += wallS * this.speed
    while (this.acc >= this.step - 1e-9) { this.acc -= this.step; this.advance(this.step) }
  }
  snapshot(): RuntimeState {
    return {
      trains: this.trains.map((t): TrainPosition => ({
        train_id: t.id, label: t.id, edge_id: 'x', offset: 0, speed: t.v, state: t.state,
        safe_zone_front: 0, safe_zone_rear: 138, chainage_m: t.c, accel_mps2: t.a, length_m: 138,
        authority_eoa_m: (t.c + 900) % L,
      })),
      blocks: [], switches: [], signals: [], timestamp: 0,
      sim_time_s: this.t, sim_speed: this.speed, paused: this.paused, step_s: this.step,
    }
  }
}

interface Run {
  frames: { now: number; c: Map<string, number>; stat: Map<string, boolean>; T: number }[]
}

/**
 * Drive interpolator at 60 fps with a sequential 200 ms poll and latency jitter.
 * `deliver(now)` may return false to simulate a late/missing response.
 */
function drive(be: FakeBackend, seconds: number, opts: { jitterMs?: number; deliver?: (now: number) => boolean; onFrame?: (now: number) => void; interp?: MotionInterpolator } = {}): Run & { interp: MotionInterpolator } {
  const interp = opts.interp ?? new MotionInterpolator()
  const frames: Run['frames'] = []
  const frameMs = 1000 / 60
  let nextPoll = 0
  let pending: { at: number; rt: RuntimeState }[] = []
  let seed = 3
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  let lastWall = 0
  for (let now = 0; now <= seconds * 1000; now += frameMs) {
    be.tick((now - lastWall) / 1000)
    lastWall = now
    opts.onFrame?.(now)
    if (now >= nextPoll) {
      if (!opts.deliver || opts.deliver(now)) {
        pending.push({ at: now + 10 + rand() * (opts.jitterMs ?? 50), rt: structuredClone(be.snapshot()) })
      }
      nextPoll = now + 200
    }
    const ready = pending.filter(p => p.at <= now)
    pending = pending.filter(p => p.at > now)
    for (const p of ready) interp.push(p.rt, p.at)
    const out = interp.sample(now, resolver)
    frames.push({
      now,
      T: interp.renderSimTime(),
      c: new Map(out.filter(o => o.c != null).map(o => [o.id, o.c as number])),
      stat: new Map(out.map(o => [o.id, o.stationary])),
    })
  }
  return { frames, interp }
}

function maxStep(run: Run, id: string, from = 0) {
  let worstFwd = 0
  let worstBack = 0
  for (let i = Math.max(1, from); i < run.frames.length; i++) {
    const a = run.frames[i - 1].c.get(id)
    const b = run.frames[i].c.get(id)
    if (a == null || b == null) continue
    const d = signedDelta(a, b, L)
    worstFwd = Math.max(worstFwd, d)
    worstBack = Math.min(worstBack, d)
  }
  return { worstFwd, worstBack }
}

describe('hermite / dead-reckoning primitives', () => {
  it('monotone hermite stays within [0, d] and is monotone even with inconsistent speeds', () => {
    let prev = 0
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const x = hermiteDisp(10, 40, 0, 0.5, s) // speeds way too high for the displacement
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(x).toBeLessThanOrEqual(10 + 1e-9)
      prev = x
    }
    expect(hermiteDisp(10, 20, 20, 0.5, 1)).toBe(10)
    expect(hermiteDisp(0, 20, 20, 0.5, 0.5)).toBe(0)
  })
  it('dead reckoning never reverses when braking', () => {
    expect(deadReckon(2, -1, 10)).toBeCloseTo(2) // stops after 2 s: 2·2 − ½·4
    expect(deadReckon(0, 1, 1)).toBe(0)
  })
})

describe('MotionInterpolator', () => {
  it('moves forward smoothly with no jumps or reversals (accelerate, cruise, brake, dwell)', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 800 }, { c: 5000, stopAt: 5600 }])
    const run = drive(be, 120)
    for (const id of ['T0', 'T1']) {
      const { worstFwd, worstBack } = maxStep(run, id, 120)
      expect(worstBack).toBeGreaterThanOrEqual(0) // never backwards
      // 22 m/s max → 0.367 m per 60 fps frame; allow 35 % slew + rounding
      expect(worstFwd).toBeLessThan(0.55)
    }
  })

  it('frame-to-frame speed changes are smooth (no stutter at 0.5 s snapshot boundaries)', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 3000 }])
    const run = drive(be, 60)
    // per-frame displacement must change gradually everywhere (accel, cruise) — no
    // velocity steps at the 0.5 s snapshot boundaries
    const steps: number[] = []
    for (let i = 120; i < run.frames.length; i++) {
      const a = run.frames[i - 1].c.get('T0')!
      const b = run.frames[i].c.get('T0')!
      steps.push(signedDelta(a, b, L))
    }
    expect(steps.filter(s => s > 0.35).length).toBeGreaterThan(600) // reached line speed
    let worst = 0
    for (let i = 1; i < steps.length; i++) worst = Math.max(worst, Math.abs(steps[i] - steps[i - 1]))
    // < 0.004 m/frame² ≈ 0.24 m/s change between frames (raw 0.5 s snapshots: ~11 m jumps)
    expect(worst).toBeLessThan(0.004)
  })

  it('a dwelling train is perfectly still', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 300 }])
    const run = drive(be, 60)
    // find a window where the backend reports dwelling for > 3 s: rendered c must be constant
    let stillFrames = 0
    let constRun = 0
    for (let i = 1; i < run.frames.length; i++) {
      const f = run.frames[i]
      if (f.stat.get('T0')) {
        stillFrames++
        if (run.frames[i - 1].stat.get('T0')) {
          expect(f.c.get('T0')).toBe(run.frames[i - 1].c.get('T0'))
          constRun++
        }
      }
    }
    expect(stillFrames).toBeGreaterThan(200) // ~6 s dwell at 60 fps, several times
    expect(constRun).toBeGreaterThan(200)
  })

  it('renders close to (but behind) the live sim — delay under a second at 1×', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 9000 }])
    const run = drive(be, 30)
    const last = run.frames[run.frames.length - 1]
    const lag = be.t - last.T
    expect(lag).toBeGreaterThan(0.3)
    expect(lag).toBeLessThan(1.1)
  })

  it('no snap when snapshots arrive late (1.2 s outage, then resume)', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 9000 }])
    const run = drive(be, 40, { deliver: (now) => !(now > 20_000 && now < 21_200) })
    const { worstFwd, worstBack } = maxStep(run, 'T0', 1100)
    expect(worstBack).toBeGreaterThanOrEqual(0)
    expect(worstFwd).toBeLessThan(0.75) // a catch-up glide, not a jump
  })

  it('dead-reckoning stops at EOA', () => {
    const interp = new MotionInterpolator()
    const mk = (simT: number, c: number): RuntimeState => ({
      trains: [{ train_id: 'A', label: 'A', edge_id: 'x', offset: 0, speed: 20, state: 'running', safe_zone_front: 0, safe_zone_rear: 0, chainage_m: c, accel_mps2: 0, authority_eoa_m: c + 3 }],
      blocks: [], switches: [], signals: [], timestamp: 0, sim_time_s: simT, sim_speed: 1, paused: false, step_s: 0.5,
    })
    interp.push(mk(0, 100), 0)
    interp.push(mk(0.5, 110), 500)
    let c = 0
    for (let now = 500; now < 4000; now += 16) c = interp.sample(now, resolver)[0].c!
    expect(c).toBeLessThanOrEqual(113)
    expect(c).toBeGreaterThan(110)
  })

  it('handles pause: trains glide to the paused snapshot and freeze', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 9000 }])
    let pausedAt = -1
    const run = drive(be, 30, {
      onFrame: (now) => { if (now >= 15_000 && !be.paused) { be.paused = true; pausedAt = be.t } },
    })
    const tail = run.frames.slice(-300) // last 5 s
    const c0 = tail[0].c.get('T0')!
    for (const f of tail) expect(f.c.get('T0')).toBe(c0)
    expect(Math.abs(signedDelta(be.trains[0].c, c0, L))).toBeLessThan(0.01)
    expect(pausedAt).toBeGreaterThan(0)
  })

  it('wraps forward across the end of the ring', () => {
    const be = new FakeBackend([{ c: L - 400, v: 20, stopAt: 1000 }])
    const run = drive(be, 30)
    const { worstBack } = maxStep(run, 'T0', 5)
    expect(worstBack).toBeGreaterThanOrEqual(0)
    const cs = run.frames.map(f => f.c.get('T0')!).filter(Number.isFinite)
    expect(Math.max(...cs)).toBeGreaterThan(L - 100)
    expect(cs[cs.length - 1]).toBeLessThan(1001)
  })

  it('spawned / teleported trains appear in place instead of streaking', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 9000 }])
    let spawned = false
    const run = drive(be, 20, {
      onFrame: (now) => {
        if (now >= 8000 && !spawned) {
          spawned = true
          be.trains.push({ id: 'NEW', c: 7000, v: 0, a: 0, state: 'dwelling', dwell: 100, stopAt: 7000 })
          be.trains[0].c = (be.trains[0].c + 3000) % L // teleport T0 forward 3 km
        }
      },
    })
    const newCs = run.frames.map(f => f.c.get('NEW')).filter((c): c is number => c != null)
    expect(newCs.length).toBeGreaterThan(100)
    expect(new Set(newCs).size).toBe(1) // never moved
    expect(newCs[0]).toBe(7000)
    // T0: exactly one big jump, every other step small and forward
    let big = 0
    for (let i = 1; i < run.frames.length; i++) {
      const a = run.frames[i - 1].c.get('T0')
      const b = run.frames[i].c.get('T0')
      if (a == null || b == null) continue
      const d = signedDelta(a, b, L)
      if (Math.abs(d) > 5) big++
      else expect(d).toBeGreaterThanOrEqual(0)
    }
    expect(big).toBe(1)
  })

  it('copes with 10× sim speed', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 2000 }])
    be.speed = 10
    const run = drive(be, 30)
    const { worstFwd, worstBack } = maxStep(run, 'T0', 120)
    expect(worstBack).toBeGreaterThanOrEqual(0)
    expect(worstFwd).toBeLessThan(22 * 10 / 60 * 1.4)
  })

  it('treats legacy snapshots without sim_speed by estimating the rate', () => {
    const be = new FakeBackend([{ c: 0, stopAt: 9000 }])
    const interp = new MotionInterpolator()
    const orig = be.snapshot.bind(be)
    be.snapshot = () => { const s = orig(); delete s.sim_speed; delete s.paused; delete s.step_s; return s }
    const run = drive(be, 30, { interp })
    const { worstFwd, worstBack } = maxStep(run, 'T0', 300)
    expect(worstBack).toBeGreaterThanOrEqual(0)
    expect(worstFwd).toBeLessThan(0.6)
  })

  it('a dwelling train with sub-mm chainage noise is perfectly still and reads 0 km/h', () => {
    const be = new Backend([{ c: 5000, v: 0, state: 'dwelling', dwell: 1e9, stopAt: 5000, jitter: 0.002 }])
    const r = driveBackend(be, { seconds: 20 })
    let notStill = 0
    let kmh = 0
    let moved = 0
    for (let i = 60; i < r.frames.length; i++) {
      const f = r.frames[i]
      if (!f.stat.get('T0')) notStill++
      if ((f.kmh.get('T0') ?? 0) !== 0) kmh++
      if (f.c.get('T0') !== r.frames[i - 1].c.get('T0')) moved++
    }
    expect({ notStill, kmh, moved }).toEqual({ notStill: 0, kmh: 0, moved: 0 })
  })

  it('a dwelling train whose position is corrected forward snaps once (no slide, no km/h)', () => {
    const be = new Backend([{ c: 5000, v: 0, state: 'dwelling', dwell: 1e9, stopAt: 5000 }])
    const sd = new SpeedDisplay()
    const r = driveBackend(be, { seconds: 10, speeds: sd, onFrame: (now, b) => { if (now > 5000) b.trains[0].c = 5030 } })
    const s = steps(r.frames, 'T0', 4_000, 8_000)
    expect(s.list.filter((x) => x.d > 0).length).toBe(1)
    expect(s.worstFwd).toBeCloseTo(30, 5)
    for (const f of r.frames) if (f.now > 4000) expect(f.kmh.get('T0')).toBe(0)
  })

  it('a departing train reports its running state as soon as it moves', () => {
    const interp = new MotionInterpolator()
    const mk = (simT: number, c: number, v: number, state: TrainState): RuntimeState => ({
      trains: [{ train_id: 'A', label: 'A', edge_id: 'x', offset: 0, speed: v, state, safe_zone_front: 0, safe_zone_rear: 0, chainage_m: c, accel_mps2: 1, authority_eoa_m: c + 900 }],
      blocks: [], switches: [], signals: [], timestamp: 0, sim_time_s: simT, sim_speed: 1, paused: false, step_s: 0.5,
    })
    interp.push(mk(0, 100, 0, 'dwelling'), 0)
    interp.push(mk(0.5, 100, 0, 'dwelling'), 500)
    interp.push(mk(1.0, 100.12, 0.5, 'running'), 1000)
    interp.push(mk(1.5, 100.5, 1.0, 'running'), 1500)
    let sawMovingDwell = false
    for (let now = 1500; now < 3500; now += 16) {
      const o = interp.sample(now, resolver)[0]
      if (!o.stationary && o.train.state === 'dwelling') sawMovingDwell = true
    }
    expect(sawMovingDwell).toBe(false)
  })
})

