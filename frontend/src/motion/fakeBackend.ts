/**
 * TEST HELPER (not used by the app): a fake backend that mirrors backend main._sim_loop
 * (anchored real-time loop, DT 0.2, optional throttling) plus a driver that polls it
 * sequentially at 200 ms with latency jitter and samples the interpolator at 60 fps.
 * Adapted from the independent review's harness.
 */
import type { RuntimeState, TrainPosition, TrainState } from '../types/domain'
import { MotionInterpolator, type Resolver } from './interpolator'
import { fwdDist, signedDelta } from './routeIndex'
import { SpeedDisplay } from './speedDisplay'

export const L = 76_800

export const resolver: Resolver = {
  key: 'test',
  L,
  chainage: (t) => (Number.isFinite(t.chainage_m) ? (t.chainage_m as number) : null),
  eoa: (t) => (Number.isFinite(t.authority_eoa_m) ? (t.authority_eoa_m as number) : null),
}

export interface SimTrain { id: string; c: number; v: number; a: number; state: TrainState; dwell: number; stopAt: number; jitter?: number }

/** Mirrors backend main._sim_loop: anchored real-time loop, DT=0.2, can be throttled. */
export class Backend {
  t = 1000
  paused = false
  speed = 1
  /** max achieved sim-seconds per wall second (host can't keep up) */
  maxRate = Infinity
  step = 0.2
  trains: SimTrain[]
  private acc = 0
  private seed = 11
  private noise(): number {
    this.seed = (this.seed * 16807) % 2147483647
    return this.seed / 2147483647
  }
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
      if (move >= d - 0.3 && v1 < 1.5) { move = d; tr.v = 0; tr.a = 0; tr.state = 'dwelling'; tr.dwell = 20 }
      else { tr.v = v1; tr.a = a; tr.state = a < -0.2 ? 'arriving' : 'running' }
      tr.c = (tr.c + Math.min(move, d)) % L
    }
    this.t += dt
  }
  tick(wallS: number) {
    if (this.paused) return
    this.acc += wallS * Math.min(this.speed, this.maxRate)
    while (this.acc >= this.step - 1e-9) { this.acc -= this.step; this.advance(this.step) }
  }
  snapshot(): RuntimeState {
    return {
      trains: this.trains.map((t): TrainPosition => ({
        train_id: t.id, label: t.id, edge_id: 'x', offset: 0, speed: t.v, state: t.state,
        safe_zone_front: 0, safe_zone_rear: 138,
        chainage_m: (t.c + (t.jitter ? (this.noise() - 0.5) * t.jitter : 0) + L) % L,
        accel_mps2: t.a, length_m: 138,
        authority_eoa_m: (t.c + 900) % L,
      })),
      blocks: [], switches: [], signals: [], timestamp: 0,
      sim_time_s: this.t, sim_speed: this.speed, paused: this.paused, step_s: this.step,
    }
  }
}

export interface Frame { now: number; T: number; c: Map<string, number>; stat: Map<string, boolean>; kmh: Map<string, number>; state: Map<string, string> }

export interface DriveOpts {
  seconds: number
  startMs?: number
  jitterMs?: number
  /** return false → poll fails (no response) */
  deliver?: (now: number) => boolean
  /** return false → no rAF this frame (tab hidden) */
  frameOn?: (now: number) => boolean
  /** poll period override (e.g. background throttling) */
  pollPeriod?: (now: number) => number
  onFrame?: (now: number, be: Backend) => void
  mutate?: (rt: RuntimeState, now: number) => RuntimeState
  interp?: MotionInterpolator
  speeds?: SpeedDisplay
}

export function drive(be: Backend, o: DriveOpts) {
  const interp = o.interp ?? new MotionInterpolator()
  const speeds = o.speeds ?? new SpeedDisplay()
  const frames: Frame[] = []
  const frameMs = 1000 / 60
  const start = o.startMs ?? 0
  let nextPoll = start
  let inflight: { at: number; rt: RuntimeState } | null = null
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  let lastWall = start
  for (let now = start; now <= start + o.seconds * 1000; now += frameMs) {
    be.tick((now - lastWall) / 1000)
    lastWall = now
    o.onFrame?.(now, be)
    // sequential poll: next request only after the previous settled
    if (!inflight && now >= nextPoll) {
      if (!o.deliver || o.deliver(now)) {
        let rt = structuredClone(be.snapshot())
        if (o.mutate) rt = o.mutate(rt, now)
        inflight = { at: now + 10 + rand() * (o.jitterMs ?? 40), rt }
      } else {
        nextPoll = now + (o.pollPeriod?.(now) ?? 200)
      }
    }
    if (inflight && inflight.at <= now) {
      interp.push(inflight.rt, inflight.at)
      nextPoll = inflight.at + Math.max(40, (o.pollPeriod?.(now) ?? 200) - 0)
      inflight = null
    }
    if (o.frameOn && !o.frameOn(now)) continue
    const out = interp.sample(now, resolver)
    const kmh = new Map<string, number>()
    for (const s of out) kmh.set(s.id, speeds.update(s.id, s.speed * 3.6, s.stationary))
    frames.push({
      now,
      T: interp.renderSimTime(),
      c: new Map(out.filter(s => s.c != null).map(s => [s.id, s.c as number])),
      stat: new Map(out.map(s => [s.id, s.stationary])),
      kmh,
      state: new Map(out.map(s => [s.id, s.train.state])),
    })
  }
  return { frames, interp, speeds }
}

export function steps(frames: Frame[], id: string, fromMs = -Infinity, toMs = Infinity) {
  let worstFwd = 0, worstBack = 0, worstFwdAt = 0, worstBackAt = 0
  const list: { now: number; d: number }[] = []
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].now < fromMs || frames[i].now > toMs) continue
    const a = frames[i - 1].c.get(id)
    const b = frames[i].c.get(id)
    if (a == null || b == null) continue
    const d = signedDelta(a, b, L)
    list.push({ now: frames[i].now, d })
    if (d > worstFwd) { worstFwd = d; worstFwdAt = frames[i].now }
    if (d < worstBack) { worstBack = d; worstBackAt = frames[i].now }
  }
  return { worstFwd, worstBack, worstFwdAt, worstBackAt, list }
}
