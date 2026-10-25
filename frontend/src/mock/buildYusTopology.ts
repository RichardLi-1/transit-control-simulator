/**
 * Mirrors backend/topology.py (contract v2) — same projection, edges, switches, train route,
 * real-metre edge lengths, route segments, platforms, civil speed restrictions, yards and
 * interlocking-only signals. Simplified where exact parity doesn't matter for a UI mock
 * (signal siting uses fixed distances instead of the backend's approach-speed iteration).
 */
import type {
  SpeedRestriction,
  StationPlatform,
  Topology,
  TopologyEdge,
  TopologyNode,
  TopologySignal,
  TopologyStation,
  TopologyYard,
} from '../types/domain'
import yusRaw from '../../../backend/data/yus_topology.json'

const TRACK_SEP = 56
const PAD = 200
export const MID_XOVER_STOPS = [6, 11, 14, 27, 32, 35]
const MID_XOVER_T = 0.3
const REAL_LINE_LENGTH_M = 38_400
const TERMINAL_XOVER_M = 60
const MID_XOVER_M = 75
export const TRAIN_LEN_M = 138
const HALF_TRAIN_M = TRAIN_LEN_M / 2
const TERMINAL_ARRIVAL_SHORT_M = 15
const TERMINAL_DEP_STOP_M = 150

const STATION_CODES: Record<string, string> = {
  'Vaughan MC': 'VMC', 'Highway 407': 'HWY', 'Pioneer Village': 'PIO', 'York University': 'YKU',
  'Finch West': 'FWS', 'Downsview Park': 'DVP', 'Sheppard West': 'SHW', Wilson: 'WIL',
  Yorkdale: 'YKD', 'Lawrence West': 'LWS', Glencairn: 'GLN', 'Eglinton West': 'EGW',
  'St Clair West': 'SCW', Dupont: 'DUP', Spadina: 'SPA', 'St George': 'STG',
  Museum: 'MUS', "Queen's Park": 'QPK', 'St Patrick': 'STP', Osgoode: 'OSG',
  'St Andrew': 'STA', Union: 'UNI', King: 'KNG', Queen: 'QUN', Dundas: 'DUN',
  College: 'COL', Wellesley: 'WEL', 'Bloor–Yonge': 'BLY', Rosedale: 'ROS',
  Summerhill: 'SUM', 'St Clair': 'STC', Davisville: 'DAV', Eglinton: 'EGL',
  Lawrence: 'LAW', 'York Mills': 'YKM', 'Sheppard–Yonge': 'SHY', 'North York Ctr': 'NYC',
  Finch: 'FIN',
}

interface Stop {
  name: string
  coords: [number, number]
}

/** A stopping point in ring order (what the mock sim stops at). */
export interface MockPlatform {
  name: string
  stopIndex: number
  leg: 'ob' | 'ib'
  nodeId: string
  chainage: number
  role: 'through' | 'arrival' | 'departure'
  terminal: boolean
  /** terminal the train heads to after this stop */
  destination: string
}

export interface MockYusModel {
  topology: Topology
  trainRoute: string[]
  routeLength: number
  segStart: Record<string, number>
  segLen: Record<string, number>
  platforms: MockPlatform[]
  restrictions: SpeedRestriction[]
  stopNames: string[]
}

function pxLen(ax: number, ay: number, bx: number, by: number): number {
  return Math.round(Math.hypot(bx - ax, by - ay) * 100) / 100 || 1
}

function haversine(a: [number, number], b: [number, number]): number {
  const r = 6_371_008.8
  const rad = Math.PI / 180
  const [lo1, la1, lo2, la2] = [a[0] * rad, a[1] * rad, b[0] * rad, b[1] * rad]
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}

/** Real metres between consecutive stops along the GTFS shape, scaled to 38.4 km (as backend). */
function interstationMetres(stops: Stop[], shape: [number, number][]): number[] {
  const idx = stops.map((s) => {
    let best = 0
    let bd = Infinity
    for (let k = 0; k < shape.length; k++) {
      const d = haversine(shape[k], s.coords)
      if (d < bd) { bd = d; best = k }
    }
    return best
  })
  const raw: number[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    const a = idx[i]
    const b = idx[i + 1]
    if (b > a) {
      let sum = 0
      for (let k = a; k < b; k++) sum += haversine(shape[k], shape[k + 1])
      raw.push(sum)
    } else {
      raw.push(haversine(stops[i].coords, stops[i + 1].coords))
    }
  }
  const factor = REAL_LINE_LENGTH_M / raw.reduce((s, d) => s + d, 0)
  return raw.map((d) => Math.round(d * factor * 10) / 10)
}

