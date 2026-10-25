import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'

interface Props {
  open: boolean
  onClose: () => void
}

export function InfoPopup({ open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="flex max-h-[min(86dvh,720px)] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="gap-1 border-b px-4 py-3">
          <DialogTitle className="text-sm">About this simulator</DialogTitle>
          <DialogDescription className="text-xs">TTC Line 1 on Alstom Urbalis 400 CBTC, simplified.</DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-4 py-4 text-xs leading-relaxed text-muted-foreground">
            <Section title="The real system">
              <p>
                Line 1 (Yonge–University) runs on Urbalis 400, a moving-block CBTC. Trains report their position
                to wayside zone controllers over radio. ATS regulates service; wayside ATP grants each train a{' '}
                <span className="text-foreground">movement authority</span>, the point it may travel up to, and onboard
                ATO drives within it. Interlockings with lineside signals remain at crossovers and terminals.
              </p>
            </Section>

            <Section title="Reading the board">
              <Defs>
                <Def k="Line diagram">Vaughan MC to Finch. Spacing follows real distance, compressed so every station stays readable. Switch to Map for true geography.</Def>
                <Def k="Trains">Coloured by state: running, at a platform, stopped, emergency brake. The band ahead is the movement authority (Safe zones).</Def>
                <Def k="Signals">Only at interlockings. The head points the way trains run on that track.</Def>
                <Def k="Amber underlay">Permanent speed limits: curves, terminal approaches.</Def>
              </Defs>
            </Section>

            <Section title="What is modelled">
              <Defs>
                <Def k="Topology">Track graph, stations, crossovers, yards and civil speed limits.</Def>
                <Def k="Trains">Each train integrates its own traction and braking in real metres along the route.</Def>
                <Def k="Control">ATP issues authorities, ATO follows them, dispatch regulates headways (rule-based or an ML policy).</Def>
                <Def k="Operator">Hold, express, skip, signal and switch commands, injected disruptions.</Def>
              </Defs>
            </Section>

            <Section title="Simplifications">
              <p>
                No radio-loss model, no SIL-rated voting or interlocking proofs. Occupancy comes from train
                positions rather than axle counters. Braking curves and headways are tuned for legibility, not
                certification.
              </p>
            </Section>
          </div>
        </ScrollArea>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2.5 text-[11px] text-faint">
          <span>Recreational simulator. Not affiliated with the TTC or Alstom.</span>
          <span className="flex items-center gap-1">
            Sim config <KbdGroup><Kbd>Ctrl</Kbd><Kbd>Shift</Kbd><Kbd>C</Kbd></KbdGroup>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="micro mb-1.5">{title}</h3>
      {children}
    </section>
  )
}

function Defs({ children }: { children: ReactNode }) {
  return <dl className="flex flex-col gap-1.5">{children}</dl>
}

function Def({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[112px_1fr]">
      <dt className="text-foreground">{k}</dt>
      <dd>{children}</dd>
    </div>
  )
}
