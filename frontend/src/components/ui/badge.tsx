import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/** Squared status tag. Only for genuine state (live, held, shield, dev), never decoration. */
const badgeVariants = cva(
  "inline-flex h-[18px] w-fit shrink-0 items-center justify-center gap-1 rounded-xs border px-1.5 font-mono text-[10px] leading-none font-medium tracking-wide whitespace-nowrap uppercase [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        neutral: "border-border-strong text-muted-foreground",
        ok: "border-ok/40 bg-ok/10 text-ok",
        caution: "border-caution/40 bg-caution/10 text-caution",
        danger: "border-danger/40 bg-danger/10 text-danger",
        info: "border-info/40 bg-info/10 text-info",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  }
)

function Badge({
  className,
  variant = "neutral",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
