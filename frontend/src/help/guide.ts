export const HELP_TARGET_IDS = [
  'header',
  'status',
  'map',
  'zoom',
  'menu',
  'events',
  'inject',
  'dispatch',
  'safe-zones',
  'labels',
  'info',
  'layout',
  'legend',
] as const

export type HelpTargetId = (typeof HELP_TARGET_IDS)[number]

export interface HelpTarget {
  id: HelpTargetId
  label: string
  keywords: string[]
  answer: string
}

export const HELP_TARGETS: HelpTarget[] = [
  {
    id: 'header',
    label: 'top bar',
    keywords: ['header', 'top bar', 'toolbar', 'clock', 'sim time', 'title'],
    answer:
      'The top bar shows the line and the SIM clock (service starts 06:00). On the right: Schematic / Map, the Safe zones and Labels overlays, the Guide, About, the ⋯ menu and the inspector toggle.',
  },
  {
    id: 'status',
    label: 'connection status',
    keywords: ['dot', 'status', 'status bar', 'health', 'backend', '/state', '/topology', '/commands', '/ml', 'connected', 'live', 'demo', 'offline', 'abort', 'error', 'headway', 'in service', 'period'],
    answer:
      'The status bar along the bottom starts with the link state: Live, Reconnecting, Offline or Demo data. Next to it: trains in service, measured headway against its target, and the service period. Dev mode (Ctrl+Shift+D) adds a dot per API: /topology and /state are the sim, /commands is click-to-control, /ml is the trainer.',
  },
  {
    id: 'map',
    label: 'line diagram',
    keywords: ['map', 'canvas', 'track', 'train', 'switch', 'signal', 'pan', 'click', 'hold', 'express', 'skip', 'station', 'diagram'],
    answer:
      'The big area is the line diagram: Vaughan MC top-left, down to the Union loop, up Yonge to Finch. Drag to pan, scroll to zoom, double-click or press 0 to fit. Click a train to open it in the Train tab, where you can hold it, run it express or skip a stop. Click a signal to change its aspect; a switch asks before it throws.',
  },
  {
    id: 'zoom',
    label: 'zoom buttons',
    keywords: ['zoom', 'magnify', 'bigger', 'smaller', 'fit', 'plus', 'minus', 'keyboard'],
    answer:
      'The + − and fit buttons at the bottom right of the map zoom without a scroll wheel. The + and − keys zoom, 0 fits the whole line, and double-clicking the map also fits. Signal names appear once you zoom in.',
  },
  {
    id: 'menu',
    label: 'accessibility menu',
    keywords: ['menu', 'hamburger', 'high contrast', 'contrast', 'accessibility', 'a11y', 'theme'],
    answer:
      'The ⋯ menu at the right of the top bar has High contrast: pure black and white, brighter signal aspects and thicker track. It stays on after a refresh. On phones the layout and overlay toggles live there too.',
  },
  {
    id: 'events',
    label: 'events log',
    keywords: ['event', 'log', 'alarm', 'feed', 'inspector'],
    answer:
      'Events is a tab in the inspector on the right: the log of what just happened, newest first, including holds, commands, faults and planned disruptions. Routine signal changes are hidden unless you turn on Signals.',
  },
  {
    id: 'inject',
    label: 'inject a disruption',
    keywords: ['inject', 'fault', 'delay', 'simulate event', 'scenario', 'disruption'],
    answer:
      'Inject, at the top of the Events tab, stages an incident: emergency brake, speed restriction, station hold, switch failure or an operator note. Pick the type and target, then Inject.',
  },
  {
    id: 'dispatch',
    label: 'dispatch',
    keywords: ['dispatch', 'ppo', 'ml', 'rule', 'compare', 'policy', 'a/b', 'departure', 'yard'],
    answer:
      'Dispatch is a tab in the inspector on the right: service level, departures from the yard, and who picks them, Rule-based or the PPO (ML) policy. When the ML service is reachable you can also run an offline A/B comparison of the two on the same seed.',
  },
  {
    id: 'safe-zones',
    label: 'safe zones',
    keywords: ['safe zone', 'atp', 'braking', 'envelope', 'authority', 'movement authority', 'band'],
    answer:
      'Safe zones paints each train’s movement authority as a band ahead of it: how far it may run before it must stop. Toggle it in the top bar to see why a train is slowing.',
  },
  {
    id: 'labels',
    label: 'labels',
    keywords: ['label', 'name', 'station name', 'train id'],
    answer:
      'Labels toggles station and train names. Off gives a cleaner picture; on makes it easier to find Run 4 or a platform. Names that would collide are hidden until you zoom in.',
  },
  {
    id: 'info',
    label: 'about',
    keywords: ['info', 'about', 'what is this', 'help me start', 'cbtc', 'urbalis'],
    answer:
      'The ⓘ button in the top bar opens a short primer on the real system (Alstom Urbalis 400 CBTC) and what this simulator models. Ctrl+Shift+C opens a hidden config panel.',
  },
  {
    id: 'layout',
    label: 'layout toggle',
    keywords: ['schematic', 'geographic', 'real map', 'layout', 'diagram view', 'map view'],
    answer:
      'Schematic / Map in the top bar switches between the line diagram (like the TTC map, spacing compressed so every station is readable) and the true geographic map. Your choice is remembered.',
  },
  {
    id: 'legend',
    label: 'legend',
    keywords: ['legend', 'colour', 'color', 'what does', 'mean', 'symbol', 'blue', 'white', 'amber', 'yellow'],
    answer:
      'Legend, at the right end of the status bar, decodes the board: blue trains are running, white ones are at a platform, amber are stopped, red is an emergency brake. Signals show green or red; amber track is a permanent speed limit.',
  },
]

const FALLBACK =
  'Ask about the line diagram, trains, signals, events, dispatch, the legend or the connection status. I’ll point at that part of the screen.'

export function matchHelp(question: string): { reply: string; point: HelpTargetId | null } {
  const q = question.toLowerCase()
  let best: HelpTarget | null = null
  let score = 0
  for (const t of HELP_TARGETS) {
    const hits = t.keywords.filter((k) => q.includes(k)).length
    if (hits > score) {
      score = hits
      best = t
    }
  }
  if (!best || score === 0) return { reply: FALLBACK, point: null }
  return { reply: best.answer, point: best.id }
}

export function catalogForPrompt(): string {
  return HELP_TARGETS.map((t) => `- ${t.id}: ${t.label} — ${t.answer}`).join('\n')
}
