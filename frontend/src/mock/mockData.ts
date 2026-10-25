/**
 * Mock topology + runtime for UI-only development (used when the backend is unreachable).
 * Emits the v2 contract (route chainage, stations, stop reasons, sim clock …) from a small
 * kinematic sim stepped at 0.5 s like the real backend:
 *   - ATO accelerates (≤1.0 m/s², jerk-limited), cruises at the civil limit, and brakes on a
 *     constant-deceleration curve that lands the nose exactly on the platform stopping point;
 *   - moving-block following: EOA = leader tail − margin; a follower never passes its EOA;
 *   - dwell at every platform it's scheduled to stop at (honours hold / express / skip);
 *   - terminal departures are regulated to an even headway.
 * URL params (dev): `mockTrains=60`, `mockSpeed=5`.
 */
import type {
  DispatchAction,
  RuntimeState,
  TrainPosition,
  TrainState,
  TrainStopReason,
} from '../types/domain'
import { buildYusModel, TRAIN_LEN_M, type MockPlatform } from './buildYusTopology'

const MODEL = buildYusModel()
export const MOCK_TOPOLOGY = MODEL.topology

const L = MODEL.routeLength
const PLAT: MockPlatform[] = MODEL.platforms
const ROUTE = MODEL.trainRoute
const SEG_STARTS = ROUTE.map((e) => MODEL.segStart[e])
const EDGE_BLOCK = new Map(MOCK_TOPOLOGY.edges.map((e) => [e.id, e.block_id]))
const ALL_BLOCKS = [...new Set(MOCK_TOPOLOGY.edges.map((e) => e.block_id))]

const STEP_S = 0.5
const V_LINE = 80 / 3.6
const A_MAX = 1.05
const B_PLAN = 0.9
const B_MAX = 1.3
const JERK = 0.9
const MA_MARGIN = 20
const CAPACITY = 1100

/** Net traction available at v (m/s), mirroring backend/train.py traction_limit_mps2:
 *  constant torque to 35 km/h, constant power to 50, then ∝ 1/v², less running resistance. */
function tractionLimit(v: number): number {
  const kph = v * 3.6
  if (kph >= 88) return 0
  const tractive = kph <= 35 ? A_MAX : kph <= 50 ? (A_MAX * 35) / kph : ((A_MAX * 35) / 50) * (50 / kph) ** 2
  return Math.max(0, tractive - (0.01 + 2.5e-4 * kph + 6e-6 * kph * kph))
}

