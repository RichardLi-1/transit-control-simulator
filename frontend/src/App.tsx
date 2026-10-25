import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { useTopologyStore } from './store/topologyStore'
import { useRuntimeStore } from './store/runtimeStore'
import { useUiStore, type InspectorTab } from './store/uiStore'
import { useConnectionStore } from './store/connectionStore'
import './store/eventsStore'
import { CanvasView } from './components/CanvasView'
import { CommandAlert } from './components/CommandAlert'
import { ConfigPanel } from './components/ConfigPanel'
import { GuidePointer, HelpChat } from './components/HelpChat'
import { InfoPopup } from './components/InfoPopup'
import { Inspector } from './components/Inspector'
import { StatusBar } from './components/StatusBar'
import { TopBar } from './components/TopBar'
import { usePageViewTracker } from './hooks/usePageViewTracker'
import { useIsMobile } from './hooks/useIsMobile'
import { isMlEnabled } from './config/ml'
import { fetchMlHealth } from './api/client'
import { setFitInsets } from './render/Viewport'
import { applyLayout, layoutTargetChanged } from './layout'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'

const MOBILE_TABS: { tab: InspectorTab; label: string }[] = [
  { tab: 'train', label: 'Train' },
  { tab: 'dispatch', label: 'Dispatch' },
  { tab: 'events', label: 'Events' },
]

/** Phone: tab bar under the status bar; each opens the inspector sheet on that tab. */
function MobileNav() {
  const { sheetOpen, inspectorTab, openInspector } = useUiStore()
  return (
    <nav aria-label="Panels" className="grid h-11 shrink-0 grid-cols-3 border-t bg-card pb-[env(safe-area-inset-bottom)]">
      {MOBILE_TABS.map(({ tab, label }) => {
        const active = sheetOpen && inspectorTab === tab
        return (
          <button
            key={tab}
            type="button"
            aria-pressed={active}
            onClick={() => openInspector(tab)}
            className={cn(
              'text-xs font-medium text-muted-foreground not-last:border-r active:bg-accent',
              active && 'text-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </nav>
  )
}

/**
 * The schematic is laid out for the usable map area, so rebuild it when that area changes shape
 * enough to matter (orientation flip or > 15 % aspect change); CanvasView re-fits on the new topology.
 */
function relayoutIfNeeded() {
  if (!layoutTargetChanged()) return
  const { raw, layout } = useTopologyStore.getState()
  if (raw) useTopologyStore.setState({ topology: applyLayout(raw, layout) })
}

export default function App() {
  const { load } = useTopologyStore()
  const { startPolling, stopPolling } = useRuntimeStore()
  const selectedTrainId = useRuntimeStore((s) => s.selectedTrainId)
  const [configOpen, setConfigOpen] = useState(false)
  const { infoOpen, setInfoOpen, toggleDevMode, inspectorOpen, guideOpen, sheetOpen, setSheetOpen, openInspector } = useUiStore()
  const isMobile = useIsMobile()
  const mapRef = useRef<HTMLElement>(null)

  usePageViewTracker()
  const mlOn = isMlEnabled()

  useEffect(() => {
    load()
    startPolling()
    return () => stopPolling()
  }, [load, startPolling, stopPolling])

  useEffect(() => {
    if (!mlOn) return
    let cancelled = false
    let timer = 0
    const graceUntil = Date.now() + 60_000

    const tick = async () => {
      try {
        await fetchMlHealth()
        if (!cancelled) useConnectionStore.getState().report('ml', 'ok')
      } catch (err) {
        // Vite returns HTTP 500 while :8001 is still starting. Wait before alarming.
        if (!cancelled && Date.now() >= graceUntil) {
          useConnectionStore.getState().report('ml', 'error', String(err))
        }
      }
      if (!cancelled) timer = window.setTimeout(() => { void tick() }, 3000)
    }

    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mlOn])

  // The map is docked between the bars and the panels, so FIT only keeps clear of the zoom group
  // (desktop: a column at the right edge; phone: the group only covers the bottom-right corner).
  useLayoutEffect(() => {
    setFitInsets(isMobile ? { top: 8, right: 8, bottom: 8, left: 8 } : { top: 16, right: 56, bottom: 16, left: 16 })
    relayoutIfNeeded()
  }, [isMobile])

  // Window resizes and panels opening/closing change the map's shape (debounced).
  useEffect(() => {
    const el = mapRef.current
    if (!el) return
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(relayoutIfNeeded, 250)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      window.clearTimeout(timer)
    }
  }, [])

  // Selecting a train on the map brings up its inspector tab.
  useEffect(() => {
    if (selectedTrainId) openInspector('train')
  }, [selectedTrainId, openInspector])

  // Ctrl+Shift+C = hidden config. Ctrl+Shift+D = dev mode (endpoint health, sim speed).
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      e.preventDefault()
      setConfigOpen((v) => !v)
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault()
      toggleDevMode()
    }
  }, [toggleDevMode])
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <main ref={mapRef} data-help="map" className="relative min-w-0 flex-1 overflow-hidden">
            <CanvasView />
            <CommandAlert />
          </main>
          {!isMobile && guideOpen && (
            <aside className="w-72 shrink-0 border-l bg-card xl:w-80">
              <HelpChat />
            </aside>
          )}
          {!isMobile && inspectorOpen && (
            <aside className="w-80 shrink-0 border-l bg-card">
              <Inspector />
            </aside>
          )}
        </div>
        <StatusBar />
        {isMobile && <MobileNav />}
      </div>

      {isMobile && (
        <>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="bottom" showCloseButton={false} className="gap-0 p-0 data-[side=bottom]:h-[70dvh]" onOpenAutoFocus={(e) => e.preventDefault()}>
              <SheetTitle className="sr-only">Inspector</SheetTitle>
              <SheetDescription className="sr-only">Train, dispatch and events.</SheetDescription>
              <Inspector
                trailing={
                  <SheetClose asChild>
                    <Button variant="ghost" size="icon-xs" aria-label="Close"><X /></Button>
                  </SheetClose>
                }
              />
            </SheetContent>
          </Sheet>
          <HelpChat />
        </>
      )}

      <GuidePointer />
      <ConfigPanel open={configOpen} onOpenChange={setConfigOpen} />
      <InfoPopup open={infoOpen} onClose={() => setInfoOpen(false)} />
    </TooltipProvider>
  )
}
