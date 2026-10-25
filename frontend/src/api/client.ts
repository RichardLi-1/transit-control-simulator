import posthog from 'posthog-js'
import type {
  Topology,
  RuntimeState,
  SwitchState,
  SignalAspect,
  DispatchAction,
  TrainingStatus,
  TrainingSettings,
  DispatchComparison,
  DispatchPolicyInfo,
} from '../types/domain'
import { isMlEnabled } from '../config/ml'
import { MOCK_TOPOLOGY, mockCommandTrain, tickMockRuntime } from '../mock/mockData'
import { useConnectionStore } from '../store/connectionStore'

const BASE = import.meta.env.VITE_API_BASE || ''   // proxied by Vite dev server
const ML_BASE = import.meta.env.VITE_ML_BASE || ''  // proxied by Vite dev server to :8001
const TIMEOUT_MS = 4000
const RETRY_DELAYS = [500, 1000, 2000]   // ms between retries

function baseFor(path: string): string {
  return path.startsWith('/ml') ? ML_BASE : BASE
}

// Set to true to skip real API calls entirely
export let MOCK_MODE = false

export function enableMockMode() {
  MOCK_MODE = true
  useConnectionStore.getState().setMockMode(true)
  posthog.capture('simulation_mock_mode_enabled')
}
export function disableMockMode() {
  MOCK_MODE = false
  useConnectionStore.getState().setMockMode(false)
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, opts?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseFor(path)}${path}`, { ...opts, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i <= RETRY_DELAYS.length; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (i < RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[i]))
      }
    }
  }
  throw last
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Dev: `?mock=1` forces the built-in mock service even when a backend is reachable. */
function mockRequestedByUrl(): boolean {
  try {
    return import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1'
  } catch {
    return false
  }
}

export async function fetchTopology(): Promise<Topology> {
  if (!MOCK_MODE && mockRequestedByUrl()) enableMockMode()
  if (MOCK_MODE) return MOCK_TOPOLOGY
  try {
    const result = await withRetry(() => apiFetch<Topology>('/topology'))
    useConnectionStore.getState().report('topology', 'ok')
    return result
  } catch (err) {
    useConnectionStore.getState().report('topology', 'error', String(err))
    console.warn('[api] /topology failed, falling back to mock')
    enableMockMode()
    return MOCK_TOPOLOGY
  }
}

let _lastMockTick = performance.now()

export async function fetchState(): Promise<RuntimeState> {
  if (MOCK_MODE) {
    const now = performance.now()
    const dt = now - _lastMockTick
    _lastMockTick = now
    return tickMockRuntime(dt)
  }
  try {
    const result = await withRetry(() => apiFetch<RuntimeState>('/state'))
    useConnectionStore.getState().report('state', 'ok')
    return result
  } catch (err) {
    useConnectionStore.getState().report('state', 'error', String(err))
    throw err
  }
}

export async function commandSwitch(switchId: string, state: SwitchState): Promise<void> {
  if (MOCK_MODE) return
  try {
    await apiFetch(`/commands/switch/${switchId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    useConnectionStore.getState().report('commands', 'ok')
    posthog.capture('switch_commanded', { switch_id: switchId, state })
  } catch (err) {
    useConnectionStore.getState().report('commands', 'error', String(err))
    posthog.captureException(err instanceof Error ? err : new Error(String(err)), { switch_id: switchId, state })
    throw err
  }
}

export interface InjectEventRequest {
  kind: string
  duration_s?: number
  starts_in_s?: number
  target_train_id?: string
  target_signal_id?: string
  target_switch_id?: string
  speed_limit_kph?: number
  note?: string
}

