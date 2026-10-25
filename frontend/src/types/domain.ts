// ── Primitives ────────────────────────────────────────────────────────────

export interface Vec2 { x: number; y: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

// ── Topology (static, from GET /topology) ────────────────────────────────

export interface TopologyNode {
  id: string
  x: number
  y: number
  label: string
  is_station: boolean
}

export interface TopologyEdge {
  id: string
  from_node: string
  to_node: string
  block_id: string
  points: Vec2[]
  /** @deprecated polyline length in world (pixel) units — use `length_m` for track metres. */
  length: number
  /** Real track length in metres (contract v2). Layout changes never alter this. */
  length_m?: number
}

export type SwitchState = 'normal' | 'reverse'

export interface TopologySwitch {
  id: string
  node_id: string
  normal_edge_id: string
  reverse_edge_id: string
  state: SwitchState
  /** Route chainages of the switch points (contract v2, additive). */
  points_m?: number[]
}

export interface TopologyCrossover {
  id: string
  edge1_id: string
  edge2_id: string
  node_id: string
}

export type SignalAspect = 'red' | 'yellow' | 'green' | 'flashing_yellow' | 'dark'

export interface TopologySignal {
  id: string
  edge_id: string
  offset: number
  position: Vec2
  aspect: SignalAspect
  block_id: string
  /** Route chainage of the signal, metres (contract v2). */
  chainage_m?: number
  /** Display name, e.g. "FIN 1" (contract v2, additive). */
  name?: string
  /** 'home' | 'starter' | 'yard_exit' … */
  kind?: string
  leg?: RouteLeg
  interlocking?: string
}

/** One edge of the revenue ring, in route order (contract v2). */
export interface RouteSegment {
  edge_id: string
  /** Chainage (m) where this edge starts on the ring. */
  start_m: number
  /** Track metres of this edge (same as edge.length_m). */
  length_m: number
}

/**
 * The revenue route as a ring. Chainage 0 = start of `ob_0_1` (Vaughan MC → Finch).
 * A chainage c lies on the segment with start_m <= c < start_m + length_m, at
 * fraction (c - start_m) / length_m along that edge's `points` polyline (by arc length).
 */
export interface TopologyRoute {
  length_m: number
  segments: RouteSegment[]
}

export type RouteLeg = 'ob' | 'ib'

export interface StationPlatform {
  leg: RouteLeg
  node_id: string
  /** Stopping point of the train NOSE at this platform. */
  chainage_m: number
  /** 'through' | 'arrival' | 'departure' (terminals have arrival + departure stops). */
  role?: string
  ring_index?: number
}

export interface TopologyStation {
  name: string
  /** Short code, e.g. 'UNI'. */
  code?: string
  /** 0 = Vaughan MC … 37 = Finch. */
  stop_index: number
  platforms: StationPlatform[]
}

export interface SpeedRestriction {
  start_m: number
  end_m: number
  limit_kph: number
  reason: string
}

export interface TopologyYard {
  name: string
  chainage_m: number
  leg?: RouteLeg
}

export interface Topology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  switches: TopologySwitch[]
  crossovers: TopologyCrossover[]
  signals: TopologySignal[]
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number }
  // ── contract v2 (optional: older backends don't send these) ──
  route?: TopologyRoute
  stations?: TopologyStation[]
  speed_restrictions?: SpeedRestriction[]
  yards?: TopologyYard[]
}

// ── Runtime state (dynamic, from GET /state) ──────────────────────────────

export type BlockOccupancy = 'clear' | 'occupied' | 'unknown'
/** 'stopped' (contract v2) = stationary away from a platform (train ahead, red signal, e-brake). */
export type TrainState = 'running' | 'arriving' | 'dwelling' | 'stopped'

export type TrainStopReason =
  | 'train_ahead'
  | 'signal'
  | 'emergency_brake'
  | 'dispatcher_hold'
  | 'turnback'

export interface TrainPosition {
  train_id: string
  label: string
  edge_id: string
  /** Fraction [0, 1] along the edge polyline. */
  offset: number
  /** Metres per second (mock and GET /state). */
  speed: number
  state: TrainState
  // ── contract v2 (optional: older backends don't send these) ──
  /** Nose chainage on the route ring, metres, [0, route.length_m). */
  chainage_m?: number
  /** Consist length, metres (138 for a Toronto Rocket). */
  length_m?: number
  /** Signed actual acceleration this step, m/s². */
  accel_mps2?: number
  stop_reason?: TrainStopReason | null
  /** Next platform it WILL stop at (honours skip/express). */
  next_station_name?: string | null
  /** Terminal it is heading to: 'Finch' | 'Vaughan MC'. */
  destination?: string
  /** Nose → leader tail, metres. */
  gap_to_leader_m?: number | null
  /** Additive backend extras. */
  leader_id?: string | null
  leg?: RouteLeg
  e_brake?: boolean
  in_service?: boolean
  station_name?: string | null
  dwell_remaining_sec?: number
  safe_zone_front: number
  safe_zone_rear: number
  atp_slack_m?: number
  authority_eoa_m?: number | null
  fleet?: string
  passengers?: number
  passenger_capacity?: number
  load_pct?: number
  /** Operator dispatch overrides (service regulation). */
  dispatch_hold?: boolean
  dispatch_express?: boolean
  dispatch_skip_remaining?: number
}