let _cached: MockYusModel | null = null

export function buildYusModel(): MockYusModel {
  if (_cached) return _cached
  const line = (yusRaw as unknown as { line: { stops: Stop[]; shape?: [number, number][] } }).line
  const stops = line.stops
  const shape = line.shape && line.shape.length > 1 ? line.shape : stops.map((s) => s.coords)
  const n = stops.length
  const segM = interstationMetres(stops, shape)
  const stopNames = stops.map((s) => s.name)

  const lons = stops.map((s) => s.coords[0])
  const lats = stops.map((s) => s.coords[1])
  const lonMin = Math.min(...lons)
  const lonMax = Math.max(...lons)
  const latMin = Math.min(...lats)
  const latMax = Math.max(...lats)
  const cosLat = Math.cos((((latMin + latMax) / 2) * Math.PI) / 180)
  const xSpan = (lonMax - lonMin) * cosLat
  const ySpan = latMax - latMin
  const scale = Math.min(6000 / xSpan, 5000 / ySpan)

  const proj = (lon: number, lat: number): [number, number] => [
    Math.round((PAD + (lon - lonMin) * cosLat * scale) * 10) / 10,
    Math.round((PAD + (latMax - lat) * scale) * 10) / 10,
  ]

  const pts = stops.map((s) => proj(s.coords[0], s.coords[1]))

  const perp = (i: number): [number, number] => {
    const a = pts[Math.max(i - 1, 0)]
    const b = pts[Math.min(i + 1, n - 1)]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const L = Math.hypot(dx, dy) || 1
    return [(-dy / L) * TRACK_SEP / 2, (dx / L) * TRACK_SEP / 2]
  }

  const nodes: Record<string, TopologyNode> = {}
  for (let i = 0; i < n; i++) {
    const [ox, oy] = perp(i)
    const [x, y] = pts[i]
    const label = stops[i].name
    nodes[`ob_${i}`] = { id: `ob_${i}`, x: x + ox, y: y + oy, label, is_station: true }
    nodes[`ib_${i}`] = { id: `ib_${i}`, x: x - ox, y: y - oy, label, is_station: true }
  }
  const nd = (nid: string) => nodes[nid]

  const obEdges: TopologyEdge[] = []
  const ibEdges: TopologyEdge[] = []
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1
    let a = nd(`ob_${i}`)
    let b = nd(`ob_${j}`)
    obEdges.push({
      id: `ob_${i}_${j}`, from_node: `ob_${i}`, to_node: `ob_${j}`, block_id: `OB_B${i + 1}`,
      points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      length: pxLen(a.x, a.y, b.x, b.y), length_m: segM[i],
    })
    a = nd(`ib_${j}`)
    b = nd(`ib_${i}`)
    ibEdges.push({
      id: `ib_${j}_${i}`, from_node: `ib_${j}`, to_node: `ib_${i}`, block_id: `IB_B${j}`,
      points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      length: pxLen(a.x, a.y, b.x, b.y), length_m: segM[i],
    })
  }

  const xover = (eid: string, fn: string, tn: string): TopologyEdge => {
    const a = nd(fn)
    const b = nd(tn)
    return {
      id: eid, from_node: fn, to_node: tn, block_id: `XOVER_${eid.toUpperCase()}`,
      points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
      length: Math.max(pxLen(a.x, a.y, b.x, b.y), 10), length_m: TERMINAL_XOVER_M,
    }
  }
  const xoverMid = (idx: number): TopologyEdge => {
    const a = nd(`ob_${idx}`)
    const b = nd(`ib_${idx}`)
    const an = nodes[`ob_${idx + 1}`] ?? a
    const bn = nodes[`ib_${idx + 1}`] ?? b
    const ax = a.x + (an.x - a.x) * MID_XOVER_T
    const ay = a.y + (an.y - a.y) * MID_XOVER_T
    const bx = b.x + (bn.x - b.x) * MID_XOVER_T
    const by = b.y + (bn.y - b.y) * MID_XOVER_T
    return {
      id: `xover_mid_${idx}`, from_node: `ob_${idx}`, to_node: `ib_${idx}`, block_id: `XOVER_XOVER_MID_${idx}`,
      points: [{ x: ax, y: ay }, { x: bx, y: by }],
      length: Math.max(pxLen(ax, ay, bx, by), 10), length_m: MID_XOVER_M,
    }
  }
  const midStops = MID_XOVER_STOPS.filter((idx) => idx > 0 && idx < n - 1)
  const xovers = [xover('xover_start', 'ib_0', 'ob_0'), xover('xover_end', `ob_${n - 1}`, `ib_${n - 1}`), ...midStops.map(xoverMid)]
  const allEdges = [...obEdges, ...ibEdges, ...xovers]
  const edgeById = new Map(allEdges.map((e) => [e.id, e]))

  const trainRoute = [
    ...Array.from({ length: n - 1 }, (_, i) => `ob_${i}_${i + 1}`),
    'xover_end',
    ...Array.from({ length: n - 1 }, (_, k) => `ib_${n - 1 - k}_${n - 2 - k}`),
    'xover_start',
  ]
  const segStart: Record<string, number> = {}
  const segLen: Record<string, number> = {}
  let acc = 0
  for (const eid of trainRoute) {
    const len = edgeById.get(eid)!.length_m!
    segStart[eid] = acc
    segLen[eid] = len
    acc += len
  }
  const L = acc
  const wrap = (c: number) => ((c % L) + L) % L

  // ── Platforms (nose stopping points, ring order) ──
  const fin = stopNames[n - 1]
  const vmc = stopNames[0]
  const platforms: MockPlatform[] = []
  platforms.push({ name: vmc, stopIndex: 0, leg: 'ob', nodeId: 'ob_0', chainage: segStart.ob_0_1 + TERMINAL_DEP_STOP_M, role: 'departure', terminal: true, destination: fin })
  for (let i = 1; i < n - 1; i++) {
    platforms.push({ name: stopNames[i], stopIndex: i, leg: 'ob', nodeId: `ob_${i}`, chainage: segStart[`ob_${i}_${i + 1}`] + HALF_TRAIN_M, role: 'through', terminal: false, destination: fin })
  }
  platforms.push({ name: fin, stopIndex: n - 1, leg: 'ob', nodeId: `ob_${n - 1}`, chainage: segStart.xover_end - TERMINAL_ARRIVAL_SHORT_M, role: 'arrival', terminal: true, destination: fin })
  platforms.push({ name: fin, stopIndex: n - 1, leg: 'ib', nodeId: `ib_${n - 1}`, chainage: segStart[`ib_${n - 1}_${n - 2}`] + TERMINAL_DEP_STOP_M, role: 'departure', terminal: true, destination: vmc })
  for (let j = n - 2; j > 0; j--) {
    platforms.push({ name: stopNames[j], stopIndex: j, leg: 'ib', nodeId: `ib_${j}`, chainage: segStart[`ib_${j}_${j - 1}`] + HALF_TRAIN_M, role: 'through', terminal: false, destination: vmc })
  }
  platforms.push({ name: vmc, stopIndex: 0, leg: 'ib', nodeId: 'ib_0', chainage: segStart.xover_start - TERMINAL_ARRIVAL_SHORT_M, role: 'arrival', terminal: true, destination: vmc })
  const plat = (name: string, leg: 'ob' | 'ib', role?: string) =>
    platforms.find((p) => p.name === name && p.leg === leg && (!role || p.role === role))!

  // ── Civil speed restrictions (APPROX, as backend) ──
  const rs: [number, number, number, string][] = []
  for (const x of ['xover_end', 'xover_start']) {
    rs.push([segStart[x] - 5, segStart[x] + segLen[x] + 5, 25, `terminal crossover (${x === 'xover_end' ? 'Finch' : 'Vaughan MC'})`])
  }
  const finArr = plat(fin, 'ob', 'arrival').chainage
  const vmcArr = plat(vmc, 'ib', 'arrival').chainage
  rs.push([finArr - 420, finArr, 45, 'Finch terminal approach'])
  rs.push([vmcArr - 420, vmcArr, 45, 'Vaughan MC terminal approach'])
  const ob = (s: string) => plat(s, 'ob').chainage
  const ib = (s: string) => plat(s, 'ib').chainage
  rs.push([ob('St Andrew') + 40, ob('King') - TRAIN_LEN_M - 40, 35, 'Union loop curves'])
  rs.push([ib('King') + 40, ib('St Andrew') - TRAIN_LEN_M - 40, 35, 'Union loop curves'])
  rs.push([ob('Spadina') + 60, ob('St George') - TRAIN_LEN_M - 30, 45, 'Spadina–St George curve'])
  rs.push([ib('St George') + 60, ib('Spadina') - TRAIN_LEN_M - 30, 45, 'St George–Spadina curve'])
  rs.push([ob('St George') + 50, ob('Museum') - TRAIN_LEN_M - 40, 40, 'Museum curve'])
  rs.push([ib('Museum') + 50, ib('St George') - TRAIN_LEN_M - 40, 40, 'Museum curve'])
  const restrictions: SpeedRestriction[] = []
  for (const [a0, b0, lim, why] of rs) {
    const a = wrap(a0)
    const b = wrap(b0)
    if (b > a) restrictions.push({ start_m: r2(a), end_m: r2(b), limit_kph: lim, reason: why })
    else {
      restrictions.push({ start_m: r2(a), end_m: r2(L), limit_kph: lim, reason: why })
      if (b > 0) restrictions.push({ start_m: 0, end_m: r2(b), limit_kph: lim, reason: why })
    }
  }
  restrictions.sort((p, q) => p.start_m - q.start_m)

  // ── Yards ──
  const yards: TopologyYard[] = [
    { name: 'Wilson Yard', chainage_m: r2(plat('Wilson', 'ob').chainage - HALF_TRAIN_M - 380), leg: 'ob' },
    { name: 'Davisville Yard', chainage_m: r2(plat('Davisville', 'ib').chainage - HALF_TRAIN_M - 260), leg: 'ib' },
  ]

  // ── Interlocking-only signals (simplified siting) ──
  const chToEdge = (c: number): { eid: string; t: number } => {
    const cc = wrap(c)
    let eid = trainRoute[0]
    for (const id of trainRoute) {
      if (segStart[id] <= cc) eid = id
      else break
    }
    return { eid, t: Math.min(1, Math.max(0, (cc - segStart[eid]) / segLen[eid])) }
  }
  const specs: { code: string; leg: 'ob' | 'ib'; kind: string; c: number; interlocking: string }[] = []
  for (const [term, arrLeg] of [[fin, 'ob'], [vmc, 'ib']] as const) {
    const code = STATION_CODES[term]
    const arr = plat(term, arrLeg, 'arrival')
    const dep = plat(term, arrLeg === 'ob' ? 'ib' : 'ob', 'departure')
    specs.push({ code, leg: arrLeg, kind: 'home', c: arr.chainage - TRAIN_LEN_M - 5 - 160, interlocking: term })
    specs.push({ code, leg: arrLeg, kind: 'starter', c: arr.chainage + 11, interlocking: term })
    specs.push({ code, leg: dep.leg, kind: 'starter', c: dep.chainage + 10, interlocking: term })
  }
  for (const idx of midStops) {
    const name = stopNames[idx]
    const code = STATION_CODES[name] ?? name.slice(0, 3).toUpperCase()
    const pOb = segStart[`ob_${idx}_${idx + 1}`] + MID_XOVER_T * segLen[`ob_${idx}_${idx + 1}`]
    const pIb = segStart[`ib_${idx + 1}_${idx}`] + (1 - MID_XOVER_T) * segLen[`ib_${idx + 1}_${idx}`]
    specs.push({ code, leg: 'ob', kind: 'home', c: pOb - MID_XOVER_M / 2 - 150, interlocking: name })
    specs.push({ code, leg: 'ib', kind: 'home', c: pIb - MID_XOVER_M / 2 - 150, interlocking: name })
  }
  for (const y of yards) {
    const code = y.name.startsWith('Wilson') ? 'WYD' : 'DYD'
    specs.push({ code, leg: y.leg ?? 'ob', kind: 'home', c: y.chainage_m - 20 - 120, interlocking: y.name })
  }
  const counters: Record<string, number> = {}
  const signals: TopologySignal[] = specs
    .map((s) => ({ ...s, c: wrap(s.c) }))
    .sort((a, b) => a.c - b.c)
    .map((s) => {
      const key = `${s.code}:${s.leg}`
      const num = (s.leg === 'ob' ? 1 : 2) + 2 * (counters[key] ?? 0)
      counters[key] = (counters[key] ?? 0) + 1
      const { eid, t } = chToEdge(s.c)
      const e = edgeById.get(eid)!
      const p0 = e.points[0]
      const p1 = e.points[e.points.length - 1]
      return {
        id: `sig_${s.code}_${num}`,
        name: `${s.code} ${num}`,
        edge_id: eid,
        offset: Math.round(t * 1e5) / 1e5,
        position: { x: p0.x + t * (p1.x - p0.x), y: p0.y + t * (p1.y - p0.y) },
        aspect: 'red' as const,
        block_id: e.block_id,
        chainage_m: r2(s.c),
        kind: s.kind,
        leg: s.leg,
        interlocking: s.interlocking,
      }
    })

  const stations: TopologyStation[] = stopNames.map((name, i) => ({
    name,
    code: STATION_CODES[name] ?? name.slice(0, 3).toUpperCase(),
    stop_index: i,
    platforms: platforms
      .map((p, k) => ({ p, k }))
      .filter(({ p }) => p.stopIndex === i)
      .map(({ p, k }): StationPlatform => ({ leg: p.leg, node_id: p.nodeId, chainage_m: r2(p.chainage), role: p.role, ring_index: k })),
  }))

  const xs = Object.values(nodes).map((v) => v.x)
  const ys = Object.values(nodes).map((v) => v.y)
  const bounds = {
    min_x: Math.min(...xs) - PAD,
    min_y: Math.min(...ys) - PAD,
    max_x: Math.max(...xs) + PAD,
    max_y: Math.max(...ys) + PAD,
  }

  const switches = [
    { id: 'sw_start', node_id: 'ob_0', normal_edge_id: 'ob_0_1', reverse_edge_id: 'xover_start', state: 'normal' as const },
    { id: 'sw_end', node_id: `ob_${n - 1}`, normal_edge_id: `ob_${n - 2}_${n - 1}`, reverse_edge_id: 'xover_end', state: 'normal' as const },
    ...midStops.map((idx) => ({
      id: `sw_mid_${idx}`, node_id: `ob_${idx}`, normal_edge_id: `ob_${idx}_${idx + 1}`, reverse_edge_id: `xover_mid_${idx}`, state: 'normal' as const,
    })),
  ]
  const crossovers = [
    { id: 'xov_start', edge1_id: 'ob_0_1', edge2_id: 'ib_1_0', node_id: 'ob_0' },
    { id: 'xov_end', edge1_id: `ob_${n - 2}_${n - 1}`, edge2_id: `ib_${n - 1}_${n - 2}`, node_id: `ob_${n - 1}` },
    ...midStops.map((idx) => ({ id: `xov_mid_${idx}`, edge1_id: `ob_${idx}_${idx + 1}`, edge2_id: `ib_${idx + 1}_${idx}`, node_id: `ob_${idx}` })),
  ]

  const topology: Topology = {
    nodes: Object.values(nodes),
    edges: allEdges,
    switches,
    crossovers,
    signals,
    bounds,
    route: {
      length_m: r2(L),
      segments: trainRoute.map((eid) => ({ edge_id: eid, start_m: r2(segStart[eid]), length_m: r2(segLen[eid]) })),
    },
    stations,
    speed_restrictions: restrictions,
    yards,
  }

  _cached = { topology, trainRoute, routeLength: L, segStart, segLen, platforms, restrictions, stopNames }
  return _cached
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Back-compat entry point. */
export function buildYusTopology(): { topology: Topology; trainRoute: string[] } {
  const m = buildYusModel()
  return { topology: m.topology, trainRoute: m.trainRoute }
}
