/** A rejected command, shown over the top of the map for 8 s. */
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useRuntimeStore } from '../store/runtimeStore'
import { Button } from '@/components/ui/button'

export function CommandAlert() {
  const commandError = useRuntimeStore((s) => s.commandError)
  const clear = useRuntimeStore((s) => s.clearCommandError)
  useEffect(() => {
    if (!commandError) return
    const t = window.setTimeout(clear, 8000)
    return () => window.clearTimeout(t)
  }, [commandError, clear])
  if (!commandError) return null
  return (
    <div
      role="alert"
      className="absolute top-3 left-1/2 z-30 flex max-w-[min(520px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-sm border border-danger/50 bg-popover py-1 pr-1 pl-3 text-xs"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-danger" />
      <span className="min-w-0 flex-1">
        <span className="text-danger">Command rejected</span>
        <span className="text-muted-foreground"> · {commandError.replace(/^(\w+ [^:]+): /, '$1 · ')}</span>
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={clear}><X /></Button>
    </div>
  )
}
