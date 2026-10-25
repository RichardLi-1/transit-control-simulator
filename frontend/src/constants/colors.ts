/**
 * Colour + map-stroke tokens. `COLORS` is a live, mutable palette shared by the canvas layers and the
 * React chrome; `applyHighContrast` swaps it in place and mirrors every string token into CSS custom
 * properties (`--c-<key>`, e.g. `--c-surface-1`) so stylesheet rules follow the same palette.
 *
 * Keys are a shared API (TrainLayer / Tooltip / CanvasView read them): add keys freely, never rename
 * or remove one.
 *
 * Palette intent: a calm dark operations display on zinc neutrals (zinc-950 ground, zinc-900
 * surfaces, zinc-800 borders). Colour is reserved for meaning (danger red, caution amber, info
 * cyan, ok green, signal aspects, train states) and the Line 1 identity yellow, which is used
 * only for line identity (brand mark), never on the map's track or stations.
 */
import yus from '../../../backend/data/yus_topology.json'

/** Line 1 identity colour, straight from the line data (GTFS route_color). */
const LINE_1 = (yus as { line?: { color?: string } }).line?.color ?? '#FFCD00'

const DEFAULT = {
  BACKGROUND: '#09090b',         // zinc-950
  GRID: '#18181b',

  // ── Surfaces / text (UI chrome) — zinc, matching the console theme ──────
  SURFACE_0: '#09090b',          // app background
  SURFACE_1: '#18181b',          // cards, bars (zinc-900)
  SURFACE_2: '#1f1f23',          // controls, inset wells
  SURFACE_3: '#27272a',          // hover / pressed (zinc-800)
  BORDER: '#27272a',             // zinc-800
  BORDER_STRONG: '#3f3f46',      // zinc-700
  TEXT_1: '#fafafa',             // primary (zinc-50)
  TEXT_2: '#a1a1aa',             // secondary (zinc-400)
  TEXT_3: '#71717a',             // tertiary / captions (zinc-500)
  FOCUS: '#3bb1ce',

  // ── Semantic ────────────────────────────────────────────────────────────
  DANGER: '#ef4444',
  CAUTION: '#f59e0b',
  INFO: '#3bb1ce',
  OK: '#22c55e',
  DANGER_SOFT: 'rgba(239, 68, 68, 0.14)',
  CAUTION_SOFT: 'rgba(245, 158, 11, 0.14)',
  INFO_SOFT: 'rgba(59, 177, 206, 0.14)',
  OK_SOFT: 'rgba(34, 197, 94, 0.14)',

  // ── Line identity ───────────────────────────────────────────────────────
  ACCENT: LINE_1,
  ACCENT_TEXT: '#18181b',
  LINE_2: '#00a54f',             // Bloor–Danforth (interchange bullets)
  LINE_4: '#b0247a',             // Sheppard

  // ── Track (calm mid-grey; colour on the map is reserved for meaning) ────
  TRACK_CLEAR: '#5b5b64',
  TRACK_OCCUPIED: '#ef4444',
  TRACK_UNKNOWN: '#3f3f46',
  TRACK_CROSSOVER: '#5b5b64',
  TRACK_WIDTH: 2,
  TRACK_CROSSOVER_WIDTH: 1.5,

  // Block overlays
  BLOCK_OCCUPIED_FILL: 'rgba(239, 68, 68, 0.16)',
  BLOCK_CLEAR_FILL: 'rgba(0,0,0,0)',

  // ── Signals (wayside heads; aspects are the only colour) ────────────────
  SIGNAL_GREEN: '#22c55e',
  SIGNAL_YELLOW: '#fbbf24',
  SIGNAL_RED: '#ef4444',
  SIGNAL_FLASHING_YELLOW: '#f59e0b',
  SIGNAL_DARK: '#3f3f46',
  SIGNAL_BORDER: '#09090b',
  SIGNAL_RADIUS: 2.75,
  SIGNAL_MAST: '#71717a',
  /** Signal name text (zoomed / hovered). */
  SIGNAL_LABEL: '#71717a',

  // ── Stations (platform boxes the two tracks pass through) ───────────────
  STATION_MARKER_FILL: '#131316',
  STATION_MARKER_BORDER: '#71717a',
  STATION_MARKER_HALO: 'rgba(255, 205, 0, 0.35)',
  STATION_LABEL_BG: 'rgba(9, 9, 11, 0.85)',
  INTERCHANGE_BORDER: '#d4d4d8',

  // ── Points / crossovers ─────────────────────────────────────────────────
  SWITCH_NORMAL: '#71717a',
  SWITCH_REVERSE: '#f59e0b',
  SWITCH_RADIUS: 6,

  // ── Trains (legend uses these exact values) ─────────────────────────────
  // Running blue · at platform white · stopped amber · emergency brake red · out of service
  // hollow grey: distinct in hue AND lightness, so they survive colour-vision deficiency.
  TRAIN_FILL: '#3bb1ce',
  /** Knockout outline that separates a train from the track under it. */
  TRAIN_BORDER: '#09090b',
  TRAIN_LABEL: '#fafafa',
  TRAIN_DWELL: '#e4e4e7',
  TRAIN_ARRIVING: '#3bb1ce',
  TRAIN_STOPPED: '#f59e0b',
  TRAIN_EBRAKE: '#ef4444',
  /** Withdrawn / running to the yard: drawn hollow in this colour. */
  TRAIN_OUT_OF_SERVICE: '#a1a1aa',
  TRAIN_SAFE_ZONE_FRONT: 'rgba(59, 177, 206, 0.22)',
  TRAIN_SAFE_ZONE_REAR: 'rgba(245, 158, 11, 0.12)',
  /** Movement-authority line ahead of a train (thin; amber / red when slack is low). */
  MA_BAND: 'rgba(59, 177, 206, 0.42)',
  /** End-of-authority tick. */
  MA_EOA: 'rgba(147, 197, 253, 0.9)',

  // ── Map annotations ─────────────────────────────────────────────────────
  SPEED_RESTRICTION: 'rgba(245, 158, 11, 0.55)',
  SPEED_RESTRICTION_TEXT: '#fbbf24',
  SPEED_TAG_BG: '#18181b',
  YARD: '#52525b',
  YARD_LABEL: '#71717a',

  // ── Labels ──────────────────────────────────────────────────────────────
  STATION_LABEL: '#a1a1aa',
  STATION_LABEL_MAJOR: '#e4e4e7',
  STATION_LABEL_TERMINAL: '#fafafa',
  TRAIN_ID_LABEL: '#fafafa',
  HUD: '#a1a1aa',

  // UI chrome (legacy names, kept in sync with the surface/text tokens)
  PANEL_BG: '#18181b',
  PANEL_BORDER: '#27272a',
  PANEL_TEXT: '#fafafa',
  PANEL_TEXT_DIM: '#a1a1aa',
  BUTTON_BG: '#1f1f23',
  BUTTON_HOVER: '#27272a',
  BUTTON_ACTIVE: '#1f8aa6',
  ERROR_BANNER: '#ef4444',
  STALE_BANNER: '#f59e0b',
  SUCCESS: '#22c55e',
}

