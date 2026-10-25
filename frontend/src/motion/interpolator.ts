/**
 * Snapshot interpolation for train motion.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * 1. Every accepted /state snapshot is buffered by `sim_time_s` (duplicates of the same
 *    sim time just refresh the data; stale/out-of-order ones are dropped).
 * 2. A render clock maps client time → sim time. It estimates the server's continuous
 *    sim clock ("lead") from the freshest-arriving snapshots (max offset over a window,
 *    NTP-style) and renders `delay` behind it, where `delay` adapts to the worst observed
 *    staleness right before each new snapshot (≈ step_s + poll gap × sim_speed + jitter),
 *    so there is almost always a snapshot on both sides of the render time. The clock is
 *    slewed (±30 % rate), never jumped, and never runs backwards. Paused → it glides to the
 *    latest snapshot and stops.
 * 3. Each train's nose chainage is interpolated between the bracketing snapshots with a
 *    monotone (Fritsch–Carlson) cubic Hermite using the reported speeds as tangents:
 *    C¹-smooth, never overshoots, never goes backwards. Dwelling/stopped trains use zero
 *    tangents, so a train that is still in both snapshots is exactly still.
 * 4. If the render time passes the newest snapshot (late data), the train is dead-reckoned
 *    from speed/accel for at most `maxHorizon` sim seconds (≈0.8 s wall), never past its EOA.
 *    When the late snapshot lands, the difference is carried as a per-train error that decays
 *    (τ≈0.35 s) — no visible snap — and the rendered chainage is clamped to never move
 *    backwards (it holds still instead).
 * 5. Implausible jumps (spawn from yard, id reuse, resets) are treated as teleports: the
 *    train switches position at the snapshot boundary instead of streaking across the map.
 */
import type { RuntimeState, TrainPosition } from '../types/domain'
import { fwdDist, signedDelta, wrapC } from './routeIndex'

// ── Tunables ────────────────────────────────────────────────────────────────
const OFFSET_WINDOW_MS = 4000
const LAG_WINDOW_MS = 8000
const RATE_WINDOW_MS = 5000
const STALL_MS = 2500
const SLEW_MAX = 0.3
const SLEW_FILTER_S = 0.5
const ERR_TAU_S = 0.35
const RELAYOUT_TOL_M = 60      // a layout swap keeps continuity when chainage agrees this well
const BACK_TOL_M = 60          // small backward corrections → hold, not reverse
const TELEPORT_M = 250
const STILL_SPEED = 0.05       // m/s
const STILL_DEADBAND_M = 0.01
const MAX_BUFFER = 240

export interface Resolver {
  /** identity: smoothing state resets when this changes (e.g. topology re-layout) */
  key: unknown
  L: number
  chainage(t: TrainPosition): number | null
  eoa(t: TrainPosition): number | null
}

export interface MotionSample {
  id: string
  /** Discrete data from the snapshot at/just before render time. */
  train: TrainPosition
  /** Rendered nose chainage (m) or null when the train can't be placed on the route. */
  c: number | null
  /** Interpolated speed, m/s (0 when stationary). */
  speed: number
  /** True when the rendered position is not changing (dwelling, stopped, held). */
  stationary: boolean
  /** Interpolated end-of-authority chainage, or null. */
  eoa: number | null
  /** Client ms when this train was first drawn (fade-in). */
  firstSeenMs: number
}

interface Snap {
  simT: number
  recvMs: number
  trains: Map<string, TrainPosition>
  list: TrainPosition[]
}

interface Truth {
  c: number
  v: number
  still: boolean
  eoa: number | null
  /** the s0→s1 pair is a teleport (spawn/yard/reset): hold c0, switch at teleAt */
  tele: boolean
  teleAt: number
  train: TrainPosition | null
}

interface Smooth {
  key: unknown
  truthPrev: number
  renderPrev: number
  err: number
  ver: number
  firstSeenMs: number
  lastFrame: number
  /** sim time at which a pending teleport takes effect */
  teleAt: number | null
}

