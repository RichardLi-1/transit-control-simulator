import { create } from 'zustand'
import type { RuntimeState, HoveredEntity, SimConfig, RollingStockProfile } from '../types/domain'
import { fetchState, commandSwitch, commandSignal, commandTrain } from '../api/client'
import { motion } from '../motion/engine'

/** Target spacing between poll STARTS. Polls are sequential — never overlapping. */
const POLL_INTERVAL_MS = 200
/** Minimum idle gap after a slow response, so a slow backend isn't hammered. */
const POLL_MIN_GAP_MS = 40

const DEFAULT_PROFILE: RollingStockProfile = {
  id: 'toronto_rocket',
  name: 'Toronto Rocket (TR)',
  max_speed: 22,
  accel: 1.3,
  decel: 1.5,
  length: 138,
  mass: 240,
}

const DEFAULT_CONFIG: SimConfig = {
  rolling_stock_pct: 100,
  active_profile: 'toronto_rocket',
  profiles: [DEFAULT_PROFILE],
  headway_target: 120,
  injected_events: [],
}

interface RuntimeStore {
  runtime: RuntimeState | null
  stale: boolean
  commandError: string | null
  hovered: HoveredEntity | null
  /** Train whose dispatch menu is open (drawn with a selection ring). */
  selectedTrainId: string | null
  showSafeZones: boolean
  showLabels: boolean
  config: SimConfig

  // poll lifecycle
  startPolling: () => void
  stopPolling: () => void

  // interaction
  setHovered: (e: HoveredEntity | null) => void
  setSelectedTrain: (id: string | null) => void
  clearCommandError: () => void

  // commands
  sendSwitchCommand: (id: string, state: import('../types/domain').SwitchState) => Promise<void>
  sendSignalCommand: (id: string, aspect: import('../types/domain').SignalAspect) => Promise<void>
  sendTrainCommand: (id: string, action: import('../types/domain').DispatchAction, count?: number) => Promise<void>

  // view toggles
  toggleSafeZones: () => void
  toggleLabels: () => void

  // config
  updateConfig: (patch: Partial<SimConfig>) => void
}

/** Persistent rewinds for this long are a sim restart, not a stale replica flapping in. */
const REWIND_ACCEPT_AFTER_MS = 3000
let _rejectingSince: number | null = null

/** Rewind protection: drop snapshots older than the one we have (stale replica / reordering). */
export function acceptState(prev: RuntimeState | null, next: RuntimeState, nowMs = performance.now()): boolean {
  const a = prev?.sim_time_s
  const b = next.sim_time_s
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return true
  if (b + 0.25 >= a) { _rejectingSince = null; return true }
  // Real reset (sim restarted), not a second replica.
  if (b < 15 && a > 30) { _rejectingSince = null; return true }
  // Restarted while we weren't looking: every response is "older" — accept once it persists.
  if (_rejectingSince == null) _rejectingSince = nowMs
  if (nowMs - _rejectingSince > REWIND_ACCEPT_AFTER_MS) { _rejectingSince = null; return true }
  return false
}

export const useRuntimeStore = create<RuntimeStore>((set, get) => {
  /** Incremented on every start/stop; a running loop exits when its generation is stale. */
  let _pollGen = 0
  let _polling = false
  let _staleTimer: ReturnType<typeof setTimeout> | null = null
  const STALE_AFTER_MS = 2000

  function resetStaleTimer() {
    if (_staleTimer) clearTimeout(_staleTimer)
    _staleTimer = setTimeout(() => set({ stale: true }), STALE_AFTER_MS)
  }

  return {
    runtime: null,
    stale: false,
    commandError: null,
    hovered: null,
    selectedTrainId: null,
    showSafeZones: true,
    showLabels: true,
    config: DEFAULT_CONFIG,

    startPolling: () => {
      if (_polling) return
      _polling = true
      const gen = ++_pollGen
      // Sequential loop: the next request starts only after the previous one settled, so
      // responses can never overlap or arrive out of order (the old setInterval could).
      const loop = async () => {
        while (gen === _pollGen) {
          const started = performance.now()
          try {
            const runtime = await fetchState()
            if (gen !== _pollGen) return
            if (acceptState(get().runtime, runtime)) {
              motion.ingest(runtime, performance.now())
              set({ runtime, stale: false })
              resetStaleTimer()
            }
          } catch {
            // stale timer will fire if this keeps failing
          }
          if (gen !== _pollGen) return
          const elapsed = performance.now() - started
          await new Promise(r => setTimeout(r, Math.max(POLL_MIN_GAP_MS, POLL_INTERVAL_MS - elapsed)))
        }
      }
      void loop()
    },

    stopPolling: () => {
      _pollGen++
      _polling = false
      if (_staleTimer) { clearTimeout(_staleTimer); _staleTimer = null }
    },

    setHovered: (hovered) => set({ hovered }),
    setSelectedTrain: (selectedTrainId) => set({ selectedTrainId }),
    clearCommandError: () => set({ commandError: null }),

    sendSwitchCommand: async (id, state) => {
      try {
        await commandSwitch(id, state)
        set({ commandError: null })
      } catch (err) {
        set({ commandError: `Switch ${id}: ${String(err)}` })
      }
    },

    sendSignalCommand: async (id, aspect) => {
      try {
        await commandSignal(id, aspect)
        set({ commandError: null })
      } catch (err) {
        set({ commandError: `Signal ${id}: ${String(err)}` })
      }
    },

    sendTrainCommand: async (id, action, count = 1) => {
      try {
        await commandTrain(id, action, count)
        set({ commandError: null })
      } catch (err) {
        set({ commandError: `Train ${id}: ${String(err)}` })
      }
    },

    toggleSafeZones: () => set(s => ({ showSafeZones: !s.showSafeZones })),
    toggleLabels: () => set(s => ({ showLabels: !s.showLabels })),

    updateConfig: (patch) => set(s => ({ config: { ...s.config, ...patch } })),
  }
})
