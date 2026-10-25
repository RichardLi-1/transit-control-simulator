import { useEffect, useState } from 'react'
import type { HelpTargetId } from '../help/guide'
import { HELP_TARGETS } from '../help/guide'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Outlines the `[data-help=<target>]` element GUIDE is talking about, with a small caption. */
export function HelpPointer({ target }: { target: HelpTargetId | null }) {
  const [box, setBox] = useState<Box | null>(null)

  useEffect(() => {
    if (!target) {
      setBox(null)
      return
    }
    const measure = () => {
      const el = document.querySelector(`[data-help="${target}"]`)
      if (!el) {
        setBox(null)
        return
      }
      const r = el.getBoundingClientRect()
      setBox({ left: r.left, top: r.top, width: r.width, height: r.height })
    }
    measure()
    window.addEventListener('resize', measure)
    const id = window.setInterval(measure, 400)
    return () => {
      window.removeEventListener('resize', measure)
      window.clearInterval(id)
    }
  }, [target])

  if (!target || !box || box.width < 2 || box.height < 2) return null

  const label = HELP_TARGETS.find((t) => t.id === target)?.label ?? target
  const pad = 3
  const left = Math.max(2, box.left - pad)
  const top = Math.max(2, box.top - pad)
  const width = Math.min(window.innerWidth - left - 2, box.width + pad * 2)
  const height = Math.min(window.innerHeight - top - 2, box.height + pad * 2)
  // Large regions (the map, a panel) get the caption inside their top-left corner.
  const inside = height > 160 && width > 160
  const below = top + height + 24 <= window.innerHeight
  const captionTop = inside ? top + 6 : below ? top + height + 4 : Math.max(2, top - 22)
  const captionLeft = inside ? left + 6 : Math.min(left, window.innerWidth - 160)

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-40">
      <div
        className="absolute rounded-sm border-2 border-highlight transition-[left,top,width,height] duration-150"
        style={{ left, top, width, height }}
      />
      <div
        className="absolute rounded-xs bg-highlight px-1.5 py-0.5 text-[11px] leading-4 font-medium text-background"
        style={{ left: captionLeft, top: captionTop }}
      >
        {label.charAt(0).toUpperCase() + label.slice(1)}
      </div>
    </div>
  )
}