function isStill(t: TrainPosition): boolean {
  return t.state === 'dwelling' || t.state === 'stopped' || !(Math.abs(t.speed ?? 0) >= STILL_SPEED)
}

function tangent(t: TrainPosition): number {
  return isStill(t) ? 0 : Math.max(0, t.speed ?? 0)
}

/** Monotone cubic Hermite displacement in [0, d] at s ∈ [0,1]. */
export function hermiteDisp(d: number, v0: number, v1: number, h: number, s: number): number {
  if (!(d > 0) || !(h > 0)) return 0
  if (s <= 0) return 0
  if (s >= 1) return d
  const m = d / h
  let a = Math.max(0, v0) / m
  let b = Math.max(0, v1) / m
  const r = a * a + b * b
  if (r > 9) {
    const k = 3 / Math.sqrt(r)
    a *= k
    b *= k
  }
  const s2 = s * s
  const s3 = s2 * s
  const disp = h * (s3 - 2 * s2 + s) * a * m + h * (s3 - s2) * b * m + d * (3 * s2 - 2 * s3)
  return Math.max(0, Math.min(d, disp))
}

/** Distance travelled from speed v with accel a over τ (never reversing). */
export function deadReckon(v: number, a: number, tau: number): number {
  if (!(tau > 0) || !(v > 0)) return 0
  const acc = Number.isFinite(a) ? a : 0
  if (acc < 0) {
    const tStop = v / -acc
    const t = Math.min(tau, tStop)
    return v * t + 0.5 * acc * t * t
  }
  return v * tau + 0.5 * acc * tau * tau
}

// ── Render clock ────────────────────────────────────────────────────────────

const CATCHUP_K_MAX = 2          // bounded catch-up glide: render clock ≤ 3× the sim rate
const RESYNC_MIN_S = 30          // only a hopeless backlog (≥ max(30 s, 15·rate)) resyncs directly
const SEED_DECAY = 0.2           // render lag carried over a speed change bleeds off at 20 % of rate
const RESUME_HOLD_MAX_MS = 4000
const MEASURED_SWITCH = 0.25     // use the measured rate when it disagrees with sim_speed by > 25 %
const MEASURED_RETURN = 0.15     // …and go back to sim_speed once within 15 %
const HIST_GAP_MS = 1500         // pairs further apart than this are stalls, not rate evidence

export class RenderClock {
  rate = 1
  lastPositiveRate = 1
  paused = false
  stepS = 0.5
  hasSimSpeed = false
  /** true while the measured rate overrides an inconsistent `sim_speed` */
  usingMeasured = false
  latestSimT = -Infinity
  latestNewRecvMs = 0
  renderT = 0
  slewK = 0
  initialized = false
  private reported: number | null = null
  /** lead fallback when no offsets are available: (sim time, client ms) of the freshest anchor */
  private anchorSimT = -Infinity
  private anchorMs = 0
  /** set on resume (pause / stall → running): hold renderT until the target catches up */
  private resumeHoldSince: number | null = null
  /** delay floor carried across a rate change so the render position never snaps */
  private seedValue = 0
  private seedMs = 0
  private seedDecay = 0
  private lastNowMs = 0
  private offsets: { ms: number; off: number }[] = []
  private lags: { ms: number; lag: number }[] = []
  private hist: { ms: number; simT: number }[] = []

  reset(): void {
    this.rate = 1
    this.lastPositiveRate = 1
    this.paused = false
    this.hasSimSpeed = false
    this.usingMeasured = false
    this.latestSimT = -Infinity
    this.latestNewRecvMs = 0
    this.initialized = false
    this.slewK = 0
    this.reported = null
    this.anchorSimT = -Infinity
    this.anchorMs = 0
    this.resumeHoldSince = null
    this.seedValue = 0
    this.offsets = []
    this.lags = []
    this.hist = []
  }

  private prune(nowMs: number): void {
    while (this.offsets.length && nowMs - this.offsets[0].ms > OFFSET_WINDOW_MS) this.offsets.shift()
    while (this.lags.length && nowMs - this.lags[0].ms > LAG_WINDOW_MS) this.lags.shift()
    while (this.hist.length > 1 && nowMs - this.hist[0].ms > RATE_WINDOW_MS) this.hist.shift()
  }

