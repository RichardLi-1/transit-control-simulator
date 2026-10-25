"""Static Line 1 topology: drawing geometry (pixels) + real track geometry (metres).

Two coordinate systems live side by side:

* ``points`` / ``length`` on every edge are canvas pixels (equirectangular projection
  squeezed into ~6000x5000 px).  They exist only for drawing and are unchanged from v1.
* ``length_m`` on every edge, and every ``chainage_m`` in this document, are REAL track
  metres.  ALL simulation physics runs on metres.

Chainage model (see the shared contract): the revenue route is a ring
``ob_0_1 … ob_36_37, xover_end, ib_37_36 … ib_1_0, xover_start``; chainage 0 is the start of
``ob_0_1`` (Vaughan MC, departing towards Finch).

Everything below marked APPROX is an engineering approximation for a simulator, not TTC data.
"""

from __future__ import annotations

import json
import math
from bisect import bisect_right
from pathlib import Path

_DATA_DIR = Path(__file__).resolve().parent / "data"
_TRACK_SEP = 56   # pixels between outbound and inbound tracks
_PAD = 200        # canvas padding

# ── Real-geometry constants (APPROX) ─────────────────────────────────────────
# Published Line 1 length, Vaughan MC → Finch.  The GTFS-derived ``shape`` straight-lines
# between waypoints (36.9 km), so we apply one uniform curvature allowance so the total
# matches the published figure.  Per-edge lengths keep the relative shape distances.
REAL_LINE_LENGTH_M = 38_400.0
TERMINAL_XOVER_M = 60.0          # terminal crossover move (diamond), each terminal
MID_XOVER_M = 75.0               # single crossover between the running tracks (not on route)
TRAIN_LEN_M = 138.0              # Toronto Rocket, 6 cars
HALF_TRAIN_M = TRAIN_LEN_M / 2.0
TERMINAL_ARRIVAL_SHORT_M = 15.0  # arrival stop: nose this far short of the crossover start
TERMINAL_DEP_STOP_M = 150.0      # departure stop: nose this far along the departure track
LINE_SPEED_KPH = 80.0

# Mid-line crossovers at Line 1 pocket/crossover locations (stop indices).
# 6=Sheppard West, 11=Eglinton West, 14=Spadina, 27=Bloor-Yonge, 32=Eglinton, 35=Sheppard-Yonge
MID_XOVER_STOPS = [6, 11, 14, 27, 32, 35]
MID_XOVER_T = 0.30               # crossover sits 30 % of the way towards the next station
# Which running track meets each single crossover's points FACING (APPROX — orientation is
# not in our data; chosen per location).  The other track meets them trailing.
MID_XOVER_FACING = {6: 'ob', 11: 'ob', 14: 'ib', 27: 'ob', 32: 'ib', 35: 'ob'}

STATION_CODES = {
    "Vaughan MC": "VMC", "Highway 407": "HWY", "Pioneer Village": "PIO", "York University": "YKU",
    "Finch West": "FWS", "Downsview Park": "DVP", "Sheppard West": "SHW", "Wilson": "WIL",
    "Yorkdale": "YKD", "Lawrence West": "LWS", "Glencairn": "GLN", "Eglinton West": "EGW",
    "St Clair West": "SCW", "Dupont": "DUP", "Spadina": "SPA", "St George": "STG",
    "Museum": "MUS", "Queen's Park": "QPK", "St Patrick": "STP", "Osgoode": "OSG",
    "St Andrew": "STA", "Union": "UNI", "King": "KNG", "Queen": "QUN", "Dundas": "DUN",
    "College": "COL", "Wellesley": "WEL", "Bloor–Yonge": "BLY", "Rosedale": "ROS",
    "Summerhill": "SUM", "St Clair": "STC", "Davisville": "DAV", "Eglinton": "EGL",
    "Lawrence": "LAW", "York Mills": "YKM", "Sheppard–Yonge": "SHY", "North York Ctr": "NYC",
    "Finch": "FIN",
}


