/**
 * Developer endpoint diagnostics (dev mode, Ctrl+Shift+D): one dot per API in the status bar,
 * with the failing endpoints and how to start them in a popover.
 */
import { X } from 'lucide-react'
import { useConnectionStore, type EndpointKey } from '../store/connectionStore'
import { isMlEnabled } from '../config/ml'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusDot } from './StatusDot'

const HINTS: Record<EndpointKey, string> = {
  topology: 'Start the backend: cd backend && ./venv/bin/uvicorn main:app --reload --port 8000 (or npm run dev from the repo root).',
  state:    'Same as /topology. The Vite dev server must be running so /state proxies to :8000.',
  commands: 'POST /commands/*. Clicks only affect the sim while the backend is up.',
  ml:       'Start the ML API: npm run dev (includes :8001) or cd ml && python -m rlcbtc.cli.serve_training. Production: set VITE_ML_BASE.',
}

const ENDPOINTS: EndpointKey[] = ['topology', 'state', 'commands', 'ml']

export function EndpointHealth() {
  const { endpoints, dismissError } = useConnectionStore()
  const eps = ENDPOINTS.filter((ep) => ep !== 'ml' || isMlEnabled())
  const errors = eps.filter((ep) => endpoints[ep].health === 'error' && endpoints[ep].error != null)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-5 items-center gap-1 rounded-xs px-1 hover:bg-accent" aria-label="Endpoint health">
          {eps.map((ep) => {
            const h = endpoints[ep].health
            return <StatusDot key={ep} tone={h === 'ok' ? 'ok' : h === 'error' ? 'danger' : 'off'} />
          })}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-96 gap-0 p-0 text-xs">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="font-medium">Endpoints</span>
          <Badge variant="caution">Dev</Badge>
        </div>
        <ul className="divide-y">
          {eps.map((ep) => {
            const info = endpoints[ep]
            const tone = info.health === 'ok' ? 'ok' : info.health === 'error' ? 'danger' : 'off'
            return (
              <li key={ep} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center gap-2">
                  <StatusDot tone={tone} />
                  <span className="num">/{ep}</span>
                  <span className="text-muted-foreground">{info.health}</span>
                  {errors.includes(ep) && (
                    <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={`Dismiss /${ep} error`} onClick={() => dismissError(ep)}>
                      <X />
                    </Button>
                  )}
                </div>
                {errors.includes(ep) && (
                  <>
                    <p className="num text-[11px] break-all text-caution">{info.error}</p>
                    <p className="text-muted-foreground">{HINTS[ep]}</p>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