  /** Gap a new snapshot may follow the previous one by and still count as steady streaming. */
  private gapMs(): number {
    return Math.max(HIST_GAP_MS, 3000 * this.stepS / Math.max(this.lastPositiveRate, 0.05))
  }

  /** Achieved sim rate from recent snapshots, excluding stalls; null until ~1.2 s of evidence. */
  measuredRate(): number | null {
    const h = this.hist
    const gap = this.gapMs()
    let sim = 0
    let ms = 0
    for (let i = 1; i < h.length; i++) {
      const dms = h[i].ms - h[i - 1].ms
      if (!(dms > 0) || dms > gap) continue
      sim += h[i].simT - h[i - 1].simT
      ms += dms
    }
    if (ms < 1200) return null
    return Math.max(0, sim / (ms / 1000))
  }

  /** Sim seconds the server clock is believed to be at, at client time nowMs. */
  lead(nowMs: number): number {
    if (this.rate <= 0) return this.latestSimT
    if (this.offsets.length === 0) {
      return Math.max(this.latestSimT, this.anchorSimT + this.rate * Math.max(0, nowMs - this.anchorMs) / 1000)
    }
    let best = -Infinity
    for (const o of this.offsets) if (o.off > best) best = o.off
    return Math.max(this.latestSimT, this.rate * nowMs / 1000 + best)
  }

  private seedAt(nowMs: number): number {
    if (!(this.seedValue > 0)) return 0
    return Math.max(0, this.seedValue - this.seedDecay * Math.max(0, nowMs - this.seedMs) / 1000)
  }

  /** Render delay (sim seconds). */
  delay(nowMs: number = this.lastNowMs): number {
    const r = Math.max(this.rate, 0)
    let base: number
    if (this.lags.length === 0) {
      base = this.stepS + 0.35 * r + 0.1
    } else {
      let worst = 0
      for (const l of this.lags) if (l.lag > worst) worst = l.lag
      const d = worst * 1.1 + Math.max(0.05, 0.06 * r)
      base = Math.max(this.stepS * 0.5, Math.min(d, Math.max(4, 3 * r)))
    }
    return Math.max(base, this.seedAt(nowMs))
  }

  /** Max dead-reckoning past the newest snapshot (sim s). */
  maxHorizon(): number {
    const r = this.lastPositiveRate
    return Math.min(Math.max(r * 0.8, this.stepS), 4)
  }

  effectiveRate(nowMs: number): number {
    if (this.paused) return 0
    if (!this.hasSimSpeed && this.initialized && nowMs - this.latestNewRecvMs > STALL_MS) return 0
    return this.rate
  }