def _haversine_m(a: list[float], b: list[float]) -> float:
    r = 6_371_008.8
    lo1, la1, lo2, la2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _interstation_metres(stops: list[dict], shape: list[list[float]]) -> tuple[list[float], float]:
    """Real metres between consecutive stops, measured along the GTFS shape, scaled to 38.4 km."""
    idx = []
    for s in stops:
        idx.append(min(range(len(shape)), key=lambda k: _haversine_m(shape[k], s["coords"])))
    raw = []
    for i in range(len(stops) - 1):
        a, b = idx[i], idx[i + 1]
        if b > a:
            raw.append(sum(_haversine_m(shape[k], shape[k + 1]) for k in range(a, b)))
        else:  # shape doesn't bracket the stops — fall back to straight line
            raw.append(_haversine_m(stops[i]["coords"], stops[i + 1]["coords"]))
    factor = REAL_LINE_LENGTH_M / sum(raw)
    return [round(d * factor, 1) for d in raw], factor


def _build_yus() -> tuple[dict, list[str]]:
    raw = json.loads((_DATA_DIR / "yus_topology.json").read_text(encoding="utf-8"))
    stops = raw["line"]["stops"]   # [{name, coords:[lon,lat]}, ...]
    shape = raw["line"].get("shape") or [s["coords"] for s in stops]
    n = len(stops)
    seg_m, curve_factor = _interstation_metres(stops, shape)

    # ── project lon/lat → canvas pixels (equirectangular, aspect-correct) ──
    lons = [s["coords"][0] for s in stops]
    lats = [s["coords"][1] for s in stops]
    lon_min, lon_max = min(lons), max(lons)
    lat_min, lat_max = min(lats), max(lats)
    cos_lat = math.cos(math.radians((lat_min + lat_max) / 2))
    x_span = (lon_max - lon_min) * cos_lat
    y_span = lat_max - lat_min
    scale = min(6000 / x_span, 5000 / y_span)

    def proj(lon: float, lat: float) -> tuple[float, float]:
        return (
            round(_PAD + (lon - lon_min) * cos_lat * scale, 1),
            round(_PAD + (lat_max - lat) * scale, 1),
        )

    pts = [proj(s["coords"][0], s["coords"][1]) for s in stops]

    def _perp(i: int) -> tuple[float, float]:
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, n - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1
        return -dy / L * _TRACK_SEP / 2, dx / L * _TRACK_SEP / 2

    offsets = [_perp(i) for i in range(n)]

    nodes: dict[str, dict] = {}
    for i, s in enumerate(stops):
        ox, oy = offsets[i]
        x, y = pts[i]
        nodes[f'ob_{i}'] = {'id': f'ob_{i}', 'x': x + ox, 'y': y + oy, 'label': s['name'], 'is_station': True}
        nodes[f'ib_{i}'] = {'id': f'ib_{i}', 'x': x - ox, 'y': y - oy, 'label': s['name'], 'is_station': True}

    def nd(nid: str) -> dict:
        return nodes[nid]

    def _px_len(ax, ay, bx, by) -> float:
        return round(math.hypot(bx - ax, by - ay), 2) or 1.0

    ob_edges, ib_edges = [], []
    for i in range(n - 1):
        j = i + 1
        a, b = nd(f'ob_{i}'), nd(f'ob_{j}')
        ob_edges.append({
            'id': f'ob_{i}_{j}', 'from_node': f'ob_{i}', 'to_node': f'ob_{j}',
            'block_id': f'OB_B{i + 1}',
            'points': [{'x': a['x'], 'y': a['y']}, {'x': b['x'], 'y': b['y']}],
            'length': _px_len(a['x'], a['y'], b['x'], b['y']),
            'length_m': seg_m[i],
        })
        a, b = nd(f'ib_{j}'), nd(f'ib_{i}')
        ib_edges.append({
            'id': f'ib_{j}_{i}', 'from_node': f'ib_{j}', 'to_node': f'ib_{i}',
            'block_id': f'IB_B{j}',
            'points': [{'x': a['x'], 'y': a['y']}, {'x': b['x'], 'y': b['y']}],
            'length': _px_len(a['x'], a['y'], b['x'], b['y']),
            'length_m': seg_m[i],
        })

    def _xover(eid, fn, tn) -> dict:
        a, b = nd(fn), nd(tn)
        return {
            'id': eid, 'from_node': fn, 'to_node': tn, 'block_id': f'XOVER_{eid.upper()}',
            'points': [{'x': a['x'], 'y': a['y']}, {'x': b['x'], 'y': b['y']}],
            'length': max(_px_len(a['x'], a['y'], b['x'], b['y']), 10.0),
            'length_m': TERMINAL_XOVER_M,
        }

    # Mid-line crossover: drawn MID_XOVER_T of the way towards the next station so the X glyph
    # sits between two stations.  Chainage of its points uses the same fraction.
    def _xover_offset(eid, fn, tn, t: float = MID_XOVER_T) -> dict:
        a, b = nd(fn), nd(tn)
        fn_idx = int(fn.split('_')[1])
        tn_idx = int(tn.split('_')[1])
        ob_next = nodes.get(f'ob_{fn_idx + 1}', a)
        ib_next = nodes.get(f'ib_{tn_idx + 1}', b)
        ax = a['x'] + (ob_next['x'] - a['x']) * t
        ay = a['y'] + (ob_next['y'] - a['y']) * t
        bx = b['x'] + (ib_next['x'] - b['x']) * t
        by = b['y'] + (ib_next['y'] - b['y']) * t
        return {
            'id': eid, 'from_node': fn, 'to_node': tn, 'block_id': f'XOVER_{eid.upper()}',
            'points': [{'x': ax, 'y': ay}, {'x': bx, 'y': by}],
            'length': max(_px_len(ax, ay, bx, by), 10.0),
            'length_m': MID_XOVER_M,
        }

    xovers = [
        _xover('xover_start', 'ib_0', 'ob_0'),
        _xover('xover_end', f'ob_{n-1}', f'ib_{n-1}'),
    ]
    mid_xovers = [_xover_offset(f'xover_mid_{idx}', f'ob_{idx}', f'ib_{idx}')
                  for idx in MID_XOVER_STOPS if 0 < idx < n - 1]
    all_edges = ob_edges + ib_edges + xovers + mid_xovers

    xs = [v['x'] for v in nodes.values()]
    ys = [v['y'] for v in nodes.values()]
    bounds = {'min_x': min(xs) - _PAD, 'min_y': min(ys) - _PAD,
              'max_x': max(xs) + _PAD, 'max_y': max(ys) + _PAD}

    train_route = (
        [f'ob_{i}_{i+1}' for i in range(n - 1)] +
        ['xover_end'] +
        [f'ib_{j}_{j-1}' for j in range(n - 1, 0, -1)] +
        ['xover_start']
    )

    switches = [
        {'id': 'sw_start', 'node_id': 'ob_0', 'normal_edge_id': 'ob_0_1', 'reverse_edge_id': 'xover_start', 'state': 'normal'},
        {'id': 'sw_end', 'node_id': f'ob_{n-1}', 'normal_edge_id': f'ob_{n-2}_{n-1}', 'reverse_edge_id': 'xover_end', 'state': 'normal'},
    ]
    for idx in MID_XOVER_STOPS:
        if 0 < idx < n - 1:
            switches.append({'id': f'sw_mid_{idx}', 'node_id': f'ob_{idx}',
                             'normal_edge_id': f'ob_{idx}_{idx+1}',
                             'reverse_edge_id': f'xover_mid_{idx}', 'state': 'normal'})

    crossovers = [
        {'id': 'xov_start', 'edge1_id': 'ob_0_1', 'edge2_id': 'ib_1_0', 'node_id': 'ob_0'},
        {'id': 'xov_end', 'edge1_id': f'ob_{n-2}_{n-1}', 'edge2_id': f'ib_{n-1}_{n-2}', 'node_id': f'ob_{n-1}'},
        *[{'id': f'xov_mid_{idx}', 'edge1_id': f'ob_{idx}_{idx+1}',
           'edge2_id': f'ib_{idx+1}_{idx}', 'node_id': f'ob_{idx}'}
          for idx in MID_XOVER_STOPS if 0 < idx < n - 1]
    ]

    topology = {
        'nodes': list(nodes.values()),
        'edges': all_edges,
        'switches': switches,
        'crossovers': crossovers,
        'signals': [],
        'bounds': bounds,
        'meta': {
            'units': 'edge.length = canvas px (drawing only); *_m = real metres',
            'curvature_allowance': round(curve_factor, 4),
            'real_line_length_m': REAL_LINE_LENGTH_M,
        },
    }
    return topology, train_route, [s['name'] for s in stops]


