/**
 * A small, on-surface "Take a tour" launcher — dropped into a page header so the
 * relevant tour is discoverable right where it applies (Explorer, Workspaces,
 * the canvas), not only in the Help drawer. Renders nothing unless the tours
 * feature is enabled and the tour exists.
 */
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import { useTourStore } from './tourStore'
import { getTour } from './tours'

export function TourLaunchButton({ tourId, className }: { tourId: string; className?: string }) {
  const toursEnabled = useFeature('toursEnabled')
  const start = useTourStore((s) => s.start)
  const completed = useTourStore((s) => s.completed.includes(tourId))
  const tour = getTour(tourId)

  if (!toursEnabled || !tour) return null

  return (
    <button
      type="button"
      onClick={() => start(tourId)}
      title={`${tour.title} · ${tour.estimate}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:border-accent-lineage/40 hover:text-ink',
        className,
      )}
    >
      <Sparkles className="h-4 w-4 text-accent-lineage" />
      {completed ? 'Replay tour' : 'Take a tour'}
    </button>
  )
}
