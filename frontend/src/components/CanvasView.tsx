import { useEffect, useRef, useCallback, useState } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { useTopologyStore } from '../store/topologyStore'
import { useRuntimeStore } from '../store/runtimeStore'
import { Viewport } from '../render/Viewport'
import { renderTrackLayer } from '../render/layers/TrackLayer'
import { renderSwitchLayer, switchHitAreas } from '../render/layers/SwitchLayer'
import { renderSignalLayer, signalHitAreas } from '../render/layers/SignalLayer'
import { pickHitArea } from '../render/hit'
import { renderTrainLayer, hitTestTrains } from '../render/layers/TrainLayer'
import { renderLabelLayer } from '../render/layers/LabelLayer'
import { COLORS } from '../constants/colors'
import { canvasFont } from '../constants/theme'
import type { HoveredEntity, SwitchState, Topology } from '../types/domain'
import { MapHoverCard } from './MapHoverCard'
import { motion } from '../motion/engine'
import { debugAfterFrame, installMotionDebug } from '../motion/debug'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Kbd } from '@/components/ui/kbd'

// Shared viewport instance — lives outside React so the rAF loop can close over it
const vp = new Viewport()

/** Re-run hover hit-testing this often while the pointer rests (trains move under it). */
const HOVER_REFRESH_MS = 120

/**
 * Hit-test against what was drawn: trains use the interpolated frame; signals and switches use the
 * glyph geometry their layers draw with (render/hit capsules), so a click lands on what is visible.
 */
function hitTest(sx: number, sy: number, topology: Topology): HoveredEntity | null {
  const trainId = hitTestTrains(motion.frame, sx, sy)
  if (trainId) return { kind: 'train', id: trainId, screenX: sx, screenY: sy }
  const sig = pickHitArea(signalHitAreas(vp, topology), sx, sy)
  if (sig) return { kind: 'signal', id: sig, screenX: sx, screenY: sy }
  const sw = pickHitArea(switchHitAreas(vp, topology), sx, sy)
  if (sw) return { kind: 'switch', id: sw, screenX: sx, screenY: sy }
  return null
}