function param(name: string): number | null {
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get(name)
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const N_TRAINS = Math.max(1, Math.min(120, Math.round(param('mockTrains') ?? 40)))
let simSpeed = Math.max(0.1, Math.min(50, param('mockSpeed') ?? 1))
let paused = false

const wrap = (c: number) => ((c % L) + L) % L
const fwd = (a: number, b: number) => { const d = (b - a) % L; return d < 0 ? d + L : d }

interface MockTrain {
  run: number
  c: number
  v: number
  a: number
  state: TrainState
  reason: TrainStopReason | null
  target: number
  atPlat: number
  dwell: number
  hold: boolean
  express: boolean
  skip: number
  eoa: number
  gap: number | null
  leaderMoving: boolean
}

// ── helpers ─────────────────────────────────────────────────────────────────

function civilLimitAt(c: number): number {
  let v = V_LINE
  for (const r of MODEL.restrictions) if (r.start_m <= c && c < r.end_m) v = Math.min(v, r.limit_kph / 3.6)
  return v
}

/** Lowest limit over the train body, plus braking-curve look-ahead to upcoming limits. */
function civilAllowed(c: number): number {
  let v = Math.min(civilLimitAt(c), civilLimitAt(wrap(c - TRAIN_LEN_M)), civilLimitAt(wrap(c - TRAIN_LEN_M / 2)))
  for (const r of MODEL.restrictions) {
    const d = fwd(c, r.start_m)
    if (d > 0 && d < 1500) v = Math.min(v, Math.sqrt((r.limit_kph / 3.6) ** 2 + 2 * B_PLAN * d))
  }
  return v
}

function nextPlatformAhead(c: number, minDist: number): number {
  let best = 0
  let bd = Infinity
  for (let k = 0; k < PLAT.length; k++) {
    const d = fwd(c, PLAT[k].chainage)
    if (d > minDist && d < bd) { bd = d; best = k }
  }
  return best
}

/** Next stop after platform k, honouring express / skip (mutates skip when `commit`). */
function nextStopFrom(t: MockTrain, k: number, commit: boolean): number {
  let skip = t.skip
  let i = (k + 1) % PLAT.length
  for (let guard = 0; guard < PLAT.length; guard++) {
    const p = PLAT[i]
    if (p.terminal || (!t.express && skip <= 0)) break
    if (skip > 0) skip--
    i = (i + 1) % PLAT.length
  }
  if (commit) t.skip = skip
  return i
}

function retarget(t: MockTrain): void {
  if (t.state === 'dwelling') return
  const brake = (t.v * t.v) / (2 * B_PLAN) + 5
  const k = nextPlatformAhead(t.c, brake)
  const prev = (k - 1 + PLAT.length) % PLAT.length
  t.target = PLAT[k].terminal || (!t.express && t.skip <= 0) ? k : nextStopFrom(t, prev, true)
}

function dwellFor(p: MockPlatform, run: number): number {
  if (p.terminal) return p.role === 'arrival' ? 30 : 25
  const busy = ['Union', 'Bloor–Yonge', 'St George', 'Sheppard–Yonge', 'Eglinton', 'King', 'Dundas'].includes(p.name)
  return 16 + ((p.stopIndex * 37 + run * 11) % 11) + (busy ? 10 : 0)
}

// ── state ───────────────────────────────────────────────────────────────────

let simT = 0
let acc = 0
let trains: MockTrain[] = []
const lastDep = new Map<number, number>()
const refDepartures: number[] = []
const REF_PLAT = PLAT.findIndex((p) => p.name === 'Union' && p.leg === 'ob')
const TARGET_HEADWAY = Math.round(L / 10.5 / N_TRAINS)

function init(): void {
  simT = 0
  acc = 0
  lastDep.clear()
  refDepartures.length = 0
  trains = Array.from({ length: N_TRAINS }, (_, i) => {
    const c = wrap((i * L) / N_TRAINS + 400)
    const t: MockTrain = {
      run: i + 1, c, v: 12, a: 0, state: 'running', reason: null, target: 0, atPlat: -1, dwell: 0,
      hold: false, express: false, skip: 0, eoa: c, gap: null, leaderMoving: true,
    }
    t.target = nextPlatformAhead(c, (12 * 12) / (2 * B_PLAN) + 5)
    return t
  })
  // warm up so the first snapshot already looks like a running service
  for (let k = 0; k < 2400; k++) step(STEP_S)
}

function updateLeaders(): void {
  const order = trains.slice().sort((p, q) => p.c - q.c)
  for (let i = 0; i < order.length; i++) {
    const t = order[i]
    const leader = order[(i + 1) % order.length]
    if (leader === t) {
      t.eoa = wrap(t.c + 3000)
      t.gap = null
      t.leaderMoving = true
      continue
    }
    const tail = wrap(leader.c - TRAIN_LEN_M)
    t.gap = fwd(t.c, tail)
    if (t.gap > L * 0.9) t.gap = 0
    t.eoa = wrap(tail - MA_MARGIN)
    t.leaderMoving = leader.v > 0.1
  }
}

function step(dt: number): void {
  updateLeaders()
  simT += dt
  for (const t of trains) stepTrain(t, dt)
}

function stepTrain(t: MockTrain, dt: number): void {
  let dE = fwd(t.c, t.eoa)
  if (dE > L * 0.75) dE = 0

  if (t.state === 'dwelling') {
    t.v = 0
    t.a = 0
    const p = PLAT[t.atPlat]
    if (t.hold) { t.reason = 'dispatcher_hold'; return }
    t.dwell -= dt
    t.reason = p.terminal && p.role === 'arrival' ? 'turnback' : null
    if (t.dwell > 0) return
    if (dE < 40) { t.reason = 'train_ahead'; return }
    if (p.terminal && p.role === 'departure') {
      const last = lastDep.get(t.atPlat)
      if (last != null && simT - last < TARGET_HEADWAY * 0.8) return
    }
    lastDep.set(t.atPlat, simT)
    if (t.atPlat === REF_PLAT) { refDepartures.push(simT); if (refDepartures.length > 8) refDepartures.shift() }
    t.target = nextStopFrom(t, t.atPlat, true)
    t.atPlat = -1
    t.state = 'running'
    t.reason = null
  }

  const p = PLAT[t.target]
  let dS = fwd(t.c, p.chainage)
  if (dS > L * 0.75) { retarget(t); dS = fwd(t.c, PLAT[t.target].chainage) }
  const v = t.v
  const vStop = Math.sqrt(2 * B_PLAN * Math.max(0, dS - 0.3))
  const vEoa = Math.sqrt(2 * B_PLAN * Math.max(0, dE - 3))
  const vAllowed = Math.min(V_LINE, civilAllowed(t.c), vStop, vEoa)

  let aCmd: number
  const stopBinding = vStop <= vAllowed + 1e-6 && v >= vStop - 0.3
  const eoaBinding = !t.leaderMoving && vEoa <= vAllowed + 1e-6 && v >= vEoa - 0.3
  if ((stopBinding || eoaBinding) && v > 0.05) {
    // constant-deceleration landing on the stop point (or just short of EOA)
    const dist = stopBinding ? dS : Math.max(0.05, dE - 2)
    aCmd = Math.max(-B_MAX, -(v * v) / (2 * Math.max(dist, 0.05)))
  } else {
    aCmd = Math.max(-B_MAX, Math.min(tractionLimit(v), (vAllowed - v) / 1.5))
    aCmd = Math.max(t.a - JERK * dt, Math.min(t.a + JERK * dt, aCmd))
    if (v > vEoa + 0.5) aCmd = Math.min(aCmd, -B_PLAN) // never ride over the EOA curve
  }
  let v1 = Math.max(0, v + aCmd * dt)
  let move = ((v + v1) / 2) * dt

  if (move >= dS - 0.25 && v1 < 1.2 && dS <= dE + 0.5) {
    // arrive
    t.c = PLAT[t.target].chainage
    t.v = 0
    t.a = 0
    t.state = 'dwelling'
    t.atPlat = t.target
    t.dwell = dwellFor(PLAT[t.target], t.run)
    t.reason = null
    return
  }
  if (move > dE) {
    move = Math.max(0, dE)
    v1 = 0
  }
  t.c = wrap(t.c + move)
  t.a = (v1 - v) / dt
  t.v = v1
  if (v1 < 0.05 && move < 0.01) {
    t.v = 0
    t.a = 0
    t.state = 'stopped'
    t.reason = 'train_ahead'
  } else {
    t.reason = null
    const brakeDist = (v1 * v1) / (2 * B_PLAN)
    t.state = aCmd < -0.15 && fwd(t.c, PLAT[t.target].chainage) < brakeDist + 120 ? 'arriving' : 'running'
  }
}

// ── snapshot ────────────────────────────────────────────────────────────────

function edgeAt(c: number): { edge_id: string; offset: number; i: number } {
  let lo = 0
  let hi = SEG_STARTS.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (SEG_STARTS[mid] <= c) lo = mid
    else hi = mid - 1
  }
  const eid = ROUTE[lo]
  return { edge_id: eid, offset: Math.min(1, Math.max(0, (c - SEG_STARTS[lo]) / MODEL.segLen[eid])), i: lo }
}

