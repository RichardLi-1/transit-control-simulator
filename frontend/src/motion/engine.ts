/**
 * Motion engine — the single source of truth for where trains are drawn.
 *
 * - runtimeStore calls `motion.ingest(state, receivedAt)` for every accepted /state.
 * - CanvasView calls `motion.computeFrame(topology, now)` once per animation frame;
 *   TrainLayer draws from that frame and records each train's screen geometry on it, and
 *   CanvasView hit-tests against the same geometry, so clicks match what's drawn.
 * - Tooltip / GUIDE read `motion.getTrain(id)` / `motion.displayKmh(id)` so every speed
 *   shown in the UI comes from the interpolated state with display hysteresis.
 */
import type { RuntimeState, Topology, TrainPosition } from '../types/domain'
import { MotionInterpolator, type MotionSample, type Resolver } from './interpolator'
import { chainageOfEdgeOffset, getRouteIndex, wrapC, type RouteIndex } from './routeIndex'
import { SpeedDisplay } from './speedDisplay'

export const DEFAULT_TRAIN_LENGTH_M = 138

export interface ScreenRect { x: number; y: number; w: number; h: number }

/** Per-train state for one frame. Screen fields are written by TrainLayer. */
export interface MotionTrain extends MotionSample {
  lengthM: number
  /** km/h as displayed everywhere (hysteresis applied) */
  displayKmh: number
  /** 0..1 fade-in */
  alpha: number
  // ── screen geometry (filled by TrainLayer during draw) ──
  drawn: boolean
  /** flat [x0,y0,x1,y1,…] screen polyline of the body, tail → nose */
  screenPts: number[]
  halfWidth: number
  /** screen length the body would have at its real length (before the minimum-length stretch) */
  naturalPx: number
  labelRect: ScreenRect | null
  badgeRect: ScreenRect | null
}

export interface MotionFrame {
  nowMs: number
  /** render sim time (s) */
  simT: number
  route: RouteIndex | null
  trains: MotionTrain[]
  byId: Map<string, MotionTrain>
}

export class MotionEngine {
  readonly interp = new MotionInterpolator()
  readonly speeds = new SpeedDisplay()
  private samples: MotionSample[] = []
  private pool = new Map<string, MotionTrain>()
  private resolverFor = new WeakMap<RouteIndex, Resolver>()
  readonly frame: MotionFrame = { nowMs: 0, simT: 0, route: null, trains: [], byId: new Map() }
  private ids = new Set<string>()

  ingest(rt: RuntimeState, recvMs: number): void {
    this.interp.push(rt, recvMs)
  }

  reset(): void {
    this.interp.reset()
    this.speeds.clear()
    this.frame.trains.length = 0
    this.frame.byId.clear()
  }

  private resolver(idx: RouteIndex): Resolver {
    let r = this.resolverFor.get(idx)
    if (!r) {
      const L = idx.lengthM
      const useChainage = idx.fromContract
      r = {
        key: idx,
        L,
        chainage: (t: TrainPosition) => {
          if (useChainage && Number.isFinite(t.chainage_m)) return wrapC(t.chainage_m as number, L)
          return chainageOfEdgeOffset(idx, t.edge_id, t.offset)
        },
        eoa: (t: TrainPosition) => (Number.isFinite(t.authority_eoa_m) ? wrapC(t.authority_eoa_m as number, L) : null),
      }
      this.resolverFor.set(idx, r)
    }
    return r
  }

  /** Compute interpolated train state for this frame. Call once per rAF. */
  computeFrame(topology: Topology | null, nowMs: number): MotionFrame {
    const route = getRouteIndex(topology)
    const res = route ? this.resolver(route) : null
    const samples = this.interp.sample(nowMs, res, this.samples)
    const f = this.frame
    f.nowMs = nowMs
    f.simT = this.interp.renderSimTime()
    f.route = route
    f.trains.length = 0
    f.byId.clear()
    this.ids.clear()
    for (const s of samples) {
      let m = this.pool.get(s.id)
      if (!m) {
        m = {
          ...s,
          lengthM: DEFAULT_TRAIN_LENGTH_M,
          displayKmh: 0,
          alpha: 1,
          drawn: false,
          screenPts: [],
          halfWidth: 0,
          naturalPx: 0,
          labelRect: null,
          badgeRect: null,
        }
        this.pool.set(s.id, m)
      }
      m.train = s.train
      m.c = s.c
      m.speed = s.speed
      m.stationary = s.stationary
      m.eoa = s.eoa
      m.firstSeenMs = s.firstSeenMs
      m.lengthM = s.train.length_m && s.train.length_m > 0 ? s.train.length_m : DEFAULT_TRAIN_LENGTH_M
      m.alpha = Math.max(0, Math.min(1, (nowMs - s.firstSeenMs) / 350))
      m.displayKmh = this.speeds.update(s.id, s.speed * 3.6, s.stationary)
      m.drawn = false
      m.naturalPx = 0
      m.screenPts.length = 0
      m.labelRect = null
      m.badgeRect = null
      f.trains.push(m)
      f.byId.set(s.id, m)
      this.ids.add(s.id)
    }
    if (this.pool.size > this.ids.size + 32) {
      for (const id of this.pool.keys()) if (!this.ids.has(id)) this.pool.delete(id)
      this.speeds.retain(this.ids)
    }
    return f
  }

  getTrain(id: string): MotionTrain | undefined {
    return this.frame.byId.get(id)
  }

  /** Displayed km/h (hysteresis) for a train, if it has been rendered. */
  displayKmh(id: string): number | undefined {
    return this.frame.byId.get(id)?.displayKmh
  }

  /** Forward metres from the rendered nose to EOA, if known. */
  authorityAheadM(id: string): number | null {
    const m = this.frame.byId.get(id)
    const route = this.frame.route
    if (!m || m.c == null || m.eoa == null || !route) return null
    let d = (m.eoa - m.c) % route.lengthM
    if (d < 0) d += route.lengthM
    return d > route.lengthM * 0.75 ? 0 : d
  }
}

export const motion = new MotionEngine()