YUS_TOPOLOGY, YUS_TRAIN_ROUTE, STOP_NAMES = _build_yus()
N_STOPS = len(STOP_NAMES)
EDGES: dict[str, dict] = {e['id']: e for e in YUS_TOPOLOGY['edges']}

# ── Route segments (real metres) ─────────────────────────────────────────────
ROUTE_SEGMENTS_M: list[tuple[str, float, float]] = []   # (edge_id, start_m, length_m)
_acc = 0.0
for _eid in YUS_TRAIN_ROUTE:
    _len = float(EDGES[_eid]['length_m'])
    ROUTE_SEGMENTS_M.append((_eid, _acc, _len))
    _acc += _len
ROUTE_LENGTH_M: float = _acc
SEG_START: dict[str, float] = {eid: s for eid, s, _ in ROUTE_SEGMENTS_M}
SEG_LEN: dict[str, float] = {eid: l for eid, _, l in ROUTE_SEGMENTS_M}
_SEG_STARTS_LIST = [s for _, s, _ in ROUTE_SEGMENTS_M]


def _wrap(c: float) -> float:
    return c % ROUTE_LENGTH_M


def chainage_to_edge_m(c: float) -> tuple[str, float]:
    """(edge_id, fraction along edge) for a route chainage in metres."""
    c = _wrap(c)
    i = bisect_right(_SEG_STARTS_LIST, c) - 1
    eid, start, length = ROUTE_SEGMENTS_M[max(i, 0)]
    return eid, min(1.0, max(0.0, (c - start) / length))


