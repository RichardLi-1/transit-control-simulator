/**
 * GUIDE: answers questions about the board and points at the part of the screen it is talking
 * about. Desktop: a docked column beside the inspector. Phone: a non-modal bottom sheet.
 */
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { ArrowUp, X } from 'lucide-react'
import { askHelp, type HelpMessage } from '../help/ask'
import type { HelpTargetId } from '../help/guide'
import { useEventsStore } from '../store/eventsStore'
import { useUiStore } from '../store/uiStore'
import { useIsMobile } from '../hooks/useIsMobile'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { HelpPointer } from './HelpPointer'

const STARTERS = ['Where is run 4?', 'What do the colours mean?', 'How do I hold a train?', 'What is dispatch?']

const INTRO: HelpMessage = {
  role: 'assistant',
  text: 'Ask what anything on the board means, or where a train is. I’ll highlight it on screen.',
}

/** Conversation outlives the panel being closed. */
const useGuideStore = create<{
  messages: HelpMessage[]
  busy: boolean
  point: HelpTargetId | null
  set: (patch: Partial<{ messages: HelpMessage[]; busy: boolean; point: HelpTargetId | null }>) => void
}>((set) => ({ messages: [INTRO], busy: false, point: null, set }))

/** Make the target visible before pointing at it (tabs, popovers). */
function reveal(target: HelpTargetId | null) {
  const ui = useUiStore.getState()
  if (target === 'events' || target === 'inject') {
    ui.openInspector('events')
    if (target === 'inject') useEventsStore.getState().setInjectOpen(true)
  }
  if (target === 'dispatch') ui.openInspector('dispatch')
  if (target === 'legend') ui.setLegendOpen(true)
}

async function send(text: string) {
  const g = useGuideStore.getState()
  const q = text.trim()
  if (!q || g.busy) return
  const history = [...g.messages, { role: 'user' as const, text: q }]
  g.set({ messages: history, busy: true })
  try {
    const { reply, point } = await askHelp(q, history)
    useGuideStore.getState().set({ messages: [...history, { role: 'assistant', text: reply }], point })
    reveal(point)
  } finally {
    useGuideStore.getState().set({ busy: false })
  }
}

function Transcript() {
  const messages = useGuideStore((s) => s.messages)
  const busy = useGuideStore((s) => s.busy)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, busy])

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 px-3 py-3">
        {messages.map((m, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            {i > 0 && <span className="micro">{m.role === 'user' ? 'You' : 'Guide'}</span>}
            <p className={m.role === 'user' ? 'text-xs text-foreground' : 'text-xs leading-relaxed text-muted-foreground'}>{m.text}</p>
          </div>
        ))}
        {busy && <p className="text-xs text-faint">Thinking…</p>}
        {messages.length === 1 && !busy && (
          <ul className="flex flex-col border-t pt-1">
            {STARTERS.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => void send(s)}
                  className="flex h-7 w-full items-center text-left text-xs text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  )
}

function Composer({ autoFocus }: { autoFocus?: boolean }) {
  const [input, setInput] = useState('')
  const busy = useGuideStore((s) => s.busy)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const q = input
        setInput('')
        void send(q)
      }}
      className="flex shrink-0 gap-1.5 border-t p-2"
    >
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Ask about the board"
        aria-label="Ask the guide"
        autoFocus={autoFocus}
        className="h-8"
      />
      <Button type="submit" size="icon" variant="secondary" aria-label="Send" disabled={busy || !input.trim()}>
        <ArrowUp />
      </Button>
    </form>
  )
}

/** Desktop column body. */
function GuidePanel({ onClose }: { onClose: () => void }) {
  return (
    <section aria-label="Guide" className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b pr-1.5 pl-3">
        <h2 className="text-xs font-medium">Guide</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close guide" onClick={onClose}><X /></Button>
      </header>
      <Transcript />
      <Composer autoFocus />
    </section>
  )
}

/** Pointer overlay; mounted always so a highlight survives the panel closing. */
export function GuidePointer() {
  const point = useGuideStore((s) => s.point)
  const setPoint = (p: HelpTargetId | null) => useGuideStore.getState().set({ point: p })
  useEffect(() => {
    if (!point) return
    const t = window.setTimeout(() => setPoint(null), 10_000)
    return () => window.clearTimeout(t)
  }, [point])
  return <HelpPointer target={point} />
}

/** Desktop: render inside the layout column. Phone: renders its own sheet. */
export function HelpChat() {
  const open = useUiStore((s) => s.guideOpen)
  const setOpen = useUiStore((s) => s.setGuideOpen)
  const isMobile = useIsMobile()

  if (!isMobile) return open ? <GuidePanel onClose={() => setOpen(false)} /> : null

  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetContent
        side="bottom"
        overlay={false}
        className="gap-0 p-0 data-[side=bottom]:h-[55dvh]"
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex h-9 shrink-0 items-center border-b pr-10 pl-3">
          <SheetTitle className="text-xs font-medium">Guide</SheetTitle>
          <SheetDescription className="sr-only">Ask about anything on the board.</SheetDescription>
        </div>
        <Transcript />
        <Composer />
      </SheetContent>
    </Sheet>
  )
}