type Palette = typeof DEFAULT

/** Pure black/white, saturated aspects, thicker strokes, no low-contrast greys. */
const HIGH_CONTRAST: Palette = {
  ...DEFAULT,
  BACKGROUND: '#000000',
  GRID: '#1a1a1a',

  SURFACE_0: '#000000',
  SURFACE_1: '#000000',
  SURFACE_2: '#0f0f0f',
  SURFACE_3: '#2a2a2a',
  BORDER: '#ffffff',
  BORDER_STRONG: '#ffffff',
  TEXT_1: '#ffffff',
  TEXT_2: '#f2f2f2',
  TEXT_3: '#d6d6d6',
  FOCUS: '#ffd400',

  DANGER: '#ff5c5c',
  CAUTION: '#ffc21a',
  INFO: '#40d0f0',
  OK: '#33f08a',
  DANGER_SOFT: 'rgba(255, 92, 92, 0.25)',
  CAUTION_SOFT: 'rgba(255, 194, 26, 0.25)',
  INFO_SOFT: 'rgba(64, 208, 240, 0.25)',
  OK_SOFT: 'rgba(51, 240, 138, 0.25)',

  ACCENT: '#ffd400',
  ACCENT_TEXT: '#000000',
  LINE_2: '#00d066',
  LINE_4: '#e040a8',

  TRACK_CLEAR: '#a6a6a6',
  TRACK_OCCUPIED: '#ff3333',
  TRACK_UNKNOWN: '#808080',
  TRACK_CROSSOVER: '#a6a6a6',
  TRACK_WIDTH: 3,
  TRACK_CROSSOVER_WIDTH: 2.5,
  BLOCK_OCCUPIED_FILL: 'rgba(255, 51, 51, 0.35)',

  SIGNAL_GREEN: '#33f08a',
  SIGNAL_YELLOW: '#ffd400',
  SIGNAL_RED: '#ff4747',
  SIGNAL_FLASHING_YELLOW: '#ffb000',
  SIGNAL_DARK: '#666666',
  SIGNAL_BORDER: '#000000',
  SIGNAL_RADIUS: 3.5,
  SIGNAL_MAST: '#ffffff',
  SIGNAL_LABEL: '#ffffff',

  STATION_MARKER_FILL: '#000000',
  STATION_MARKER_BORDER: '#a6a6a6',
  STATION_MARKER_HALO: 'rgba(255, 212, 0, 0.45)',
  STATION_LABEL_BG: 'rgba(0, 0, 0, 0.92)',
  INTERCHANGE_BORDER: '#ffffff',

  SWITCH_NORMAL: '#ffffff',
  SWITCH_REVERSE: '#ffc21a',
  SWITCH_RADIUS: 8,

  TRAIN_FILL: '#40d0f0',
  TRAIN_BORDER: '#000000',
  TRAIN_LABEL: '#ffffff',
  TRAIN_DWELL: '#ffffff',
  TRAIN_ARRIVING: '#40d0f0',
  TRAIN_STOPPED: '#ffc21a',
  TRAIN_EBRAKE: '#ff3b3b',
  TRAIN_OUT_OF_SERVICE: '#d6d6d6',
  TRAIN_SAFE_ZONE_FRONT: 'rgba(64, 208, 240, 0.45)',
  TRAIN_SAFE_ZONE_REAR: 'rgba(255, 194, 26, 0.35)',
  MA_BAND: 'rgba(64, 208, 240, 0.6)',
  MA_EOA: '#bfe4ff',

  SPEED_RESTRICTION: 'rgba(255, 194, 26, 0.9)',
  SPEED_RESTRICTION_TEXT: '#ffd400',
  SPEED_TAG_BG: '#000000',
  YARD: '#d6d6d6',
  YARD_LABEL: '#ffffff',

  STATION_LABEL: '#ffffff',
  STATION_LABEL_MAJOR: '#ffffff',
  STATION_LABEL_TERMINAL: '#ffffff',
  TRAIN_ID_LABEL: '#ffffff',
  HUD: '#ffffff',

  PANEL_BG: '#000000',
  PANEL_BORDER: '#ffffff',
  PANEL_TEXT: '#ffffff',
  PANEL_TEXT_DIM: '#f2f2f2',
  BUTTON_BG: '#0f0f0f',
  BUTTON_HOVER: '#2a2a2a',
  BUTTON_ACTIVE: '#1f8aa6',
  ERROR_BANNER: '#ff5c5c',
  STALE_BANNER: '#ffc21a',
  SUCCESS: '#33f08a',
}

/** Live palette. Mutated by applyHighContrast so canvas + UI stay in sync. */
export const COLORS: Palette = { ...DEFAULT }

function cssVarName(key: string): string {
  return `--c-${key.toLowerCase().replace(/_/g, '-')}`
}

/** Mirror string tokens into CSS custom properties on :root (no-op outside the browser). */
function syncCssVars(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [k, v] of Object.entries(COLORS)) {
    if (typeof v === 'string') root.style.setProperty(cssVarName(k), v)
  }
}

export function applyHighContrast(on: boolean): void {
  Object.assign(COLORS, on ? HIGH_CONTRAST : DEFAULT)
  syncCssVars()
  if (typeof document !== 'undefined') document.documentElement.dataset.contrast = on ? 'high' : 'normal'
}

export type Color = typeof COLORS[keyof typeof COLORS]
