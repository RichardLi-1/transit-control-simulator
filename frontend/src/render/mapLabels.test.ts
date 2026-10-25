/**
 * End-to-end check of the shared label pass: runs the real map layers (track, stations,
 * switches, signals, trains) against a recording-free fake canvas, then verifies that the text
 * they placed never overlaps other text and never touches the obstacles it avoids.
 */
import { describe, expect, it } from 'vitest'
import { buildYusTopology } from '../mock/buildYusTopology'
import type { RuntimeState, Topology, TrainPosition } from '../types/domain'
import { buildSchematic, type LayoutTarget } from '../layout/schematic'
import { Viewport, setFitInsets } from './Viewport'
import { renderTrackLayer } from './layers/TrackLayer'
import { renderLabelLayer } from './layers/LabelLayer'
import { renderSwitchLayer, switchHitAreas } from './layers/SwitchLayer'
import { renderSignalLayer, signalHitAreas } from './layers/SignalLayer'
import { renderTrainLayer } from './layers/TrainLayer'
import { boxesTouch, labelObstacles, lastPlacements, Obstacle, type Placement } from '../motion/labels'
import { getRouteIndex } from '../motion/routeIndex'
import type { MotionFrame, MotionTrain } from '../motion/engine'
import { pickHitArea } from './hit'
import { getLayoutMeta, nameKey } from '../layout/meta'

