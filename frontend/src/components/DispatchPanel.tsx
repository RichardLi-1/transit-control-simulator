/**
 * Inspector → Dispatch: service level, yard departures, the live dispatch policy (rule-based or
 * PPO) and, when the ML service is reachable, an offline A/B comparison of the two.
 */
import { useCallback, useEffect, useState } from 'react'
import posthog from 'posthog-js'
import {
  fetchDispatchPolicy,
  fetchLiveDispatchPolicy,
  runDispatchCompare,
  setLiveDispatchPolicy,
  type LiveDispatchMode,
} from '../api/client'
import { useRuntimeStore } from '../store/runtimeStore'
import { useConnectionStore } from '../store/connectionStore'
import type { DispatchComparison } from '../types/domain'
import { isMlEnabled } from '../config/ml'
import { fmtDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, Fields, Section, Sub } from './Readouts'
import { StatusDot } from './StatusDot'

function fmt(n: number | undefined, digits = 1) {
  return n != null && Number.isFinite(n) ? n.toFixed(digits) : '—'
}

function pct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`
}

/** delta_pct is (rule − ppo) / rule, i.e. positive = PPO lower = better on every metric here. */
function deltaTone(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) < 0.05) return 'text-muted-foreground'
  return n > 0 ? 'text-ok' : 'text-danger'
}

export function DispatchPanel() {
  const mlOn = isMlEnabled()
  const mlHealth = useConnectionStore((s) => s.endpoints.ml.health)
  const mockMode = useConnectionStore((s) => s.mockMode)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [policyReady, setPolicyReady] = useState<boolean | null>(null)
  const [data, setData] = useState<DispatchComparison | null>(null)
  const [livePolicy, setLivePolicy] = useState<LiveDispatchMode>('rule')
  const [policySwitchError, setPolicySwitchError] = useState<string | null>(null)
  const dispatch = useRuntimeStore((s) => s.runtime?.ops?.dispatch)
  const service = useRuntimeStore((s) => s.runtime?.ops?.service)
  const trainCount = useRuntimeStore((s) => s.runtime?.trains.length ?? null)

  const mlOffline = !mlOn || mockMode || mlHealth === 'error' || policyReady === false

  const applyLivePolicy = useCallback(async (mode: LiveDispatchMode) => {
    setPolicySwitchError(null)
    try {
      await setLiveDispatchPolicy(mode)
      setLivePolicy(mode)
      posthog.capture('dispatch_policy_switched', { policy: mode, live: true })
    } catch {
      setPolicySwitchError(mode === 'ppo' ? 'PPO is not available right now.' : 'Could not switch policy.')
    }
  }, [])

  const runCompare = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await runDispatchCompare({})
      setData(result)
      posthog.capture('dispatch_comparison_run', { episodes: result.episodes, seed: result.seed })
    } catch (err) {
      posthog.captureException(err instanceof Error ? err : new Error(String(err)))
      setError('Comparison failed. The ML service did not answer.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (mlOn) {
      void fetchDispatchPolicy().then((info) => setPolicyReady(info.exists)).catch(() => setPolicyReady(false))
    } else {
      setPolicyReady(false)
    }
    void fetchLiveDispatchPolicy()
      .then((s) => setLivePolicy(s.policy_mode === 'ppo' ? 'ppo' : 'rule'))
      .catch(() => { /* backend may be down */ })
  }, [mlOn])

  useEffect(() => {
    const mode = dispatch?.policy_mode
    if (mode === 'rule' || mode === 'ppo') setLivePolicy(mode)
  }, [dispatch?.policy_mode])

  const rule = data?.rule_based
  const ppo = data?.ppo
  const delta = data?.delta_pct
  const next = dispatch?.next_due_in_s
  const target = service?.target_headway_s ?? dispatch?.target_headway_sec ?? null
  const actual = service?.mean_headway_s ?? null

  return (
    <ScrollArea className="h-full">
      <Section title="Service" aside={service?.period ? <span className="text-[11px] text-muted-foreground">{service.period}</span> : undefined}>
        <Fields>
          <Field k="Trains in service">{service?.trains_in_service ?? trainCount ?? '—'}</Field>
          <Field k="Headway" title="Measured from recent departures">
            {fmtDuration(actual ?? target)}
            {actual != null && target != null && <Sub> / {fmtDuration(target)} target</Sub>}
            {actual == null && target != null && <Sub> target</Sub>}
          </Field>
        </Fields>
      </Section>

      <Section title="Yard departures">
        <Fields>
          <Field k="Dispatched">{dispatch?.count ?? '—'}</Field>
          <Field k="Next departure" mono={!dispatch?.blocked} className={dispatch?.blocked ? 'text-caution' : undefined}>
            {dispatch?.blocked ? 'Held, yard or fleet limit' : next != null ? fmtDuration(next) : '—'}
          </Field>
          <Field k="Fleet limit">{dispatch?.max_trains ?? '—'}</Field>
        </Fields>
      </Section>

      <Section
        title="Policy"
        aside={dispatch?.shield_intervened ? <Badge variant="caution" title="The safety shield overrode the last policy action">Shield</Badge> : undefined}
      >
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={livePolicy}
          onValueChange={(m) => { if (m === 'rule' || m === 'ppo') void applyLivePolicy(m) }}
          aria-label="Live dispatch policy"
          className="grid w-full grid-cols-2"
        >
          <ToggleGroupItem value="rule">Rule-based</ToggleGroupItem>
          <ToggleGroupItem value="ppo" disabled={mlOffline} title={mlOffline ? 'ML service offline' : 'Reinforcement-learning policy'}>
            PPO
          </ToggleGroupItem>
        </ToggleGroup>
        <Fields className="mt-1.5">
          {dispatch?.effective_headway_sec != null && (
            <Field k="Effective headway">{fmtDuration(dispatch.effective_headway_sec)}</Field>
          )}
          {dispatch?.effective_dwell_sec != null && (
            <Field k="Effective dwell">{Math.round(dispatch.effective_dwell_sec)} s</Field>
          )}
        </Fields>
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
          <StatusDot tone={mlOffline ? 'off' : 'ok'} />
          {mlOffline ? 'ML offline, rule-based dispatch' : livePolicy === 'ppo' ? 'ML online, PPO dispatching' : 'ML online'}
        </p>
        {policySwitchError && <p className="mt-1 text-[11px] text-caution">{policySwitchError}</p>}
        {!mlOffline && dispatch?.ml_error && livePolicy === 'ppo' && (
          <p className="mt-1 text-[11px] text-caution">PPO fell back to rule-based for the last departure.</p>
        )}
      </Section>

      {!mlOffline && (
        <Section title="Offline A/B" className="border-b-0">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void runCompare()}>
              {loading ? 'Running…' : data ? 'Run again' : 'Run comparison'}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {data ? <>{data.episodes} episodes, seed <span className="num">{data.seed}</span></> : 'Rule vs PPO, same seed'}
            </span>
          </div>
          {error && <p className="mt-2 text-[11px] text-caution">{error}</p>}
          {data && (
            <Table className="mt-2 text-xs">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="micro h-7 px-0">Metric</TableHead>
                  <TableHead className="micro h-7 text-right">Rule</TableHead>
                  <TableHead className="micro h-7 text-right">PPO</TableHead>
                  <TableHead className="micro h-7 pr-0 text-right">Δ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="num text-[11px]">
                <CompareRow label="Mean delay, s" a={fmt(rule?.delay_mean_sec)} b={fmt(ppo?.delay_mean_sec)} d={delta?.delay_mean_sec_pct_vs_rule} />
                <CompareRow label="P95 delay, s" a={fmt(rule?.delay_p95_sec)} b={fmt(ppo?.delay_p95_sec)} d={delta?.delay_p95_sec_pct_vs_rule} />
                <CompareRow label="Headway σ, s" a={fmt(rule?.headway_std_mean_sec, 0)} b={fmt(ppo?.headway_std_mean_sec, 0)} d={delta?.headway_std_mean_sec_pct_vs_rule} />
                <CompareRow
                  label="Shield rate"
                  a={rule ? `${fmt(rule.unsafe_action_rate * 100)}%` : '—'}
                  b={ppo ? `${fmt(ppo.unsafe_action_rate * 100)}%` : '—'}
                  d={delta?.unsafe_action_rate_pct_vs_rule}
                />
              </TableBody>
            </Table>
          )}
        </Section>
      )}
    </ScrollArea>
  )
}

function CompareRow({ label, a, b, d }: { label: string; a: string; b: string; d: number | null | undefined }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="px-0 py-1.5 font-sans text-xs text-muted-foreground">{label}</TableCell>
      <TableCell className="py-1.5 text-right">{a}</TableCell>
      <TableCell className="py-1.5 text-right">{b}</TableCell>
      {/* Shown as PPO's change vs rule-based (a reduction reads as −). */}
      <TableCell className={cn('py-1.5 pr-0 text-right', deltaTone(d))}>{pct(d == null ? d : -d)}</TableCell>
    </TableRow>
  )
}
