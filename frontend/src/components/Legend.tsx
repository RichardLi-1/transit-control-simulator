/**
 * Map legend, opened from the status bar. Swatches are drawn from the live COLORS palette (the
 * values the canvas layers draw with), so the key always matches the map, high contrast included.
 */
import type { ReactNode } from 'react'
import { COLORS } from '../constants/colors'
import { FONT } from '../constants/theme'
import { useUiStore } from '../store/uiStore'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** Train body + pointed nose, as TrainLayer draws it (dark knockout outline). */
function Train({ fill, alert, hollow }: { fill: string; alert?: boolean; hollow?: boolean }) {
  const body = 'M3 3.5 H21 L25 6.5 L21 9.5 H3 Z'
  return (
    <svg width="30" height="13" viewBox="0 0 30 13" aria-hidden="true">
      <path d={body} fill={hollow ? COLORS.BACKGROUND : fill} stroke={alert ? COLORS.TEXT_1 : hollow ? fill : COLORS.TRAIN_BORDER} strokeWidth={hollow ? 1.25 : 1} strokeLinejoin="round" />
    </svg>
  )
}

/** Thin authority line from the nose to the end-of-authority tick. */
function Authority() {
  return (
    <svg width="30" height="13" viewBox="0 0 30 13" aria-hidden="true">
      <line x1="0" y1="6.5" x2="30" y2="6.5" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
      <line x1="11" y1="6.5" x2="27" y2="6.5" stroke={COLORS.MA_BAND} strokeWidth="1.25" />
      <line x1="27" y1="2.5" x2="27" y2="10.5" stroke={COLORS.MA_EOA} strokeWidth="1.25" />
      <path d="M0 4 H7 L10 6.5 L7 9 H0 Z" fill={COLORS.TRAIN_FILL} stroke={COLORS.TRAIN_BORDER} strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function SignalGlyph({ color }: { color: string }) {
  return (
    <svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true">
      <line x1="2" y1="12" x2="28" y2="12" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
      <path d="M13 10.5 V5.5 H16" stroke={COLORS.SIGNAL_MAST} strokeWidth="1.25" fill="none" strokeLinecap="round" />
      <circle cx="18.75" cy="5.5" r={COLORS.SIGNAL_RADIUS} fill={color} stroke={COLORS.SIGNAL_BORDER} strokeWidth="0.75" />
    </svg>
  )
}

function Station({ major }: { major?: boolean }) {
  return (
    <svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true">
      <line x1="2" y1="5" x2="28" y2="5" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
      <line x1="2" y1="11" x2="28" y2="11" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
      <rect x="10.5" y="2" width="9" height="12" rx="1" fill="none" stroke={major ? COLORS.INTERCHANGE_BORDER : COLORS.STATION_MARKER_BORDER} strokeWidth={major ? 1.5 : 1} />
    </svg>
  )
}

/** 1 px line beside the rail plus the boxed limit shown when zoomed in. */
function SpeedLimit() {
  return (
    <svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true">
      <line x1="0" y1="11" x2="30" y2="11" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
      <line x1="0" y1="14" x2="30" y2="14" stroke={COLORS.SPEED_RESTRICTION} strokeWidth="1" />
      <rect x="8.5" y="0.5" width="13" height="8" rx="1" fill={COLORS.SPEED_TAG_BG} stroke={COLORS.SPEED_RESTRICTION} strokeWidth="1" />
      <text x="15" y="6.9" textAnchor="middle" fontSize="6.5" fontFamily={FONT.mono} fill={COLORS.SPEED_RESTRICTION_TEXT}>45</text>
    </svg>
  )
}

/** Crossover: normal = diagonal short of both rails; reversed = joined, straight rails gapped. */
function Crossover({ reversed }: { reversed?: boolean }) {
  return (
    <svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true">
      {reversed ? (
        <>
          <line x1="0" y1="3" x2="9" y2="3" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
          <line x1="14" y1="3" x2="30" y2="3" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
          <line x1="0" y1="13" x2="16" y2="13" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
          <line x1="21" y1="13" x2="30" y2="13" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
          <line x1="9" y1="3" x2="21" y2="13" stroke={COLORS.SWITCH_REVERSE} strokeWidth="2" />
        </>
      ) : (
        <>
          <line x1="0" y1="3" x2="30" y2="3" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
          <line x1="0" y1="13" x2="30" y2="13" stroke={COLORS.TRACK_CLEAR} strokeWidth={COLORS.TRACK_WIDTH} />
          <line x1="11.4" y1="5" x2="18.6" y2="11" stroke={COLORS.TRACK_CROSSOVER} strokeWidth={COLORS.TRACK_CROSSOVER_WIDTH} />
        </>
      )}
    </svg>
  )
}

function Item({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-flex w-[30px] shrink-0 justify-center">{swatch}</span>
      <span className="min-w-0 leading-tight">{children}</span>
    </li>
  )
}

export function LegendBody() {
  // COLORS is swapped in place by high contrast: re-render when it flips.
  useUiStore((s) => s.highContrast)
  return (
    <div className="flex flex-col gap-3">
      <section>
        <h3 className="micro mb-1.5">Trains</h3>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Item swatch={<Train fill={COLORS.TRAIN_FILL} />}>Running</Item>
          <Item swatch={<Train fill={COLORS.TRAIN_DWELL} />}>At platform</Item>
          <Item swatch={<Train fill={COLORS.TRAIN_STOPPED} />}>Stopped</Item>
          <Item swatch={<Train fill={COLORS.TRAIN_EBRAKE} alert />}>Emergency brake</Item>
          <Item swatch={<Train fill={COLORS.TRAIN_OUT_OF_SERVICE} hollow />}>Out of service</Item>
          <li className="col-span-2">
            <ul><Item swatch={<Authority />}>Movement authority, ending at the tick</Item></ul>
          </li>
        </ul>
      </section>
      <section>
        <h3 className="micro mb-1.5">Track and signals</h3>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Item swatch={<SignalGlyph color={COLORS.SIGNAL_GREEN} />}>Proceed</Item>
          <Item swatch={<SignalGlyph color={COLORS.SIGNAL_RED} />}>Stop</Item>
          <Item swatch={<Station />}>Station</Item>
          <Item swatch={<Station major />}>Interchange</Item>
          <Item swatch={<Crossover />}>Crossover</Item>
          <Item swatch={<Crossover reversed />}>Points reversed</Item>
          <Item swatch={<SpeedLimit />}>Speed limit</Item>
        </ul>
      </section>
    </div>
  )
}

export function LegendPopover() {
  const open = useUiStore((s) => s.legendOpen)
  const setOpen = useUiStore((s) => s.setLegendOpen)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span data-help="legend" className="inline-flex">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-5 items-center rounded-xs px-1.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
          >
            Legend
          </button>
        </PopoverTrigger>
      </span>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-80 p-3">
        <LegendBody />
      </PopoverContent>
    </Popover>
  )
}