def _edge_point(eid: str, t: float) -> dict:
    p = EDGES[eid]['points']
    a, b = p[0], p[-1]
    return {'x': round(a['x'] + t * (b['x'] - a['x']), 2), 'y': round(a['y'] + t * (b['y'] - a['y']), 2)}


# ── Platforms (stopping points of the train NOSE), in ring order ─────────────
def _build_platforms() -> list[dict]:
    n = N_STOPS
    out: list[dict] = []
    # Vaughan MC departure platform (ob track): train has crossed over and faces Finch.
    out.append({'name': STOP_NAMES[0], 'stop_index': 0, 'leg': 'ob', 'node_id': 'ob_0',
                'chainage_m': round(SEG_START['ob_0_1'] + TERMINAL_DEP_STOP_M, 2),
                'role': 'departure', 'terminal': True, 'destination': STOP_NAMES[n - 1]})
    for i in range(1, n - 1):
        # Intermediate stations: train centred on the station node.
        out.append({'name': STOP_NAMES[i], 'stop_index': i, 'leg': 'ob', 'node_id': f'ob_{i}',
                    'chainage_m': round(SEG_START[f'ob_{i}_{i+1}'] + HALF_TRAIN_M, 2),
                    'role': 'through', 'terminal': False, 'destination': STOP_NAMES[n - 1]})
    out.append({'name': STOP_NAMES[n - 1], 'stop_index': n - 1, 'leg': 'ob', 'node_id': f'ob_{n-1}',
                'chainage_m': round(SEG_START['xover_end'] - TERMINAL_ARRIVAL_SHORT_M, 2),
                'role': 'arrival', 'terminal': True, 'destination': STOP_NAMES[n - 1]})
    out.append({'name': STOP_NAMES[n - 1], 'stop_index': n - 1, 'leg': 'ib', 'node_id': f'ib_{n-1}',
                'chainage_m': round(SEG_START[f'ib_{n-1}_{n-2}'] + TERMINAL_DEP_STOP_M, 2),
                'role': 'departure', 'terminal': True, 'destination': STOP_NAMES[0]})
    for j in range(n - 2, 0, -1):
        out.append({'name': STOP_NAMES[j], 'stop_index': j, 'leg': 'ib', 'node_id': f'ib_{j}',
                    'chainage_m': round(SEG_START[f'ib_{j}_{j-1}'] + HALF_TRAIN_M, 2),
                    'role': 'through', 'terminal': False, 'destination': STOP_NAMES[0]})
    out.append({'name': STOP_NAMES[0], 'stop_index': 0, 'leg': 'ib', 'node_id': 'ib_0',
                'chainage_m': round(SEG_START['xover_start'] - TERMINAL_ARRIVAL_SHORT_M, 2),
                'role': 'arrival', 'terminal': True, 'destination': STOP_NAMES[0]})
    for k, p in enumerate(out):
        p['ring_index'] = k
        p['code'] = STATION_CODES.get(p['name'], p['name'][:3].upper())
    return out


