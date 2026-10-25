/**
 * Top bar: line identity, sim clock, view controls, tools. Phones keep identity + clock and fold
 * the view controls into the overflow menu.
 */
import posthog from 'posthog-js'
import { Ellipsis, Info, PanelRight } from 'lucide-react'
import { useRuntimeStore } from '../store/runtimeStore'
import { useUiStore } from '../store/uiStore'
import { useIsMobile } from '../hooks/useIsMobile'
import type { MapLayout } from '../layout'
import { HowItWorks } from './HowItWorks'
import { fmtSimClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const REPO_URL = 'https://github.com/RichardLi-1/cbtc'

export function Roundel({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-line-1 text-[11px] leading-none font-bold text-line-1-foreground',
        className,
      )}
    >
      1
    </span>
  )
}

function SimClock() {
  const simT = useRuntimeStore((s) => s.runtime?.sim_time_s ?? null)
  const speed = useRuntimeStore((s) => s.runtime?.sim_speed ?? null)
  const paused = useRuntimeStore((s) => s.runtime?.paused ?? false)
  const note = paused ? 'Paused' : speed != null && speed !== 1 ? `×${speed}` : null
  return (
    <div className="flex items-center gap-2" title="Simulated service time. Service starts 06:00.">
      <span className="micro">Sim</span>
      <span className="num text-[13px] font-medium text-foreground">{fmtSimClock(simT)}</span>
      {note && <Badge variant="caution">{note}</Badge>}
    </div>
  )
}

function onLayoutChange(setMapLayout: (v: MapLayout) => void, v: string) {
  if (v !== 'schematic' && v !== 'geographic') return
  setMapLayout(v)
  posthog.capture('map_layout_changed', { layout: v })
}

function openAbout(setInfoOpen: (v: boolean) => void) {
  setInfoOpen(true)
  posthog.capture('info_panel_viewed')
}

function GuideButton() {
  const guideOpen = useUiStore((s) => s.guideOpen)
  const setGuideOpen = useUiStore((s) => s.setGuideOpen)
  return (
    <HowItWorks>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={guideOpen}
        onClick={() => setGuideOpen(!guideOpen)}
        title="Ask the guide about anything on screen"
      >
        Guide
      </Button>
    </HowItWorks>
  )
}

function OverflowMenu({ mobile }: { mobile?: boolean }) {
  const { showSafeZones, showLabels, toggleSafeZones, toggleLabels } = useRuntimeStore()
  const { highContrast, setHighContrast, mapLayout, setMapLayout, setInfoOpen } = useUiStore()
  return (
    <DropdownMenu>
      <span data-help="menu" className="inline-flex">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="end" className="w-56">
        {mobile && (
          <>
            <DropdownMenuLabel>Layout</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mapLayout} onValueChange={(v) => onLayoutChange(setMapLayout, v)}>
              <DropdownMenuRadioItem value="schematic">Schematic</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="geographic">Map</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={showSafeZones} onCheckedChange={toggleSafeZones} onSelect={(e) => e.preventDefault()}>
              Safe zones
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showLabels} onCheckedChange={toggleLabels} onSelect={(e) => e.preventDefault()}>
              Labels
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuCheckboxItem checked={highContrast} onCheckedChange={(v) => setHighContrast(v === true)} onSelect={(e) => e.preventDefault()}>
          High contrast
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {mobile && <DropdownMenuItem onSelect={() => openAbout(setInfoOpen)}>About this simulator</DropdownMenuItem>}
        <DropdownMenuItem asChild>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">Source on GitHub</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar() {
  const { showSafeZones, showLabels, toggleSafeZones, toggleLabels } = useRuntimeStore()
  const { mapLayout, setMapLayout, setInfoOpen, inspectorOpen, setInspectorOpen } = useUiStore()
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <header data-help="header" className="flex h-11 shrink-0 items-center gap-3 border-b bg-card pr-1.5 pl-3">
        <Roundel />
        <SimClock />
        <div className="flex-1" />
        <GuideButton />
        <OverflowMenu mobile />
      </header>
    )
  }

  return (
    <header data-help="header" className="flex h-10 shrink-0 items-center gap-4 border-b bg-card pr-2 pl-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Roundel />
        <span className="hidden truncate text-[13px] font-medium min-[960px]:inline">Yonge–University</span>
        <span className="hidden truncate text-xs text-muted-foreground lg:inline">CBTC simulator</span>
      </div>
      <Separator orientation="vertical" className="h-4!" />
      <SimClock />

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        <span data-help="layout" className="inline-flex">
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            value={mapLayout}
            onValueChange={(v) => onLayoutChange(setMapLayout, v)}
            aria-label="Map layout"
          >
            <ToggleGroupItem value="schematic" title="Line diagram, like the TTC map">Schematic</ToggleGroupItem>
            <ToggleGroupItem value="geographic" title="True geography">Map</ToggleGroupItem>
          </ToggleGroup>
        </span>
        <ToggleGroup
          type="multiple"
          variant="outline"
          spacing={0}
          value={[showSafeZones && 'safe-zones', showLabels && 'labels'].filter((v): v is string => Boolean(v))}
          onValueChange={(v) => {
            if (v.includes('safe-zones') !== showSafeZones) toggleSafeZones()
            if (v.includes('labels') !== showLabels) toggleLabels()
          }}
          aria-label="Map overlays"
        >
          <ToggleGroupItem value="safe-zones" data-help="safe-zones" title="Each train's movement authority">Safe zones</ToggleGroupItem>
          <ToggleGroupItem value="labels" data-help="labels" title="Station and train names">Labels</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Separator orientation="vertical" className="h-4!" />

      <div className="flex items-center gap-1">
        <GuideButton />
        <span data-help="info" className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="About" onClick={() => openAbout(setInfoOpen)}>
                <Info />
              </Button>
            </TooltipTrigger>
            <TooltipContent>About this simulator</TooltipContent>
          </Tooltip>
        </span>
        <OverflowMenu />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              <PanelRight />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{inspectorOpen ? 'Hide inspector' : 'Show inspector'}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