export type DispatchAction = 'hold' | 'express' | 'skip' | 'release'

export interface BlockRuntime {
  block_id: string
  occupancy: BlockOccupancy
}

export interface SwitchRuntime {
  switch_id: string
  state: SwitchState
}

export interface SignalRuntime {
  signal_id: string
  aspect: SignalAspect
}

export interface RuntimeState {
  trains: TrainPosition[]
  blocks: BlockRuntime[]
  switches: SwitchRuntime[]
  signals: SignalRuntime[]
  ops?: {
    dispatch?: {
      count: number
      last_dispatch_sim_t?: number | null
      next_due_in_s?: number
      blocked?: boolean
      max_trains?: number
      target_headway_sec?: number
      policy_mode?: 'rule' | 'ppo'
      policy_ready?: boolean
      headway_bias_sec?: number
      dwell_bias_sec?: number
      effective_headway_sec?: number
      effective_dwell_sec?: number
      shield_intervened?: boolean
      ml_error?: string | null
    }
    injected_events?: InjectedEventRuntime[]
    event_log?: EventLogRow[]
    /** contract v2 */
    service?: ServiceStats
  }
  /** Monotonic sim clock (seconds since backend sim start). */
  sim_time_s?: number
  timestamp: number
  // ── contract v2 (optional: older backends don't send these) ──
  /** Wall-clock multiplier (1 = real time). */
  sim_speed?: number
  paused?: boolean
  /** Sim integration step, seconds. */
  step_s?: number
}

export interface ServiceStats {
  trains_in_service: number
  target_headway_s: number
  /** Measured from recent departures. */
  mean_headway_s: number | null
  /** e.g. 'AM peak', 'Midday'. */
  period: string
}

// ── Interaction ───────────────────────────────────────────────────────────

export type EntityKind = 'switch' | 'signal' | 'train' | 'block'

export interface HoveredEntity {
  kind: EntityKind
  id: string
  screenX: number
  screenY: number
}

// ── Config (hidden panel) ─────────────────────────────────────────────────

export interface RollingStockProfile {
  id: string
  name: string
  max_speed: number     // m/s
  accel: number         // m/s²
  decel: number         // m/s²
  length: number        // m
  mass: number          // tonnes
}

export interface SimConfig {
  rolling_stock_pct: number           // % of fleet at max capacity
  active_profile: string              // profile id
  profiles: RollingStockProfile[]
  headway_target: number              // s
  injected_events: InjectedEvent[]
}

export type EventKind =
  | 'emergency_brake'
  | 'emergency_brake_release'
  | 'door_fault'
  | 'slow_speed'
  | 'signal_fail'
  | 'station_hold'
  | 'operator_note'

export interface InjectedEventRuntime {
  id: string
  kind: string
  target_train_id?: string | null
  target_signal_id?: string | null
  target_switch_id?: string | null
  duration_s: number
  remaining_s: number
  starts_in_s: number
  speed_limit_kph?: number | null
  note?: string
  source?: string
  active: boolean
  created_sim_t?: number
}

export interface EventLogRow {
  severity: 'info' | 'warn' | 'error'
  kind: string
  message: string
  source: string
  sim_t: number
}

/** @deprecated local-only; use ops.injected_events from /state */
export interface InjectedEvent {
  id: string
  kind: EventKind
  target_train_id: string
  duration_s: number
  active: boolean
}

// ── RL training (ML API on :8001, proxied as /ml) ─────────────────────────

export type TrainingStatusKind = 'idle' | 'running' | 'completed' | 'stopped' | 'failed'

export interface TrainingStatus {
  status?: TrainingStatusKind
  running?: boolean
  run_dir?: string
  experiment?: string
  total_timesteps?: number
  completed_timesteps?: number
  last_checkpoint?: string
  persist_checkpoints?: boolean
  error?: string | null
}

export interface TrainingSettings {
  persist_checkpoints: boolean
  resume: boolean
  config: string
}

// ── Dispatch A/B (ML API) ───────────────────────────────────────────────────

export interface DispatchMetrics {
  delay_mean_sec: number
  delay_p95_sec: number
  headway_std_mean_sec: number
  unsafe_action_rate: number
  episodes: number
}

export interface DispatchComparison {
  seed: number
  episodes: number
  policy_path: string
  rule_based: DispatchMetrics
  ppo: DispatchMetrics
  delta_pct: {
    delay_mean_sec_pct_vs_rule?: number | null
    delay_p95_sec_pct_vs_rule?: number | null
    headway_std_mean_sec_pct_vs_rule?: number | null
    unsafe_action_rate_pct_vs_rule?: number | null
  }
}

export interface DispatchPolicyInfo {
  path: string
  exists: boolean
  size_bytes: number
}
