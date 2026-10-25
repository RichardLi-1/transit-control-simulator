/**
 * First-visit explainer, anchored to the Guide button. Shows once; dismissal is remembered in
 * localStorage (`?intro=0` suppresses it, e.g. for screenshots).
 */
import { useState, type ReactNode } from 'react'
import { useUiStore } from '../store/uiStore'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

const KEY = 'cbtc-how-it-works-dismissed'

function readDismissed(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('intro') === '0') return true
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function HowItWorks({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => !readDismissed())
  const setGuideOpen = useUiStore((s) => s.setGuideOpen)

  function close() {
    try {
      localStorage.setItem(KEY, '1')
    } catch { /* ignore */ }
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={(v) => { if (!v) close() }}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label="How this works"
        className="w-[min(320px,calc(100vw-16px))] gap-0 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ul className="flex flex-col gap-1.5 px-3 pt-3 pb-2.5 text-xs leading-relaxed text-muted-foreground">
          <li><span className="text-foreground">TTC Line 1 under simulated CBTC.</span> Each train may only run to the end of its movement authority.</li>
          <li>Click a train to inspect it and hold, express or skip a stop. Click a signal to change it.</li>
          <li>Drag to pan, scroll to zoom, <Kbd>0</Kbd> to fit.</li>
        </ul>
        <div className="flex justify-end gap-1.5 border-t px-2 py-2">
          <Button variant="ghost" size="xs" onClick={() => { close(); setGuideOpen(true) }}>Ask the guide</Button>
          <Button size="xs" onClick={close}>Got it</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