  observe(simT: number, recvMs: number, simSpeed: number | undefined, paused: boolean | undefined, stepS: number | undefined): boolean {
    if (Number.isFinite(stepS) && (stepS as number) > 0) this.stepS = stepS as number
    const isNew = simT > this.latestSimT + 1e-9
    const hadData = Number.isFinite(this.latestSimT)
    const sinceNewMs = recvMs - this.latestNewRecvMs
    const wasStalled = !this.hasSimSpeed && hadData && sinceNewMs > STALL_MS
    const reported = Number.isFinite(simSpeed) && (simSpeed as number) >= 0 ? (simSpeed as number) : null
    if (reported != null) this.hasSimSpeed = true
    this.paused = paused === true || reported === 0
    // Rate history must not span a pause, a stall or a commanded speed change.
    const speedChanged = reported != null && this.reported != null && Math.abs(reported - this.reported) > 1e-6
    if (this.paused || speedChanged || (wasStalled && isNew)) this.hist = []
    this.reported = reported
    if (isNew && !this.paused) this.hist.push({ ms: recvMs, simT })
    this.prune(recvMs)

    // Pick the rate: sim_speed, unless the backend demonstrably isn't achieving it.
    const measured = this.measuredRate()
    let rate: number
    if (this.paused) {
      rate = 0
    } else if (reported != null) {
      if (measured == null || !(reported > 0)) this.usingMeasured = false
      else {
        const rel = Math.abs(measured - reported) / reported
        this.usingMeasured = this.usingMeasured ? rel > MEASURED_RETURN : rel > MEASURED_SWITCH
      }
      rate = this.usingMeasured && measured != null ? measured : reported
    } else {
      rate = measured ?? (this.rate > 0 ? this.rate : this.lastPositiveRate)
    }
    const prevRate = this.rate
    const tol = reported != null && !this.usingMeasured
      ? 1e-6
      : reported != null ? Math.max(0.05, 0.1 * Math.max(rate, prevRate)) : Math.max(0.2, 0.25 * Math.max(rate, prevRate))
    const changed = Math.abs(rate - prevRate) > tol
    const resumed = this.initialized && rate > 0 && ((changed && prevRate <= 0) || (wasStalled && isNew))
    if (changed) this.rate = rate
    if (changed || resumed) this.offsets = []
    // Staleness (lags) is measured in sim seconds, so it only carries over at the same rate.
    if (rate > 0 && Math.abs(rate - this.lastPositiveRate) > tol) this.lags = []

    if (isNew) {
      // A snapshot after an outage/stall says nothing about steady-state staleness.
      const steady = sinceNewMs <= this.gapMs()
      if (hadData && this.rate > 0 && this.offsets.length > 0 && !resumed && steady) {
        const lag = this.lead(recvMs) - this.latestSimT
        if (Number.isFinite(lag) && lag >= 0) this.lags.push({ ms: recvMs, lag })
      }
      if (this.rate > 0) this.offsets.push({ ms: recvMs, off: simT - this.rate * recvMs / 1000 })
      this.latestSimT = simT
      this.latestNewRecvMs = recvMs
      this.anchorSimT = simT
      this.anchorMs = recvMs
    }
    if (resumed) {
      // Re-anchor: the server clock restarts from the paused sim time NOW (the first resumed
      // snapshot often still carries the paused sim_time_s), and the render clock waits
      // where it is until the target catches up — no leap, no crawl.
      this.anchorSimT = this.latestSimT
      this.anchorMs = recvMs
      this.resumeHoldSince = recvMs
      this.slewK = 0
      this.seedValue = 0
    } else if (changed && prevRate > 0 && rate > 0 && this.initialized) {
      // Speed change: keep the current render lag as a delay floor that bleeds off gently,
      // so the render position stays continuous instead of snapping to the new target.
      this.seedValue = Math.max(0, this.lead(recvMs) - this.renderT)
      this.seedMs = recvMs
      this.seedDecay = SEED_DECAY * rate
    }
    if (this.rate > 0) this.lastPositiveRate = this.rate
    return isNew
  }

  target(nowMs: number): number {
    if (this.effectiveRate(nowMs) <= 0) return this.latestSimT
    return this.lead(nowMs) - this.delay(nowMs)
  }

