/** m:ss for headways and countdowns. */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const SERVICE_START_SEC = 6 * 3600

/** Sim seconds since start → HH:MM:SS service clock (service starts 06:00). */
export function fmtSimClock(simT: number | null | undefined): string {
  if (simT == null || !Number.isFinite(simT)) return '--:--:--'
  const total = Math.max(0, Math.floor(SERVICE_START_SEC + simT))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** 840 m, 1.2 km, 12 km. */
export function fmtDist(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.round(m)} m`
}
