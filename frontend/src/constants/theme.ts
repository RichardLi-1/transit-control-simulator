/**
 * Canvas type tokens. DOM chrome takes its fonts from the Tailwind theme (styles/app.css), which
 * names the same two families, so map labels and panels match.
 */

export const FONT = {
  /** UI + map labels. */
  ui: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  /** Clocks, ids, numbers — tabular figures. */
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const

/** Canvas font string, e.g. canvasFont(12, 500) → "500 12px 'IBM Plex Sans', …". */
export function canvasFont(px: number, weight: number | string = 500, family: string = FONT.ui): string {
  return `${weight} ${px}px ${family}`
}
