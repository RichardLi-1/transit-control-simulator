/**
 * Dev-only map hook for headless checks: `window.__cbtcMap`.
 *
 *   __cbtcMap.focus(['Spadina', 'Union', 'Bloor–Yonge'], 40)  → zoom the camera onto stations
 *   __cbtcMap.zoomTo(cx, cy, zoom) / .fit() / .camera()
 *   __cbtcMap.labels()  → text placed last frame (key + box), for overlap checks
 *   __cbtcMap.why('station:Osgoode')  → why a label was culled
 *   __cbtcMap.preview({ trains: { T05: { e_brake: true } }, switches: { sw_mid_14: 'reverse' } })
 *       → dev-only visual preview of states the live sim may not be showing (null clears)
 */
import type { SwitchState, Topology, TrainPosition } from '../types/domain'
import type { Viewport } from './Viewport'
import { getLayoutMeta } from '../layout/meta'
import { nameKey } from '../layout/meta'
import { explainLabel, lastPlacements } from '../motion/labels'
import { lastLayoutTarget, measureLayoutTarget } from '../layout/index'
import { signalHitAreas } from './layers/SignalLayer'
import { switchHitAreas } from './layers/SwitchLayer'

let current: { vp: Viewport; topology: Topology } | null = null

interface Preview { trains?: Record<string, Partial<TrainPosition>>; switches?: Record<string, SwitchState> }
let preview: Preview | null = null

/** Dev-only state preview for a train (merged over the live data), or the train itself. */
export function previewTrain(t: TrainPosition): TrainPosition {
  const o = preview?.trains?.[t.train_id]
  return o ? { ...t, ...o } : t
}

/** Dev-only points-position preview, or undefined. */
export function previewSwitch(id: string): SwitchState | undefined {
  return preview?.switches?.[id]
}
let installed = false

export function installMapDebug(vp: Viewport, topology: Topology): void {
  if (!import.meta.env?.DEV || typeof window === 'undefined') return
  if (current) {
    current.vp = vp
    current.topology = topology
  } else {
    current = { vp, topology }
  }
  if (installed) return
  installed = true
  ;(window as unknown as { __cbtcMap: unknown }).__cbtcMap = {
    camera: () => ({ ...current!.vp.camera, width: current!.vp.width, height: current!.vp.height }),
    zoomTo: (cx: number, cy: number, zoom: number) => {
      Object.assign(current!.vp.camera, { cx, cy, zoom })
      return true
    },
    fit: () => {
      const b = current!.topology.bounds
      current!.vp.fitToBounds({ minX: b.min_x, minY: b.min_y, maxX: b.max_x, maxY: b.max_y })
      return true
    },
    focus: (names: string[], padPx = 40) => {
      const meta = getLayoutMeta(current!.topology)
      const want = new Set(names.map(nameKey))
      const pts = meta.stations.filter((s) => want.has(nameKey(s.name))).map((s) => s.center)
      if (!pts.length) return false
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
      const vp = current!.vp
      const zoom = Math.min((vp.width - padPx * 2) / Math.max(1, maxX - minX), (vp.height - padPx * 2) / Math.max(1, maxY - minY))
      Object.assign(vp.camera, { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom: Math.min(40, zoom) })
      return { ...vp.camera }
    },
    labels: () => lastPlacements().map((p) => ({ key: p.request.key, ...p.box })),
    why: (keyPrefix: string) => explainLabel(keyPrefix),
    layoutTarget: () => ({ used: lastLayoutTarget(), now: measureLayoutTarget() }),
    hitAreas: () => ({ signals: signalHitAreas(current!.vp, current!.topology), switches: switchHitAreas(current!.vp, current!.topology) }),
    preview: (p: Preview | null) => {
      preview = p
      return true
    },
  }
}