const sameHit = (a: HoveredEntity | null, b: HoveredEntity | null) => (a?.kind === b?.kind && a?.id === b?.id)

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const flashRef = useRef(false)
  const flashTimerRef = useRef(0)

  // Drag state (not in React state — avoids re-renders during pan)
  const dragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  /** Pointer position over the canvas (canvas coords) or null when outside. */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  // Touch state — single-finger pan + two-finger pinch zoom (mobile)
  const lastTouch = useRef({ x: 0, y: 0 })
  const pinchDist = useRef(0)
  const touchMoved = useRef(false)

  const [hovered, setHoveredState] = useState<HoveredEntity | null>(null)
  const hoveredRef = useRef<HoveredEntity | null>(null)
  /** Switch throw awaiting confirmation. */
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string; from: SwitchState; to: SwitchState } | null>(null)
  /** Until the operator pans or zooms, the map re-fits whenever its area changes size. */
  const userMoved = useRef(false)

  const topology = useTopologyStore((s) => s.topology)
  const storeSetHovered = useRuntimeStore((s) => s.setHovered)
  const selectedTrainId = useRuntimeStore((s) => s.selectedTrainId)
  const setSelectedTrain = useRuntimeStore((s) => s.setSelectedTrain)
  const sendSwitchCommand = useRuntimeStore((s) => s.sendSwitchCommand)
  const sendSignalCommand = useRuntimeStore((s) => s.sendSignalCommand)
  const hasRuntime = useRuntimeStore((s) => s.runtime != null)

  const setHovered = useCallback((hit: HoveredEntity | null) => {
    hoveredRef.current = hit
    setHoveredState(hit)
    storeSetHovered(hit)
  }, [storeSetHovered])

  useEffect(() => { installMotionDebug() }, [])

  // Fit viewport when topology first loads (or the layout changes)
  useEffect(() => {
    if (!topology) return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    vp.resize(w, h)
    vp.fitToBounds({
      minX: topology.bounds.min_x,
      minY: topology.bounds.min_y,
      maxX: topology.bounds.max_x,
      maxY: topology.bounds.max_y,
    })
    userMoved.current = false
  }, [topology])

  // Canvas resize observer — scale by devicePixelRatio to prevent blur on Retina displays
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      vp.resize(w, h)
      // Panels opening/closing resize the map: keep the whole line in view until the operator takes over.
      const topo = useTopologyStore.getState().topology
      if (topo && !userMoved.current && w > 0 && h > 0) {
        vp.fitToBounds({ minX: topo.bounds.min_x, minY: topo.bounds.min_y, maxX: topo.bounds.max_x, maxY: topo.bounds.max_y })
      }
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // rAF render loop — reads Zustand stores directly, never triggers React re-renders
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let lastHoverCheck = 0
    let lastErrorLog = 0

    const draw = () => {
      const now = performance.now()
      const { topology } = useTopologyStore.getState()
      const { runtime, showSafeZones, showLabels, selectedTrainId } = useRuntimeStore.getState()

      // Flash phase toggles ~2Hz
      flashTimerRef.current += 16
      if (flashTimerRef.current >= 500) {
        flashRef.current = !flashRef.current
        flashTimerRef.current = 0
      }

      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
      ctx.fillStyle = COLORS.BACKGROUND
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight)

      if (!topology) {
        ctx.fillStyle = COLORS.TEXT_2
        ctx.font = canvasFont(13, 500)
        ctx.fillText('Loading topology…', 20, 40)
        return
      }

      // One interpolation per frame, shared by drawing and hit-testing.
      const frame = motion.computeFrame(topology, now)

      renderTrackLayer(ctx, vp, topology)
      // Station platforms render under signals/switches/trains so the icons sit on top.
      renderLabelLayer(ctx, vp, topology, showLabels)
      if (runtime) {
        renderSwitchLayer(ctx, vp, topology, runtime)
        renderSignalLayer(ctx, vp, topology, runtime, flashRef.current)
      }
      const hov = hoveredRef.current
      renderTrainLayer(ctx, vp, topology, runtime, frame, {
        showSafeZones,
        showLabels,
        hoveredId: hov?.kind === 'train' ? hov.id : null,
        selectedId: selectedTrainId,
      })
      debugAfterFrame(frame)

      // Trains move under a resting pointer: keep hover in sync with what's drawn.
      const p = pointer.current
      if (p && !dragging.current && now - lastHoverCheck > HOVER_REFRESH_MS) {
        lastHoverCheck = now
        const prev = hoveredRef.current
        const hit = hitTest(p.x, p.y, topology)
        if (!sameHit(hit, prev)) setHovered(hit)
      }
    }

    // A throw in any layer must never stop the loop: log (throttled) and draw the next frame.
    const render = () => {
      try {
        draw()
      } catch (err) {
        const t = performance.now()
        if (t - lastErrorLog > 5000) {
          lastErrorLog = t
          console.error('map frame failed', err)
        }
      } finally {
        animRef.current = requestAnimationFrame(render)
      }
    }

    animRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animRef.current)
  }, [setHovered]) // loop reads stores directly

  // ── Pointer events ──────────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    pointer.current = { x: sx, y: sy }
    if (dragging.current) {
      const dx = e.clientX - lastMouse.current.x
      const dy = e.clientY - lastMouse.current.y
      vp.pan(dx, dy)
      if (dx !== 0 || dy !== 0) userMoved.current = true
      lastMouse.current = { x: e.clientX, y: e.clientY }
      if (hoveredRef.current) setHovered(null)
    } else {
      const topo = useTopologyStore.getState().topology
      if (!topo) return
      const hit = hitTest(sx, sy, topo)
      if (!sameHit(hit, hoveredRef.current) || (hit && hoveredRef.current && Math.hypot(hit.screenX - hoveredRef.current.screenX, hit.screenY - hoveredRef.current.screenY) > 24)) {
        setHovered(hit)
      }
    }
  }, [setHovered])

  const onMouseUp = useCallback(() => { dragging.current = false }, [])
  const onMouseLeave = useCallback(() => {
    dragging.current = false
    pointer.current = null
    setHovered(null)
  }, [setHovered])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    vp.zoomAtPoint(factor, sx, sy)
    userMoved.current = true
  }, [])

  const onClick = useCallback((e: React.MouseEvent) => {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) return  // was a mouse drag
    if (touchMoved.current) { touchMoved.current = false; return }  // was a touch pan/pinch
    const topo = useTopologyStore.getState().topology
    const rt = useRuntimeStore.getState().runtime
    if (!topo || !rt) return
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const hit = hitTest(sx, sy, topo)
    if (!hit) { setSelectedTrain(null); return }

    if (hit.kind === 'train') {
      setSelectedTrain(hit.id)
    }

    if (hit.kind === 'switch') {
      const current = rt.switches.find(s => s.switch_id === hit.id)?.state ?? 'normal'
      const next = current === 'normal' ? 'reverse' : 'normal'
      setPendingSwitch({ id: hit.id, from: current, to: next })
    }

    if (hit.kind === 'signal') {
      const current = rt.signals.find(s => s.signal_id === hit.id)?.aspect ?? 'green'
      const aspects = ['green', 'yellow', 'red'] as const
      const i = aspects.indexOf(current as typeof aspects[number])
      const next = aspects[i < 0 ? 0 : (i + 1) % aspects.length]
      sendSignalCommand(hit.id, next)
    }
  }, [setSelectedTrain, sendSignalCommand])

  // ── Touch events (mobile): 1 finger pans, 2 fingers pinch-zoom ───────────
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    setHovered(null)
    pointer.current = null
    touchMoved.current = false
    if (e.touches.length === 1) {
      lastTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      pinchDist.current = Math.hypot(dx, dy)
    }
  }, [setHovered])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    touchMoved.current = true
    userMoved.current = true
    if (e.touches.length === 1) {
      const t = e.touches[0]
      vp.pan(t.clientX - lastTouch.current.x, t.clientY - lastTouch.current.y)
      lastTouch.current = { x: t.clientX, y: t.clientY }
    } else if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (pinchDist.current > 0) {
        const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
        const midX = (a.clientX + b.clientX) / 2 - rect.left
        const midY = (a.clientY + b.clientY) / 2 - rect.top
        vp.zoomAtPoint(dist / pinchDist.current, midX, midY)
      }
      pinchDist.current = dist
    }
  }, [])

  const onTouchEnd = useCallback(() => { pinchDist.current = 0 }, [])

  const fitMap = useCallback(() => {
    const topo = useTopologyStore.getState().topology
    if (!topo) return
    vp.fitToBounds({
      minX: topo.bounds.min_x,
      minY: topo.bounds.min_y,
      maxX: topo.bounds.max_x,
      maxY: topo.bounds.max_y,
    })
    userMoved.current = false
  }, [])

  const zoomBy = useCallback((factor: number) => {
    vp.zoomAtPoint(factor, vp.width / 2, vp.height / 2)
    userMoved.current = true
  }, [])

  // Double-click: fit to bounds
  const onDoubleClick = fitMap

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return
      }
      if (e.key === '+' || e.key === '=' || e.key === 'Add') {
        e.preventDefault()
        zoomBy(1.25)
      } else if (e.key === '-' || e.key === '_' || e.key === 'Subtract') {
        e.preventDefault()
        zoomBy(1 / 1.25)
      } else if (e.key === '0' || e.key === 'Home') {
        e.preventDefault()
        fitMap()
      } else if (e.key === 'Escape') {
        setSelectedTrain(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomBy, fitMap, setSelectedTrain])

  const showHover = hovered && topology && hasRuntime && !(hovered.kind === 'train' && hovered.id === selectedTrainId)

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: hovered ? 'pointer' : 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onWheel={onWheel}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      />
      {showHover && <MapHoverCard hovered={hovered} bounds={{ w: vp.width, h: vp.height }} />}
      <div
        data-help="zoom"
        role="group"
        aria-label="Zoom"
        className="absolute right-3 bottom-3 z-20 flex flex-col overflow-hidden rounded-md border border-border-strong bg-card"
      >
        <ZoomButton label="Zoom in" keys="+" onClick={() => zoomBy(1.25)}><Plus /></ZoomButton>
        <ZoomButton label="Zoom out" keys="−" onClick={() => zoomBy(1 / 1.25)}><Minus /></ZoomButton>
        <ZoomButton label="Fit line" keys="0" onClick={fitMap}><Maximize /></ZoomButton>
      </div>
      <AlertDialog open={pendingSwitch != null} onOpenChange={(open) => { if (!open) setPendingSwitch(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Throw switch {pendingSwitch?.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              Points move from <span className="text-foreground">{pendingSwitch?.from}</span> to{' '}
              <span className="text-foreground">{pendingSwitch?.to}</span>. Routes over it are re-checked by the interlocking.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              onClick={() => { if (pendingSwitch) void sendSwitchCommand(pendingSwitch.id, pendingSwitch.to) }}
            >
              Throw to {pendingSwitch?.to}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ZoomButton({ label, keys, onClick, children }: { label: string; keys: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          className="rounded-none text-foreground not-last:border-b not-last:border-border [&_svg:not([class*='size-'])]:size-3.5"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {label} <Kbd>{keys}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
