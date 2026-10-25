/** Inspector layout atoms: titled sections and key/value rows. */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Section({ title, aside, children, className, ...rest }: {
  title?: string
  /** Right-aligned content in the section head (a value, a status badge). */
  aside?: ReactNode
  children: ReactNode
  className?: string
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('border-b px-3 py-2.5', className)} {...rest}>
      {(title || aside) && (
        <div className="mb-1.5 flex min-h-4 items-center justify-between gap-2">
          {title && <h3 className="micro">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

export function Fields({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('flex flex-col', className)}>{children}</dl>
}

export function Field({ k, children, mono = true, className, title }: {
  k: ReactNode
  children: ReactNode
  /** Value is numeric data: mono with tabular figures. */
  mono?: boolean
  className?: string
  title?: string
}) {
  return (
    <div className="flex h-6 items-center justify-between gap-3 text-xs" title={title}>
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn('min-w-0 truncate text-right text-foreground', mono && 'num text-[11.5px]', className)}>{children}</dd>
    </div>
  )
}

/** Small print under a value: units, targets. */
export function Sub({ children }: { children: ReactNode }) {
  return <span className="text-faint">{children}</span>
}