function snapshot(): RuntimeState {
  const occupied = new Set<string>()
  const bodies: [number, number][] = []
  const out: TrainPosition[] = trains.map((t) => {
    const { edge_id, offset, i: headSeg } = edgeAt(t.c)
    const tailC = wrap(t.c - TRAIN_LEN_M)
    bodies.push([tailC, t.c])
    // occupancy: every edge the body covers
    let si = edgeAt(tailC).i
    for (let guard = 0; guard < 4; guard++) {
      occupied.add(EDGE_BLOCK.get(ROUTE[si]) ?? '')
      if (si === headSeg) break
      si = (si + 1) % ROUTE.length
    }
    const dwelling = t.state === 'dwelling'
    const plat = dwelling ? PLAT[t.atPlat] : PLAT[t.target]
    const nextStop = dwelling ? PLAT[nextStopFrom(t, t.atPlat, false)] : PLAT[t.target]
    const brake = (t.v * t.v) / (2 * B_MAX)
    let dE = fwd(t.c, t.eoa)
    if (dE > L * 0.75) dE = 0
    const load = Math.max(0.05, Math.min(1, 0.45 + 0.3 * Math.sin(t.run * 1.7 + simT / 900)))
    return {
      train_id: `T${String(t.run).padStart(2, '0')}`,
      label: `Run ${t.run}`,
      edge_id,
      offset,
      speed: t.v,
      state: t.state,
      station_name: dwelling || t.state === 'arriving' ? plat.name : null,
      dwell_remaining_sec: dwelling ? Math.max(0, Math.round(t.dwell * 10) / 10) : 0,
      safe_zone_front: brake + 10,
      safe_zone_rear: TRAIN_LEN_M,
      atp_slack_m: Math.round((dE - brake) * 10) / 10,
      authority_eoa_m: Math.round(t.eoa * 100) / 100,
      fleet: 'Bombardier TR',
      passengers: Math.round(CAPACITY * load),
      passenger_capacity: CAPACITY,
      load_pct: Math.round(load * 1000) / 1000,
      dispatch_hold: t.hold,
      dispatch_express: t.express,
      dispatch_skip_remaining: t.skip,
      chainage_m: Math.round(t.c * 1000) / 1000,
      length_m: TRAIN_LEN_M,
      accel_mps2: Math.round(t.a * 1000) / 1000,
      stop_reason: t.reason,
      next_station_name: nextStop.name,
      destination: dwelling ? plat.destination : PLAT[t.target].destination,
      gap_to_leader_m: t.gap == null ? null : Math.round(t.gap),
    }
  })

  const blocks = ALL_BLOCKS.map((bid) => ({
    block_id: bid,
    occupancy: (occupied.has(bid) ? 'occupied' : 'clear') as 'occupied' | 'clear',
  }))

  const signals = MOCK_TOPOLOGY.signals.map((sig) => {
    const s = sig.chainage_m ?? 0
    let nearest = Infinity
    for (const [tail] of bodies) {
      const d = fwd(s, tail)
      if (d < nearest) nearest = d
    }
    const aspect: RuntimeState['signals'][0]['aspect'] = nearest < 260 ? 'red' : nearest < 600 ? 'yellow' : 'green'
    return { signal_id: sig.id, aspect }
  })

  let mean: number | null = null
  if (refDepartures.length >= 3) mean = (refDepartures[refDepartures.length - 1] - refDepartures[0]) / (refDepartures.length - 1)

  return {
    trains: out,
    blocks,
    switches: MOCK_TOPOLOGY.switches.map((sw) => ({ switch_id: sw.id, state: sw.state })),
    signals,
    ops: {
      service: {
        trains_in_service: trains.length,
        target_headway_s: TARGET_HEADWAY,
        mean_headway_s: mean == null ? null : Math.round(mean),
        period: 'Midday',
      },
    },
    sim_time_s: simT,
    sim_speed: simSpeed,
    paused,
    step_s: STEP_S,
    timestamp: Date.now() / 1000,
  }
}