PLATFORMS: list[dict] = _build_platforms()


def _platform(name: str, leg: str, role: str | None = None) -> dict:
    for p in PLATFORMS:
        if p['name'] == name and p['leg'] == leg and (role is None or p['role'] == role):
            return p
    raise KeyError((name, leg, role))


# ── Civil speed restrictions (APPROX — illustrative, not TTC civil data) ─────
def _build_speed_restrictions() -> list[dict]:
    rs: list[tuple[float, float, float, str]] = []
    n = N_STOPS
    fin_arr = _platform(STOP_NAMES[n - 1], 'ob', 'arrival')['chainage_m']
    vmc_arr = _platform(STOP_NAMES[0], 'ib', 'arrival')['chainage_m']
    # Terminal crossovers: diverging moves through the diamond.
    for x in ('xover_end', 'xover_start'):
        s = SEG_START[x]
        rs.append((s - 5.0, s + SEG_LEN[x] + 5.0, 25.0, f'terminal crossover ({ "Finch" if x == "xover_end" else "Vaughan MC"})'))
    # Terminal approach / bumper protection: enter the terminal platform track slowly.
    rs.append((fin_arr - 420.0, fin_arr, 45.0, 'Finch terminal approach'))
    rs.append((vmc_arr - 420.0, vmc_arr, 45.0, 'Vaughan MC terminal approach'))

    def ob(name):
        return _platform(name, 'ob')['chainage_m']

    def ib(name):
        return _platform(name, 'ib')['chainage_m']

    # Tight downtown curves.  Ranges are anchored on platform stopping points.
    # Union loop: University Ave → Front St → Yonge St (Union platform sits on the curve).
    rs.append((ob('St Andrew') + 40.0, ob('King') - TRAIN_LEN_M - 40.0, 35.0, 'Union loop curves'))
    rs.append((ib('King') + 40.0, ib('St Andrew') - TRAIN_LEN_M - 40.0, 35.0, 'Union loop curves'))
    # Spadina → St George: Spadina Rd turning east under Bloor St.
    rs.append((ob('Spadina') + 60.0, ob('St George') - TRAIN_LEN_M - 30.0, 45.0, 'Spadina–St George curve'))
    rs.append((ib('St George') + 60.0, ib('Spadina') - TRAIN_LEN_M - 30.0, 45.0, 'St George–Spadina curve'))
    # St George → Museum: Bloor St turning south onto Queen's Park.
    rs.append((ob('St George') + 50.0, ob('Museum') - TRAIN_LEN_M - 40.0, 40.0, 'Museum curve'))
    rs.append((ib('Museum') + 50.0, ib('St George') - TRAIN_LEN_M - 40.0, 40.0, 'Museum curve'))

    out = []
    L = ROUTE_LENGTH_M
    for a, b, lim, why in rs:
        a %= L
        b %= L
        if b > a:
            out.append({'start_m': round(a, 2), 'end_m': round(b, 2), 'limit_kph': lim, 'reason': why})
        else:  # wraps the ring origin — split
            out.append({'start_m': round(a, 2), 'end_m': round(L, 2), 'limit_kph': lim, 'reason': why})
            if b > 0:
                out.append({'start_m': 0.0, 'end_m': round(b, 2), 'limit_kph': lim, 'reason': why})
    out.sort(key=lambda r: r['start_m'])
    return out


SPEED_RESTRICTIONS: list[dict] = _build_speed_restrictions()


def civil_limit_kph_at(c: float) -> float:
    c = _wrap(c)
    lim = LINE_SPEED_KPH
    for r in SPEED_RESTRICTIONS:
        if r['start_m'] <= c < r['end_m']:
            lim = min(lim, r['limit_kph'])
    return lim


