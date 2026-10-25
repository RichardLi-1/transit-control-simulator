import { create } from 'zustand'
import type { Topology } from '../types/domain'
import { fetchTopology } from '../api/client'
import { applyLayout, type MapLayout } from '../layout'
import { useUiStore } from './uiStore'

interface TopologyStore {
  /** Topology exactly as served by GET /topology (geographic coordinates). */
  raw: Topology | null
  /**
   * Topology in the active map layout. Every consumer (renderers, motion route index, hit
   * tests, tooltips) reads this one object, so all geometry is consistent per layout.
   */
  topology: Topology | null
  layout: MapLayout
  loading: boolean
  error: string | null
  load: () => Promise<void>
}

export const useTopologyStore = create<TopologyStore>((set, get) => ({
  raw: null,
  topology: null,
  layout: useUiStore.getState().mapLayout,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const raw = await fetchTopology()
      set({ raw, topology: applyLayout(raw, get().layout), loading: false })
    } catch (err) {
      set({ loading: false, error: String(err) })
    }
  },
}))

// Follow the persisted layout preference.
useUiStore.subscribe((s) => {
  const { raw, layout } = useTopologyStore.getState()
  if (s.mapLayout === layout) return
  useTopologyStore.setState({ layout: s.mapLayout, topology: raw ? applyLayout(raw, s.mapLayout) : null })
})
