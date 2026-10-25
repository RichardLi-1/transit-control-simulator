/**
 * Per-layout station metadata (centre, track direction, label side, priority, interchanges).
 *
 * Stored beside a topology object in a WeakMap so the shared `Topology` type stays untouched:
 * the schematic layout registers exact metadata; for any other topology (geographic map, tests)
 * it is derived once from the ob_/ib_ node pairs and cached.
 */
import type { Topology, TopologyNode, Vec2 } from '../types/domain'

export type LayoutKind = 'schematic' | 'geographic'

export interface StationMeta {
  index: number
  name: string
  /** Midpoint between the two platform nodes (world). */
  center: Vec2
  /** Unit vector along the track in ob (towards Finch) travel direction. */
  along: Vec2
  /** Unit normal pointing from the track pair towards the label side (outer side, ob track side). */
  outward: Vec2
  /** 3 = terminal, 2 = interchange, 1 = regular. */
  priority: 1 | 2 | 3
  terminal: boolean
  /** Connecting lines shown as roundels next to the name ('2', '4', 'GO'). */
  connections: string[]
}

export interface LayoutMeta {
  kind: LayoutKind
  /** Distance between the two track centre lines, world units. */
  trackSep: number
  stations: StationMeta[]
}

const STORE = new WeakMap<Topology, LayoutMeta>()

export function setLayoutMeta(topology: Topology, meta: LayoutMeta): void {
  STORE.set(topology, meta)
}

/** Normalised station name for lookups: 'Bloor–Yonge' → 'blooryonge'. */
export function nameKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')
}

/** Line 1 interchanges (subtly distinguished on the map). */
export const INTERCHANGES: Record<string, string[]> = {
  stgeorge: ['2'],
  blooryonge: ['2'],
  spadina: ['2'],
  sheppardyonge: ['4'],
  union: ['GO'],
}

const STATION_ID = /^(ob|ib)_(\d+)$/

export interface StationPairs {
  n: number
  ob: TopologyNode[]
  ib: TopologyNode[]
  names: string[]
}

/** ob_<i>/ib_<i> station node pairs, or null if the topology doesn't follow that convention. */
export function stationPairs(topology: Topology): StationPairs | null {
  const ob: TopologyNode[] = []
  const ib: TopologyNode[] = []
  for (const node of topology.nodes) {
    const m = STATION_ID.exec(node.id)
    if (!m) continue
    const i = Number(m[2])
    if (m[1] === 'ob') ob[i] = node
    else ib[i] = node
  }
  const n = ob.length
  if (n < 2 || ib.length !== n) return null
  for (let i = 0; i < n; i++) if (!ob[i] || !ib[i]) return null
  return { n, ob, ib, names: ob.map((o, i) => o.label || ib[i].label || `Stop ${i}`) }
}

function norm(v: Vec2): Vec2 {
  const L = Math.hypot(v.x, v.y)
  return L > 1e-9 ? { x: v.x / L, y: v.y / L } : { x: 1, y: 0 }
}

export function stationPriority(index: number, n: number, name: string): { priority: 1 | 2 | 3; terminal: boolean; connections: string[] } {
  const terminal = index === 0 || index === n - 1
  const connections = INTERCHANGES[nameKey(name)] ?? []
  return { priority: terminal ? 3 : connections.length ? 2 : 1, terminal, connections }
}

function deriveMeta(topology: Topology): LayoutMeta {
  const pairs = stationPairs(topology)
  if (!pairs) return { kind: 'geographic', trackSep: 10, stations: [] }
  const { n, ob, ib, names } = pairs
  const seps: number[] = []
  const stations: StationMeta[] = []
  for (let i = 0; i < n; i++) {
    const o = ob[i]
    const b = ib[i]
    seps.push(Math.hypot(o.x - b.x, o.y - b.y))
    const prev = ob[Math.max(0, i - 1)]
    const next = ob[Math.min(n - 1, i + 1)]
    const along = norm({ x: next.x - prev.x, y: next.y - prev.y })
    let outward = norm({ x: o.x - b.x, y: o.y - b.y })
    if (Math.hypot(o.x - b.x, o.y - b.y) < 1e-6) outward = { x: -along.y, y: along.x }
    stations.push({
      index: i,
      name: names[i],
      center: { x: (o.x + b.x) / 2, y: (o.y + b.y) / 2 },
      along,
      outward,
      ...stationPriority(i, n, names[i]),
    })
  }
  seps.sort((a, b) => a - b)
  return { kind: 'geographic', trackSep: seps[Math.floor(seps.length / 2)] || 10, stations }
}

export function getLayoutMeta(topology: Topology): LayoutMeta {
  let meta = STORE.get(topology)
  if (!meta) {
    meta = deriveMeta(topology)
    STORE.set(topology, meta)
  }
  return meta
}