  advance(nowMs: number): number {
    if (!Number.isFinite(this.latestSimT)) return this.renderT
    const tgt = this.target(nowMs)
    if (!this.initialized) {
      this.renderT = tgt
      this.initialized = true
      this.lastNowMs = nowMs
      return this.renderT
    }
    const dtW = (nowMs - this.lastNowMs) / 1000
    this.lastNowMs = nowMs
    if (!(dtW > 0)) return this.renderT
    const prev = this.renderT
    const rate = this.effectiveRate(nowMs)
    if (dtW > 1.0) {
      // tab was hidden / frame stalled — catch up directly (forward only)
      this.renderT = Math.max(prev, tgt)
      this.slewK = 0
      this.resumeHoldSince = null
    } else if (rate <= 0) {
      if (prev < tgt) this.renderT = Math.min(tgt, prev + dtW * Math.max(this.lastPositiveRate, 1))
      this.slewK = 0
    } else if (this.resumeHoldSince != null && tgt <= prev && nowMs - this.resumeHoldSince < RESUME_HOLD_MAX_MS) {
      // just resumed: stay put until the render target reaches us
      this.slewK = 0
    } else {
      this.resumeHoldSince = null
      const e = tgt - prev
      if (e > Math.max(RESYNC_MIN_S, rate * 15)) {
        this.renderT = tgt // hopelessly behind (very long outage): resync
        this.slewK = 0
      } else if (e < -Math.max(2, rate * 2)) {
        // far ahead (shouldn't happen) — hold until the target catches up
        this.slewK = 0
      } else {
        // Slew factor is low-passed so a change in target never shows up as a sudden speed
        // change of every train (2nd-order loop, ζ≈0.6). Large backlogs (after an outage)
        // are closed by a bounded catch-up glide (≤ 3× rate) instead of a jump.
        const kT = Math.max(-SLEW_MAX, Math.min(CATCHUP_K_MAX, e / Math.max(rate * 0.75, 0.2)))
        this.slewK += (kT - this.slewK) * (1 - Math.exp(-dtW / SLEW_FILTER_S))
        this.renderT = prev + dtW * rate * (1 + this.slewK)
      }
    }
    const cap = this.latestSimT + (rate > 0 ? this.maxHorizon() : 0)
    if (this.renderT > cap) {
      this.renderT = Math.max(cap, prev)
      if (this.slewK > 0) this.slewK = 0 // don't wind up while waiting for data
    }
    return this.renderT
  }
}

// ── Interpolator ────────────────────────────────────────────────────────────

export class MotionInterpolator {
  readonly clock = new RenderClock()
  private snaps: Snap[] = []
  private version = 0
  private smooth = new Map<string, Smooth>()
  private pool = new Map<string, MotionSample>()
  private prevRenderT = NaN
  private prevNowMs = NaN
  private frameNo = 0

  reset(): void {
    this.clock.reset()
    this.snaps = []
    this.smooth.clear()
    this.version++
    this.prevRenderT = NaN
    this.prevNowMs = NaN
  }

  get latest(): RuntimeState | null {
    return this._latestRt
  }
  private _latestRt: RuntimeState | null = null

  get snapshotCount(): number {
    return this.snaps.length
  }

  push(rt: RuntimeState, recvMs: number): void {
    const raw = rt.sim_time_s
    const simT = Number.isFinite(raw) ? (raw as number) : recvMs / 1000
    const last = this.snaps[this.snaps.length - 1]
    if (last && simT < last.simT - 1e-9) {
      if (simT < last.simT - 2) {
        this.reset() // sim restarted
      } else {
        return // stale replica / out-of-order
      }
    }
    this._latestRt = rt
    const trains = new Map<string, TrainPosition>()
    for (const t of rt.trains ?? []) trains.set(t.train_id, t)
    const tail = this.snaps[this.snaps.length - 1]
    const speed = Number.isFinite(raw) ? rt.sim_speed : 1
    this.clock.observe(simT, recvMs, speed, rt.paused, rt.step_s)
    if (tail && Math.abs(tail.simT - simT) <= 1e-9) {
      tail.trains = trains
      tail.list = rt.trains ?? []
    } else {
      this.snaps.push({ simT, recvMs, trains, list: rt.trains ?? [] })
      if (this.snaps.length > MAX_BUFFER) this.snaps.splice(0, this.snaps.length - MAX_BUFFER)
    }
    this.version++
  }