# ── Yards (APPROX lead locations) ────────────────────────────────────────────
# Wilson Yard: leads join the running line just north of Wilson station.  We model one
# lead joining the ob track (trains enter service heading for Wilson / downtown).
# Davisville Yard: between Davisville and Eglinton; modelled as a lead joining the ib
# track just north of Davisville (trains enter service heading for Davisville).
def _build_yards() -> list[dict]:
    wil = _platform('Wilson', 'ob')
    dav = _platform('Davisville', 'ib')
    return [
        {'name': 'Wilson Yard', 'code': 'WYD', 'leg': 'ob',
         'chainage_m': round(wil['chainage_m'] - HALF_TRAIN_M - 380.0, 2),
         'first_stop': 'Wilson'},
        {'name': 'Davisville Yard', 'code': 'DYD', 'leg': 'ib',
         'chainage_m': round(dav['chainage_m'] - HALF_TRAIN_M - 260.0, 2),
         'first_stop': 'Davisville'},
    ]


YARDS: list[dict] = _build_yards()


# ── Interlocking signals ─────────────────────────────────────────────────────
# Placement rules (APPROX, documented so the layout is explainable):
#   * Signals exist ONLY where a track feature needs protecting: switch/crossover points,
#     terminal platform ends, and yard leads.  No plain-line block signals (Line 1 is CBTC
#     moving block).
#   * home      — on a track that approaches a set of points, sited a sighting/braking
#                 distance before the points: 55 m + 185 m·(v_app / line speed)², rounded to
#                 5 m, where v_app is the speed a train realistically has there (limited by
#                 accelerating away from / braking into the adjacent stations and by civil
#                 limits).  So it varies ~55–240 m with geometry.
#   * starter   — at the platform end (10–11 m beyond the stopping point) at terminals, and at
#                 an interlocking station whose platform end is within 350 m of the points (the
#                 starter then protects the points and no separate home is needed).
#   * yard_exit — on the yard lead at the fouling point, governing entry to the main line.
#   * Names: interlocking code + number; odd numbers face ob (towards Finch) traffic, even
#     numbers face ib (towards Vaughan MC) traffic, yard exits are numbered from 10.
_B_APPROACH = 0.9    # m/s², used only for siting (approach-speed estimate)


def _approach_speed_mps(c: float) -> float:
    """Rough speed a train has at chainage c: min(line, civil, accel-from / brake-to stations)."""
    v_line = LINE_SPEED_KPH / 3.6
    c = _wrap(c)
    prev_d, next_d = None, None
    for p in PLATFORMS:
        d_fwd = (p['chainage_m'] - c) % ROUTE_LENGTH_M
        d_back = (c - p['chainage_m']) % ROUTE_LENGTH_M
        next_d = d_fwd if next_d is None else min(next_d, d_fwd)
        prev_d = d_back if prev_d is None else min(prev_d, d_back)
    v_acc = math.sqrt(2 * _B_APPROACH * max(prev_d, 0.0))
    v_brk = math.sqrt(2 * _B_APPROACH * max(next_d, 0.0))
    v_civil = civil_limit_kph_at(c) / 3.6
    return min(v_line, v_acc, v_brk, v_civil)


def _home_distance_m(points_c: float, facing: bool = True) -> float:
    """Siting distance before the points.  Facing points need sighting + overlap
    (55 m + 185 m·(v/v_line)²); trailing points only need fouling-point clearance + a short
    overlap (40 m + 95 m·(v/v_line)²).  Iterated because v depends on the signal's own site."""
    v_line = LINE_SPEED_KPH / 3.6
    base, k = (55.0, 185.0) if facing else (40.0, 95.0)
    d = 150.0
    for _ in range(3):
        v = _approach_speed_mps(points_c - d)
        d = base + k * (v / v_line) ** 2
    return float(round(d / 5.0) * 5.0)