// ── public API ──────────────────────────────────────────────────────────────

let _initialized = false

/** Advance the mock by `dtMs` of wall time (× sim speed, quantized to 0.5 s steps). */
export function tickMockRuntime(dtMs: number): RuntimeState {
  if (!_initialized) { init(); _initialized = true }
  if (!paused) {
    acc += Math.min(Math.max(0, dtMs), 5000) / 1000 * simSpeed
    let guard = 0
    while (acc >= STEP_S - 1e-9 && guard++ < 400) {
      acc -= STEP_S
      step(STEP_S)
    }
  }
  return snapshot()
}

export function mockCommandTrain(trainId: string, action: DispatchAction, count = 1): void {
  if (!_initialized) { init(); _initialized = true }
  const t = trains.find((x) => `T${String(x.run).padStart(2, '0')}` === trainId)
  if (!t) throw new Error(`unknown train ${trainId}`)
  if (action === 'hold') t.hold = true
  else if (action === 'express') { t.express = true; t.hold = false; retarget(t) }
  else if (action === 'skip') { t.skip += Math.max(1, count); retarget(t) }
  else { t.hold = false; t.express = false; t.skip = 0; retarget(t) }
}

export function setMockSimSpeed(x: number): void {
  if (Number.isFinite(x) && x > 0) simSpeed = Math.min(50, x)
}

export function setMockPaused(p: boolean): void {
  paused = p
}

/** Restart the mock service (tests). */
export function resetMock(): void {
  init()
  _initialized = true
}
