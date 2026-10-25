/**
 * Dev-only motion diagnostics: `window.__cbtcDebug`.
 *
 *   __cbtcDebug.frame()          → current interpolated trains (chainage, screen nose, state)
 *   __cbtcDebug.record(seconds)  → Promise<stats> of frame-to-frame motion over that window
 *   __cbtcDebug.mock.setSpeed(5) / .setPaused(true)
 *
 * With `?motionDebug=<seconds>` in the URL it records automatically once trains appear and
 * writes the stats JSON into <pre id="cbtc-motion-debug"> (readable via chrome --dump-dom).
 */
import type { MotionFrame } from './engine'
import { motion } from './engine'
import { signedDelta } from './routeIndex'
import { setMockPaused, setMockSimSpeed } from '../mock/mockData'

interface Sample { t: number; simT: number; trains: Map<string, { c: number | null; x: number; y: number; stationary: boolean; kmh: number }> }

let recording: { until: number; samples: Sample[]; resolve: (s: MotionStats) => void } | null = null

export interface MotionStats {
  frames: number
  seconds: number
  fps: number
  trains: number
  /** worst per-frame forward chainage step (m) and its implied speed (m per SIM second) */
  maxStepM: number
  maxStepImpliedMps: number
  /** frames where a train moved backwards along the route */
  backwardSteps: number
  /** per-frame steps exceeding (shown speed × Δsim-time × 1.6 + 0.5 m) */
  jumpSteps: number
  /** frames where a train flagged stationary moved at all */
  stationaryMoves: number
  /** worst frame-to-frame change in per-frame displacement (m), a jerkiness measure */
  maxStepChangeM: number
  /** worst screen-space nose displacement per frame (px) */
  maxScreenStepPx: number
  /** displayed-km/h changes per train per second (flicker measure) */
  kmhChangesPerTrainSec: number
}

function computeStats(samples: Sample[]): MotionStats {
  const L = motion.frame.route?.lengthM ?? Infinity
  let maxStep = 0
  let maxImplied = 0
  let back = 0
  let jumps = 0
  let stillMoves = 0
  let maxChange = 0
  let maxScreen = 0
  let kmhChanges = 0
  const ids = new Set<string>()
  const lastStep = new Map<string, number>()
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const dt = (b.t - a.t) / 1000
    const dSim = Math.max(0, b.simT - a.simT)
    if (!(dt > 0)) continue
    for (const [id, tb] of b.trains) {
      ids.add(id)
      const ta = a.trains.get(id)
      if (!ta || ta.c == null || tb.c == null) continue
      const d = Number.isFinite(L) ? signedDelta(ta.c, tb.c, L) : tb.c - ta.c
      if (d < -1e-9) back++
      if (d > maxStep) { maxStep = d; maxImplied = dSim > 0 ? d / dSim : Infinity }
      const allowed = ((Math.max(ta.kmh, tb.kmh) + 1) / 3.6) * dSim * 1.6 + 0.5
      if (d > allowed && Math.abs(d) < 200) jumps++
      if (ta.stationary && tb.stationary && d !== 0) stillMoves++
      const prev = lastStep.get(id)
      if (prev != null) maxChange = Math.max(maxChange, Math.abs(d - prev))
      lastStep.set(id, d)
      maxScreen = Math.max(maxScreen, Math.hypot(tb.x - ta.x, tb.y - ta.y))
      if (ta.kmh !== tb.kmh) kmhChanges++
    }
  }
  const seconds = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0
  const r = (v: number, k = 3) => Math.round(v * 10 ** k) / 10 ** k
  return {
    frames: samples.length,
    seconds: r(seconds, 2),
    fps: r(samples.length / Math.max(seconds, 1e-6), 1),
    trains: ids.size,
    maxStepM: r(maxStep),
    maxStepImpliedMps: r(maxImplied, 2),
    backwardSteps: back,
    jumpSteps: jumps,
    stationaryMoves: stillMoves,
    maxStepChangeM: r(maxChange, 4),
    maxScreenStepPx: r(maxScreen, 2),
    kmhChangesPerTrainSec: r(kmhChanges / Math.max(1, ids.size) / Math.max(seconds, 1e-6), 3),
  }
}

/** Call after each drawn frame (cheap no-op unless recording). */
export function debugAfterFrame(frame: MotionFrame): void {
  if (!recording) return
  const trains = new Map<string, { c: number | null; x: number; y: number; stationary: boolean; kmh: number }>()
  for (const m of frame.trains) {
    const n = m.screenPts.length
    trains.set(m.id, { c: m.c, x: n ? m.screenPts[n - 2] : NaN, y: n ? m.screenPts[n - 1] : NaN, stationary: m.stationary, kmh: m.displayKmh })
  }
  recording.samples.push({ t: frame.nowMs, simT: frame.simT, trains })
  if (frame.nowMs >= recording.until) {
    const r = recording
    recording = null
    r.resolve(computeStats(r.samples))
  }
}

function record(seconds: number): Promise<MotionStats> {
  return new Promise((resolve) => {
    recording = { until: performance.now() + seconds * 1000, samples: [], resolve }
  })
}

export function installMotionDebug(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.__cbtcDebug) return
  w.__cbtcDebug = {
    motion,
    frame: () => motion.frame.trains.map((m) => ({
      id: m.id, c: m.c, state: m.train.state, kmh: m.displayKmh, stationary: m.stationary,
      nose: m.screenPts.length ? [m.screenPts[m.screenPts.length - 2], m.screenPts[m.screenPts.length - 1]] : null,
    })),
    record,
    simTime: () => motion.frame.simT,
    mock: { setSpeed: setMockSimSpeed, setPaused: setMockPaused },
  }
  const secs = Number(new URLSearchParams(window.location.search).get('motionDebug'))
  if (Number.isFinite(secs) && secs > 0) {
    const start = () => {
      if (motion.frame.trains.length === 0) { setTimeout(start, 250); return }
      void record(secs).then((stats) => {
        const pre = document.createElement('pre')
        pre.id = 'cbtc-motion-debug'
        pre.style.display = 'none'
        pre.textContent = JSON.stringify(stats)
        document.body.appendChild(pre)
        console.info('[motionDebug]', stats)
      })
    }
    setTimeout(start, 1500) // let the render clock settle
  }
}
