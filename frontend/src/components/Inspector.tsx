/**
 * Right-hand inspector (desktop sidebar, phone bottom sheet): Train / Dispatch / Events.
 */
import type { ReactNode } from 'react'
import { useRuntimeStore } from '../store/runtimeStore'
import { useUiStore, type InspectorTab } from '../store/uiStore'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TrainPanel } from './TrainPanel'
import { DispatchPanel } from './DispatchPanel'
import { EventsPanel, useVisibleEvents } from './EventsPanel'

export function Inspector({ className, trailing }: { className?: string; trailing?: ReactNode }) {
  const tab = useUiStore((s) => s.inspectorTab)
  const setTab = useUiStore((s) => s.setInspectorTab)
  const selectedLabel = useRuntimeStore((s) => {
    const id = s.selectedTrainId
    return id ? s.runtime?.trains.find((t) => t.train_id === id)?.label ?? id : null
  })
  const { visible, alerts } = useVisibleEvents()

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as InspectorTab)} className={cn('h-full', className)}>
      <TabsList aria-label="Inspector">
        <TabsTrigger value="train">
          Train
          {selectedLabel && <span className="font-normal text-muted-foreground">{selectedLabel.replace(/^Run\s*/i, '')}</span>}
        </TabsTrigger>
        <TabsTrigger value="dispatch">Dispatch</TabsTrigger>
        <TabsTrigger value="events">
          Events
          {visible.length > 0 && (
            <span className={cn('num text-[10px] font-normal', alerts > 0 ? 'text-caution' : 'text-faint')}>{visible.length}</span>
          )}
        </TabsTrigger>
        {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
      </TabsList>
      <TabsContent value="train" className="flex flex-col">
        <TrainPanel />
      </TabsContent>
      <TabsContent value="dispatch" data-help="dispatch">
        <DispatchPanel />
      </TabsContent>
      <TabsContent value="events" data-help="events">
        <EventsPanel />
      </TabsContent>
    </Tabs>
  )
}