def _build_signals() -> tuple[list[dict], list[dict]]:
    """Return (signal docs, switch-point features).  Each signal carries its route section."""
    specs: list[dict] = []
    features: list[dict] = []   # {kind, chainage_m, ref}
    n = N_STOPS
    L = ROUTE_LENGTH_M

    def add(code, leg, kind, ch, *, interlocking, route_end, switch_id=None, role=None, yard=None):
        specs.append({'code': code, 'leg': leg, 'kind': kind, 'chainage_m': ch % L,
                      'interlocking': interlocking, 'route_len_m': (route_end - ch) % L,
                      'switch_id': switch_id, 'role': role, 'yard': yard})

    # Terminals ------------------------------------------------------------------
    for term, arr_leg, sw, xid in (('Finch', 'ob', 'sw_end', 'xover_end'),
                                    ('Vaughan MC', 'ib', 'sw_start', 'xover_start')):
        code = STATION_CODES[term]
        arr = _platform(term, arr_leg, 'arrival')
        dep = _platform(term, 'ib' if arr_leg == 'ob' else 'ob', 'departure')
        arr_starter = arr['chainage_m'] + 11.0
        dep_starter = dep['chainage_m'] + 10.0
        plat_start = arr['chainage_m'] - TRAIN_LEN_M - 5.0
        home = plat_start - _home_distance_m(plat_start)
        features.append({'kind': 'points', 'chainage_m': SEG_START[xid] % L, 'ref': sw})
        features.append({'kind': 'points', 'chainage_m': (SEG_START[xid] + SEG_LEN[xid]) % L, 'ref': sw})
        add(code, arr_leg, 'home', home, interlocking=term, route_end=arr_starter, role='terminal_home')
        add(code, arr_leg, 'starter', arr_starter, interlocking=term, route_end=dep_starter,
            switch_id=sw, role='terminal_turnback')
        add(code, dep['leg'], 'starter', dep_starter, interlocking=term, route_end=dep_starter + 200.0,
            role='terminal_departure')

    # Mid-line crossovers --------------------------------------------------------
    for idx in MID_XOVER_STOPS:
        if not (0 < idx < n - 1):
            continue
        name = STOP_NAMES[idx]
        code = STATION_CODES[name]
        sw = f'sw_mid_{idx}'
        ob_e = f'ob_{idx}_{idx+1}'
        ib_e = f'ib_{idx+1}_{idx}'
        p_ob = SEG_START[ob_e] + MID_XOVER_T * SEG_LEN[ob_e]
        p_ib = SEG_START[ib_e] + (1.0 - MID_XOVER_T) * SEG_LEN[ib_e]
        features.append({'kind': 'points', 'chainage_m': p_ob % L, 'ref': sw})
        features.append({'kind': 'points', 'chainage_m': p_ib % L, 'ref': sw})
        for leg, pts_c, plat in (('ob', p_ob, _platform(name, 'ob')),
                                 ('ib', p_ib, _platform(STOP_NAMES[idx + 1], 'ib'))):
            plat_end = plat['chainage_m']
            route_end = pts_c + MID_XOVER_M / 2 + 40.0
            if (pts_c - plat_end) % L <= 350.0:
                add(code, leg, 'starter', plat_end + 10.0, interlocking=name, route_end=route_end,
                    switch_id=sw, role='mid_starter')
            else:
                facing = MID_XOVER_FACING.get(idx, 'ob') == leg
                d_home = _home_distance_m(pts_c - MID_XOVER_M / 2, facing=facing)
                add(code, leg, 'home', pts_c - MID_XOVER_M / 2 - d_home,
                    interlocking=name, route_end=route_end, switch_id=sw, role='mid_home')

    # Yard leads -----------------------------------------------------------------
    for y in YARDS:
        j = y['chainage_m']
        features.append({'kind': 'yard_lead', 'chainage_m': j % L, 'ref': y['name']})
        add(y['code'], y['leg'], 'home', j - 20.0 - _home_distance_m(j - 20.0, facing=False), interlocking=y['name'],
            route_end=j + 20.0, role='yard_home', yard=y['name'])
        add(y['code'], y['leg'], 'yard_exit', j - 3.0, interlocking=y['name'], route_end=j + 160.0,
            role='yard_exit', yard=y['name'])

    # Platform ends are features too (for siting sanity checks).
    for p in PLATFORMS:
        features.append({'kind': 'platform_end', 'chainage_m': p['chainage_m'], 'ref': p['name']})
        features.append({'kind': 'platform_end', 'chainage_m': (p['chainage_m'] - TRAIN_LEN_M - 5.0) % L,
                         'ref': p['name']})

    # Name: code + number (odd = ob, even = ib; yard exits from 10).
    counters: dict[tuple[str, str], int] = {}
    docs = []
    for s in sorted(specs, key=lambda s: (s['code'], s['kind'] == 'yard_exit', s['chainage_m'])):
        if s['kind'] == 'yard_exit':
            k = (s['code'], 'yard')
            num = 10 + 2 * counters.get(k, 0)
            counters[k] = counters.get(k, 0) + 1
        else:
            k = (s['code'], s['leg'])
            base = 1 if s['leg'] == 'ob' else 2
            num = base + 2 * counters.get(k, 0)
            counters[k] = counters.get(k, 0) + 1
        name = f"{s['code']} {num}"
        sid = f"sig_{s['code']}_{num}"
        eid, t = chainage_to_edge_m(s['chainage_m'])
        pos = _edge_point(eid, t)
        if s['kind'] == 'yard_exit':
            # Draw the yard-exit signal just off the running line, on the lead side.
            p = EDGES[eid]['points']
            dx, dy = p[-1]['x'] - p[0]['x'], p[-1]['y'] - p[0]['y']
            ln = math.hypot(dx, dy) or 1.0
            side = 1.0 if s['leg'] == 'ob' else -1.0
            pos = {'x': round(pos['x'] - dy / ln * 30.0 * side, 2), 'y': round(pos['y'] + dx / ln * 30.0 * side, 2)}
        docs.append({
            'id': sid, 'name': name, 'edge_id': eid, 'offset': round(t, 5), 'position': pos,
            'aspect': 'red', 'block_id': EDGES[eid]['block_id'],
            'chainage_m': round(s['chainage_m'], 2), 'leg': s['leg'], 'kind': s['kind'],
            'interlocking': s['interlocking'],
            # internal route description (also handy for the UI tooltip)
            'route_len_m': round(s['route_len_m'], 2), 'switch_id': s['switch_id'],
            'role': s['role'], 'yard': s['yard'],
        })
    docs.sort(key=lambda d: d['chainage_m'])
    features.sort(key=lambda f: f['chainage_m'])
    return docs, features


