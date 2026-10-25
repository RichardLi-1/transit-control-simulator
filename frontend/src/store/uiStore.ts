import { create } from 'zustand'
import { applyHighContrast } from '../constants/colors'
import type { MapLayout } from '../layout'

const DEV_KEY = 'cbtc-dev-mode'
const CONTRAST_KEY = 'cbtc-high-contrast'
const LAYOUT_KEY = 'cbtc-map-layout'
const INSPECTOR_KEY = 'cbtc-inspector-open'

/** Matches hooks/useIsMobile (MOBILE_BREAKPOINT = 720). */
const MOBILE_QUERY = '(max-width: 719px)'

export type InspectorTab = 'train' | 'dispatch' | 'events'

function readFlag(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch { /* ignore */ }
}

/** Shareable overrides: ?layout=map|schematic, ?contrast=high|normal (not persisted). */
function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name)
  } catch {
    return null
  }
}

function readLayout(): MapLayout {
  const q = urlParam('layout')
  if (q === 'map' || q === 'geographic') return 'geographic'
  if (q === 'schematic') return 'schematic'
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'geographic' ? 'geographic' : 'schematic'
  } catch {
    return 'schematic'
  }
}

function isMobileNow(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(MOBILE_QUERY).matches)
}

/** One switch for both palettes: canvas (COLORS) and DOM (`.hc` overrides the CSS variables). */
function applyContrast(on: boolean): void {
  applyHighContrast(on)
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('hc', on)
}

const contrastParam = urlParam('contrast')
const initialHighContrast = contrastParam === 'high' ? true : contrastParam === 'normal' ? false : readFlag(CONTRAST_KEY)
applyContrast(initialHighContrast)

interface UiState {
  infoOpen: boolean
  devMode: boolean
  highContrast: boolean
  /** Schematic line diagram (default) or geographic map. Persisted. */
  mapLayout: MapLayout
  /** Legend popover (status bar). */
  legendOpen: boolean
  /** GUIDE chat panel. */
  guideOpen: boolean
  /** Desktop inspector sidebar visible. Persisted. */
  inspectorOpen: boolean
  /** Phone: inspector bottom sheet open. */
  sheetOpen: boolean
  inspectorTab: InspectorTab
  setInfoOpen: (v: boolean) => void
  setDevMode: (v: boolean) => void
  toggleDevMode: () => void
  setHighContrast: (v: boolean) => void
  setMapLayout: (v: MapLayout) => void
  setLegendOpen: (v: boolean) => void
  setGuideOpen: (v: boolean) => void
  setInspectorOpen: (v: boolean) => void
  setSheetOpen: (v: boolean) => void
  setInspectorTab: (tab: InspectorTab) => void
  /** Show a tab: un-collapses the sidebar on desktop, opens the sheet on phones. */
  openInspector: (tab: InspectorTab) => void
}

export const useUiStore = create<UiState>((set) => ({
  infoOpen: false,
  devMode: readFlag(DEV_KEY),
  highContrast: initialHighContrast,
  mapLayout: readLayout(),
  legendOpen: false,
  guideOpen: false,
  inspectorOpen: readFlag(INSPECTOR_KEY, true),
  sheetOpen: false,
  inspectorTab: 'train',
  setInfoOpen: (v) => set({ infoOpen: v }),
  setDevMode: (devMode) => {
    writeFlag(DEV_KEY, devMode)
    set({ devMode })
  },
  toggleDevMode: () =>
    set((s) => {
      const devMode = !s.devMode
      writeFlag(DEV_KEY, devMode)
      return { devMode }
    }),
  setHighContrast: (highContrast) => {
    writeFlag(CONTRAST_KEY, highContrast)
    applyContrast(highContrast)
    set({ highContrast })
  },
  setMapLayout: (mapLayout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, mapLayout)
    } catch { /* ignore */ }
    set({ mapLayout })
  },
  setLegendOpen: (legendOpen) => set({ legendOpen }),
  setGuideOpen: (guideOpen) => set({ guideOpen }),
  setInspectorOpen: (inspectorOpen) => {
    writeFlag(INSPECTOR_KEY, inspectorOpen)
    set({ inspectorOpen })
  },
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  openInspector: (inspectorTab) => {
    if (isMobileNow()) {
      set({ inspectorTab, sheetOpen: true })
    } else {
      writeFlag(INSPECTOR_KEY, true)
      set({ inspectorTab, inspectorOpen: true })
    }
  },
}))