export async function injectEvent(body: InjectEventRequest): Promise<{ ok: boolean; event: { id: string } }> {
  if (MOCK_MODE) return { ok: true, event: { id: `mock_${Date.now()}` } }
  return apiFetch('/events/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function cancelEvent(eventId: string): Promise<void> {
  if (MOCK_MODE) return
  await apiFetch(`/events/${eventId}`, { method: 'DELETE' })
  posthog.capture('event_cancelled', { event_id: eventId })
}

export async function commandTrain(trainId: string, action: DispatchAction, count = 1): Promise<void> {
  if (MOCK_MODE) {
    mockCommandTrain(trainId, action, count)
    return
  }
  try {
    await apiFetch(`/commands/train/${trainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, count }),
    })
    useConnectionStore.getState().report('commands', 'ok')
    posthog.capture('train_dispatch_commanded', { train_id: trainId, action, count })
  } catch (err) {
    useConnectionStore.getState().report('commands', 'error', String(err))
    posthog.captureException(err instanceof Error ? err : new Error(String(err)), { train_id: trainId, action })
    throw err
  }
}

export async function commandSignal(signalId: string, aspect: SignalAspect): Promise<void> {
  if (MOCK_MODE) return
  try {
    await apiFetch(`/commands/signal/${signalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aspect }),
    })
    useConnectionStore.getState().report('commands', 'ok')
    posthog.capture('signal_commanded', { signal_id: signalId, aspect })
  } catch (err) {
    useConnectionStore.getState().report('commands', 'error', String(err))
    posthog.captureException(err instanceof Error ? err : new Error(String(err)), { signal_id: signalId, aspect })
    throw err
  }
}

// ── ML API (requires ML service on :8001 or VITE_ML_BASE) ───────────────────

export async function fetchMlHealth(): Promise<{ ok: boolean }> {
  if (MOCK_MODE || !isMlEnabled()) return { ok: false }
  // Single ping. App.tsx keeps retrying — ML (torch) can take ~30s to bind :8001.
  return apiFetch<{ ok: boolean }>('/ml/health')
}

export async function fetchTrainingStatus(): Promise<TrainingStatus> {
  if (MOCK_MODE || !isMlEnabled()) return { status: 'idle', running: false }
  return withRetry(() => apiFetch<TrainingStatus>('/ml/training/status'))
}

export async function startTraining(settings: TrainingSettings): Promise<TrainingStatus> {
  if (!isMlEnabled()) throw new Error('ML disabled (set VITE_ML_ENABLED=true and VITE_ML_BASE in production)')
  if (MOCK_MODE) {
    return { status: 'running', running: true, completed_timesteps: 0, total_timesteps: 2048 }
  }
  return apiFetch<TrainingStatus>('/ml/training/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export async function stopTraining(): Promise<TrainingStatus> {
  if (MOCK_MODE) return { status: 'stopped', running: false }
  return apiFetch<TrainingStatus>('/ml/training/stop', { method: 'POST' })
}

export async function fetchDispatchPolicy(): Promise<DispatchPolicyInfo> {
  if (!isMlEnabled() || MOCK_MODE) {
    return { path: 'mock', exists: false, size_bytes: 0 }
  }
  return apiFetch<DispatchPolicyInfo>('/ml/dispatch/policy')
}

export async function fetchDispatchComparison(): Promise<DispatchComparison> {
  if (!isMlEnabled() || MOCK_MODE) throw new Error('ML disabled or mock mode')
  return apiFetch<DispatchComparison>('/ml/dispatch/comparison')
}

export type LiveDispatchMode = 'rule' | 'ppo'

export async function fetchLiveDispatchPolicy(): Promise<{ policy_mode: LiveDispatchMode; policy_ready?: boolean }> {
  if (MOCK_MODE) return { policy_mode: 'rule', policy_ready: false }
  return apiFetch('/ops/dispatch/policy')
}

export async function setLiveDispatchPolicy(mode: LiveDispatchMode): Promise<void> {
  if (MOCK_MODE) return
  await apiFetch('/ops/dispatch/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
}

export async function runDispatchCompare(body?: { episodes?: number; seed?: number }): Promise<DispatchComparison> {
  if (!isMlEnabled()) throw new Error('ML disabled (set VITE_ML_ENABLED=true and VITE_ML_BASE in production)')
  if (MOCK_MODE) {
    return {
      seed: 42,
      episodes: 5,
      policy_path: 'mock',
      rule_based: {
        delay_mean_sec: 36,
        delay_p95_sec: 78,
        headway_std_mean_sec: 1933,
        unsafe_action_rate: 0.19,
        episodes: 5,
      },
      ppo: {
        delay_mean_sec: 32,
        delay_p95_sec: 70,
        headway_std_mean_sec: 1800,
        unsafe_action_rate: 0.15,
        episodes: 5,
      },
      delta_pct: { delay_mean_sec_pct_vs_rule: 11.1 },
    }
  }
  return apiFetch<DispatchComparison>('/ml/dispatch/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}