SIGNALS, TRACK_FEATURES = _build_signals()
YUS_TOPOLOGY['signals'] = SIGNALS

# Switch points chainage (additive field, handy for clients).
_points_by_sw: dict[str, list[float]] = {}
for _f in TRACK_FEATURES:
    if _f['kind'] == 'points':
        _points_by_sw.setdefault(_f['ref'], []).append(round(_f['chainage_m'], 2))
for _sw in YUS_TOPOLOGY['switches']:
    _sw['points_m'] = sorted(_points_by_sw.get(_sw['id'], []))

YUS_TOPOLOGY['route'] = {
    'length_m': round(ROUTE_LENGTH_M, 2),
    'segments': [{'edge_id': eid, 'start_m': round(s, 2), 'length_m': round(l, 2)} for eid, s, l in ROUTE_SEGMENTS_M],
}


def _stations_doc() -> list[dict]:
    out = []
    for i, name in enumerate(STOP_NAMES):
        plats = [{'leg': p['leg'], 'node_id': p['node_id'], 'chainage_m': p['chainage_m'],
                  'role': p['role'], 'ring_index': p['ring_index']}
                 for p in PLATFORMS if p['stop_index'] == i]
        out.append({'name': name, 'code': STATION_CODES.get(name, name[:3].upper()),
                    'stop_index': i, 'platforms': plats})
    return out


YUS_TOPOLOGY['stations'] = _stations_doc()
YUS_TOPOLOGY['speed_restrictions'] = SPEED_RESTRICTIONS
YUS_TOPOLOGY['yards'] = [{'name': y['name'], 'chainage_m': y['chainage_m'], 'leg': y['leg']} for y in YARDS]


def get_topology_document(line_id: str) -> dict:
    key = (line_id or '').strip().upper()
    if key == 'YUS':
        return YUS_TOPOLOGY
    raise ValueError(f'unknown line_id: {line_id!r}')
