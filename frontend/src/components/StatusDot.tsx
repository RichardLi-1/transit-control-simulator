import { cn } from '@/lib/utils'

export type LinkTone = 'ok' | 'caution' | 'danger' | 'off'

const DOT_TONE: Record<LinkTone, string> = {
  ok: 'bg-ok',
  caution: 'bg-caution',
  danger: 'bg-danger',
  off: 'bg-faint',
}

export function StatusDot({ tone, className }: { tone: LinkTone; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT_TONE[tone], className)} />
}
