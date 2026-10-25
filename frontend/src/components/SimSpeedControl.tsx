/**
 * Dev-mode sim speed control (pause / 1× / 2× / 5× / 10×). Dev only: the deployed sim is shared
 * by every visitor. Reads sim_speed/paused from /state when present, else polls GET /sim.
 */
import { useEffect, useState } from 'react'
import posthog from 'posthog-js'
import { Pause } from 'lucide-react'
import { useRuntimeStore } from '../store/runtimeStore'
import { fetchSimStatus, setSimSpeed, type SimStatus } from '../api/sim'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const SPEEDS = [1, 2, 5, 10] as const
type Choice = 'pause' | '1' | '2' | '5' | '10'

export function SimSpeedControl() {
  const rtSpeed = useRuntimeStore((s) => s.runtime?.sim_speed)
  const rtPaused = useRuntimeStore((s) => s.runtime?.paused)
  const [polled, setPolled] = useState<SimStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (rtSpeed != null) return
    let cancelled = false
    const tick = () => {
      fetchSimStatus().then((s) => { if (!cancelled) setPolled(s) }).catch(() => { /* backend down */ })
    }
    tick()
    const id = window.setInterval(tick, 3000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [rtSpeed])

  const paused = rtPaused ?? polled?.paused ?? false
  const speed = rtSpeed ?? polled?.speed ?? 1
  const value: Choice = paused ? 'pause' : (String(SPEEDS.find((s) => Math.abs(s - speed) < 0.01) ?? 1) as Choice)

  async function choose(c: Choice) {
    setError(null)
    try {
      const next = await setSimSpeed(c === 'pause' ? null : Number(c))
      setPolled(next)
      posthog.capture('sim_speed_changed', { speed: c })
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div className="flex items-center gap-1.5" title={error ?? 'Sim speed (dev mode only)'}>
      <span className="micro">Speed</span>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0}
        value={value}
        onValueChange={(c) => { if (c) void choose(c as Choice) }}
        aria-label="Sim speed"
      >
        <ToggleGroupItem value="pause" aria-label="Pause" className="h-5 min-w-5 px-1.5"><Pause className="size-3" /></ToggleGroupItem>
        {SPEEDS.map((s) => (
          <ToggleGroupItem key={s} value={String(s)} aria-label={`${s}× real time`} className="num h-5 min-w-5 px-1.5 text-[11px]">
            {s}×
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