function fakeCtx(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { font: '10px sans-serif' }
  const fontPx = () => {
    const m = /(\d+(?:\.\d+)?)px/.exec(String(state.font))
    return m ? Number(m[1]) : 10
  }
  return new Proxy({}, {
    get(_, k) {
      if (k === 'measureText') return (t: string) => ({ width: t.length * fontPx() * 0.58 })
      if (k in state) return state[k]
      return () => {}
    },
    set(_, k, v) {
      state[k] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

const SCREEN = { w: 1120, h: 832, insets: { top: 16, right: 56, bottom: 16, left: 16 } }
const target: LayoutTarget = { width: SCREEN.w - 72, height: SCREEN.h - 32 }

function setup(): { topo: Topology; rt: RuntimeState; frame: MotionFrame } {
  const { topology } = buildYusTopology()
  const topo = buildSchematic(topology, { target })!.topology
  const rt = {
    trains: [],
    blocks: [],
    switches: topo.switches.map((s, i) => ({ switch_id: s.id, state: i % 2 ? 'reverse' : 'normal' })),
    signals: topo.signals.map((s, i) => ({ signal_id: s.id, aspect: (['green', 'yellow', 'red'] as const)[i % 3] })),
  } as unknown as RuntimeState
  const route = getRouteIndex(topo)!
  const trains: MotionTrain[] = []
  const n = 56
  for (let k = 0; k < n; k++) {
    const c = ((k + 0.37) / n) * route.lengthM
    const train = {
      train_id: `T${k}`, label: `Run ${k}`, state: k % 4 === 0 ? 'dwelling' : 'running', speed: 20,
      edge_id: '', offset: 0, safe_zone_front: 300, safe_zone_rear: 100, atp_slack_m: k % 9 === 0 ? 5 : 400,
      dispatch_hold: k === 5, dispatch_express: false, dispatch_skip_remaining: 0, in_service: k !== 7,
      e_brake: k === 11,
    } as unknown as TrainPosition
    trains.push({
      id: train.train_id, train, c, speed: 20, stationary: false, eoa: c + 600, firstSeenMs: -1e9,
      lengthM: 138, displayKmh: 72, alpha: 1, drawn: false, screenPts: [], halfWidth: 0, naturalPx: 0,
      labelRect: null, badgeRect: null,
    })
  }
  const frame = { nowMs: 0, simT: 0, route, trains, byId: new Map(trains.map((t) => [t.id, t])) } as MotionFrame
  return { topo, rt, frame }
}

function drawFrame(vp: Viewport, topo: Topology, rt: RuntimeState, frame: MotionFrame): Placement[] {
  const ctx = fakeCtx()
  renderTrackLayer(ctx, vp, topo)
  renderLabelLayer(ctx, vp, topo, true)
  renderSwitchLayer(ctx, vp, topo, rt)
  renderSignalLayer(ctx, vp, topo, rt, false)
  renderTrainLayer(ctx, vp, topo, rt, frame, { showSafeZones: true, showLabels: true, hoveredId: null, selectedId: null })
  return lastPlacements()
}

function fitVp(topo: Topology): Viewport {
  setFitInsets(SCREEN.insets)
  const vp = new Viewport()
  vp.resize(SCREEN.w, SCREEN.h)
  const b = topo.bounds
  vp.fitToBounds({ minX: b.min_x, minY: b.min_y, maxX: b.max_x, maxY: b.max_y })
  setFitInsets({ top: 0, right: 0, bottom: 0, left: 0 })
  return vp
}

function focusVp(topo: Topology, names: string[], zoom: number): Viewport {
  const meta = getLayoutMeta(topo)
  const want = new Set(names.map(nameKey))
  const pts = meta.stations.filter((s) => want.has(nameKey(s.name))).map((s) => s.center)
  const vp = new Viewport()
  vp.resize(SCREEN.w, SCREEN.h)
  vp.camera = {
    cx: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    cy: pts.reduce((a, p) => a + p.y, 0) / pts.length,
    zoom,
  }
  return vp
}

function expectClean(placed: Placement[]): void {
  const obs = labelObstacles()
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]
    const mask = p.request.avoid ?? Obstacle.all
    if (!p.request.force) expect(obs.hits(p.box, mask, 0), `${p.request.key} touches an obstacle`).toBe(false)
    for (let j = i + 1; j < placed.length; j++) {
      expect(boxesTouch(p.box, placed[j].box), `${p.request.key} overlaps ${placed[j].request.key}`).toBe(false)
    }
  }
}

describe('map label pass (all layers)', () => {
  const { topo, rt, frame } = setup()

  it('at desktop fit: every station named, no text overlaps text or track', () => {
    const placed = drawFrame(fitVp(topo), topo, rt, frame)
    const stations = placed.filter((p) => p.request.key.startsWith('station:'))
    expect(stations.length).toBe(38)
    // no internal ids anywhere on the map
    for (const p of placed) expect(p.request.key).not.toMatch(/mid_\d/)
    expect(placed.some((p) => p.request.key.startsWith('yard:'))).toBe(true)
    expectClean(placed)
  })

  for (const [name, names, zoom] of [
    ['downtown', ['Spadina', 'St George', 'Bloor–Yonge'], 1.7],
    ['Spadina → St George close-up', ['Spadina', 'St George'], 6],
    ['Bloor–Yonge close-up', ['Bloor–Yonge', 'Rosedale'], 6],
    ['Finch terminal', ['Finch', 'North York Ctr'], 5],
    ['Davisville yard', ['Davisville', 'Eglinton'], 3],
    ['Wilson yard', ['Wilson', 'Sheppard West'], 3],
  ] as [string, string[], number][]) {
    it(`zoomed (${name}): signal names, speed tags, train ids and station names never overlap`, () => {
      const placed = drawFrame(focusVp(topo, names, zoom), topo, rt, frame)
      for (const n of names) expect(placed.some((p) => p.request.key === `station:${n}`), n).toBe(true)
      expectClean(placed)
    })
  }

  it('shows signal names and speed tags once zoomed in', () => {
    const placed = drawFrame(focusVp(topo, ['Spadina', 'St George'], 6), topo, rt, frame)
    expect(placed.some((p) => p.request.key.startsWith('signal:'))).toBe(true)
    expect(placed.some((p) => p.request.key.startsWith('speed:'))).toBe(true)
  })

  it('hit areas come from the drawn glyphs (signal head, crossover diagonal)', () => {
    const vp = focusVp(topo, ['Spadina', 'St George'], 6)
    drawFrame(vp, topo, rt, frame)
    const sigs = signalHitAreas(vp, topo)
    expect(sigs.length).toBeGreaterThan(0)
    for (const a of sigs) expect(pickHitArea(sigs, a.bx, a.by)).toBe(a.id) // the head itself
    const sw = switchHitAreas(vp, topo).filter((a) => a.id === 'sw_mid_14')
    expect(sw.length).toBe(1)
    const a = sw[0]
    expect(pickHitArea(sw, (a.ax + a.bx) / 2, (a.ay + a.by) / 2)).toBe('sw_mid_14')
  })

  it('never throws on bad data', () => {
    const bad = {
      ...topo,
      edges: [...topo.edges.slice(0, 5), { ...topo.edges[5], points: null }, { ...topo.edges[6], points: [{ x: NaN, y: 1 }, { x: 2, y: 2 }] }, ...topo.edges.slice(7)],
      signals: [...topo.signals, { ...topo.signals[0], id: 'sig_bad', edge_id: 'nope', offset: NaN }],
      switches: [...topo.switches, { ...topo.switches[0], id: 'sw_bad', reverse_edge_id: 'missing' }],
      yards: [...(topo.yards ?? []), { name: 'Ghost', chainage_m: NaN }],
      speed_restrictions: [...(topo.speed_restrictions ?? []), { start_m: NaN, end_m: 5, limit_kph: 10 }],
    } as unknown as Topology
    const vp = fitVp(topo)
    expect(() => drawFrame(vp, bad, rt, frame)).not.toThrow()
    expect(() => drawFrame(vp, bad, { ...rt, signals: null, switches: undefined } as unknown as RuntimeState, frame)).not.toThrow()
  })
})
