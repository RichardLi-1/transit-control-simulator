/**
 * Sim lifecycle (dev tooling): GET /sim, POST /sim/control.
 * Kept out of api/client.ts on purpose — the deployed sim is shared by every visitor, so only
 * dev mode surfaces these controls.
 */
import { MOCK_MODE } from './client'
import { setMockPaused, setMockSimSpeed } from '../mock/mockData'

/** Last speed the mock was set to (it keeps running at this multiplier while paused). */
let mockSpeed = 1
let mockPaused = false

const BASE = import.meta.env.VITE_API_BASE || ''

export interface SimStatus {
  paused: boolean
  speed: number
  sim_time_s?: number
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSimStatus(): Promise<SimStatus> {
  if (MOCK_MODE) return { paused: mockPaused, speed: mockSpeed }
  return call<SimStatus>('/sim')
}

/** speed = null → pause; otherwise resume at that multiplier. */
export async function setSimSpeed(speed: number | null): Promise<SimStatus> {
  if (MOCK_MODE) {
    // The demo mock honours speed and pause, so the control exercises interpolation offline too.
    mockPaused = speed == null
    if (speed != null) {
      mockSpeed = speed
      setMockSimSpeed(speed)
    }
    setMockPaused(mockPaused)
    return { paused: mockPaused, speed: mockSpeed }
  }
  const body = speed == null ? { action: 'pause' } : { action: 'resume', speed }
  const res = await call<{ ok: boolean; paused: boolean; speed: number }>('/sim/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { paused: res.paused, speed: res.speed }
}