  /** Index i with snaps[i].simT <= T < snaps[i+1].simT (clamped). */
  private bracket(T: number): number {
    const s = this.snaps
    if (s.length === 0) return -1
    if (T <= s[0].simT) return 0
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid].simT <= T) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Ground-truth (unsmoothed) state of one train at sim time T. */
  private truth(id: string, T: number, res: Resolver, out: Truth): boolean {
    const i = this.bracket(T)
    if (i < 0) return false
    const s0 = this.snaps[i]
    const t0 = s0.trains.get(id)
    if (!t0) return false
    const c0 = res.chainage(t0)
    if (c0 == null) return false
    const L = res.L
    out.train = t0
    out.tele = false
    const e0 = res.eoa(t0)
    const s1 = this.snaps[i + 1]
    const t1 = s1 ? s1.trains.get(id) : undefined
    const c1 = t1 ? res.chainage(t1) : null
    if (s1 && T < s1.simT && T >= s0.simT && t1 && c1 != null) {
      const h = s1.simT - s0.simT
      const s = (T - s0.simT) / h
      const v0 = tangent(t0)
      const v1 = tangent(t1)
      let d = fwdDist(c0, c1, L)
      if (d > L / 2) {
        // moved backwards
        if (L - d < BACK_TOL_M) d = 0
        else { out.tele = true; out.teleAt = s1.simT; d = 0 }
      } else {
        const plausible = Math.max(v0, v1, 25) * h * 1.3 + 40
        if (d > plausible) { out.tele = true; out.teleAt = s1.simT; d = 0 }
      }
      if (!out.tele && v0 === 0 && v1 === 0) {
        // Stationary in both snapshots (dwelling / stopped / speed 0): never animate a slide.
        // Sub-cm noise is absorbed by the dead-band; a real correction (berth adjustment)
        // snaps cleanly when the newer snapshot becomes current.
        out.c = c0
        out.still = true
        out.v = 0
      } else {
        out.c = d > 0 ? wrapC(c0 + hermiteDisp(d, v0, v1, h, s), L) : c0
        out.still = d === 0
        out.v = out.still ? 0 : v0 + (v1 - v0) * s
        // Pulling away from a stop: report the newer (running) state so labels/tooltip
        // don't say "dwelling" while the train is visibly moving.
        if (!out.still && v0 === 0 && v1 > 0) out.train = t1
      }
      const e1 = res.eoa(t1)
      if (e0 != null && e1 != null) {
        const de = fwdDist(e0, e1, L)
        out.eoa = de < 2000 ? wrapC(e0 + de * s, L) : (s < 0.5 ? e0 : e1)
      } else {
        out.eoa = e0
      }
      return true
    }
    // Extrapolate from the newest data for this train (or hold if it vanished next snapshot).
    out.eoa = e0
    if (s1 && !t1) {
      out.c = c0; out.v = 0; out.still = true
      return true
    }
    const tau = Math.min(Math.max(0, T - s0.simT), this.clock.maxHorizon())
    const v0 = tangent(t0)
    if (v0 <= 0 || tau <= 0) {
      out.c = c0
      out.v = v0
      out.still = v0 <= 0
      return true
    }
    let dist = deadReckon(v0, t0.accel_mps2 ?? 0, tau)
    if (e0 != null) {
      let cap = fwdDist(c0, e0, L)
      if (cap > L * 0.75) cap = 0
      dist = Math.min(dist, Math.max(0, cap - 0.5))
    }
    out.c = wrapC(c0 + dist, L)
    out.v = Math.max(0, v0 + (t0.accel_mps2 ?? 0) * tau)
    out.still = dist <= 0
    return true
  }

  private _tr: Truth = { c: 0, v: 0, still: false, eoa: null, tele: false, teleAt: 0, train: null }
  private _tp: Truth = { c: 0, v: 0, still: false, eoa: null, tele: false, teleAt: 0, train: null }

  /** Sample all trains for this frame. Returned array is reused between calls. */
  sample(nowMs: number, res: Resolver | null, out: MotionSample[] = []): MotionSample[] {
    out.length = 0
    if (this.snaps.length === 0) return out
    const T = this.clock.advance(nowMs)
    const dtW = Number.isFinite(this.prevNowMs) ? Math.max(0, (nowMs - this.prevNowMs) / 1000) : 0
    const Tprev = this.prevRenderT
    this.frameNo++
    const i = Math.max(0, this.bracket(T))
    const s0 = this.snaps[i]
    const list = s0.list

    for (const t0 of list) {
      const id = t0.train_id
      let o = this.pool.get(id)
      if (!o) {
        o = { id, train: t0, c: null, speed: 0, stationary: true, eoa: null, firstSeenMs: nowMs }
        this.pool.set(id, o)
      }
      const tr = this._tr
      if (!res || !this.truth(id, T, res, tr)) {
        // Off-route / no route index: raw latest data, no interpolation.
        const latest = this.snaps[this.snaps.length - 1].trains.get(id) ?? t0
        o.train = latest
        o.c = null
        o.speed = tangent(latest)
        o.stationary = isStill(latest)
        o.eoa = null
        this.smooth.delete(id)
        out.push(o)
        continue
      }
      const L = res.L
      let st = this.smooth.get(id)
      let render: number
      const continuing = !!st && st.lastFrame === this.frameNo - 1
      if (st && continuing && st.key !== res.key) {
        // Re-layout (schematic ↔ geographic): chainage is layout-independent, so the train
        // keeps its smoothing state and fade; if the chainage scale itself changed (legacy
        // pixel lengths), re-seat it without fading.
        if (Math.abs(signedDelta(st.truthPrev, tr.c, L)) <= RELAYOUT_TOL_M) {
          st.key = res.key
        } else {
          st = { key: res.key, truthPrev: tr.c, renderPrev: tr.c, err: 0, ver: this.version, firstSeenMs: st.firstSeenMs, lastFrame: this.frameNo - 1, teleAt: null }
          this.smooth.set(id, st)
        }
      }
      const teleNow = !!st && st.teleAt != null && T >= st.teleAt
      if (!st || !continuing || teleNow) {
        // New train, gap in sampling, or a teleport boundary was crossed:
        // place it directly and fade it in — never streak.
        st = { key: res.key, truthPrev: tr.c, renderPrev: tr.c, err: 0, ver: this.version, firstSeenMs: nowMs, lastFrame: this.frameNo - 1, teleAt: null }
        this.smooth.set(id, st)
        render = tr.c
      } else {
        if (st.ver !== this.version && Number.isFinite(Tprev)) {
          // Buffer changed: did the truth at the previous render time move? Carry the
          // difference as decaying error so a late snapshot never causes a visible snap.
          const tp = this._tp
          if (this.truth(id, Tprev, res, tp)) {
            const delta = signedDelta(tp.c, st.truthPrev, L)
            if (Math.abs(delta) > TELEPORT_M) st.err = 0
            else st.err += delta
          }
          st.ver = this.version
        }
        let cand: number
        if (tr.still) {
          // A stationary train never slides: drop any residual error and either hold
          // (noise, or truth behind us) or snap cleanly forward to the true position.
          st.err = 0
          cand = tr.c
        } else {
          st.err *= Math.exp(-dtW / ERR_TAU_S)
          if (Math.abs(st.err) < 0.02) st.err = 0
          cand = wrapC(tr.c + st.err, L)
        }
        const step = signedDelta(st.renderPrev, cand, L)
        if (step < 0 && step > -TELEPORT_M) cand = st.renderPrev
        // dead-band: a still train never creeps by float noise
        else if (tr.still && step < STILL_DEADBAND_M) cand = st.renderPrev
        render = cand
      }
      if (tr.tele) st.teleAt = tr.teleAt
      const moved = render !== st.renderPrev
      st.truthPrev = tr.c
      st.renderPrev = render
      st.lastFrame = this.frameNo
      o.train = tr.train ?? t0
      o.c = render
      // stationary = not travelling: a still train that snaps (berth correction) still reads 0 km/h
      o.stationary = tr.still || (!moved && tr.v <= STILL_SPEED)
      o.speed = o.stationary ? 0 : Math.max(0, tr.v)
      o.eoa = tr.eoa
      o.firstSeenMs = st.firstSeenMs
      out.push(o)
    }

    // housekeeping
    if (this.frameNo % 120 === 0) {
      for (const [id, st] of this.smooth) if (this.frameNo - st.lastFrame > 120) this.smooth.delete(id)
      for (const id of this.pool.keys()) if (!s0.trains.has(id) && !this.smooth.has(id)) this.pool.delete(id)
    }
    const keepFrom = Math.min(Number.isFinite(Tprev) ? Tprev : T, T)
    while (this.snaps.length > 2 && this.snaps[1].simT <= keepFrom) this.snaps.shift()
    this.prevRenderT = T
    this.prevNowMs = nowMs
    return out
  }

  renderSimTime(): number {
    return this.clock.renderT
  }
}
