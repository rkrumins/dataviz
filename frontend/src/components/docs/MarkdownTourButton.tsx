/**
 * MarkdownTourButton — a "Take the tour" call-to-action embedded in a guide or
 * doc article via a ```tour-<tourId>``` fence (e.g. ```tour-explore-lineage```).
 *
 * It deep-links (``?tour=<id>``) rather than starting inline, so it works from
 * the standalone /guide reader — where the tour overlay isn't mounted — as well
 * as the in-app Help drawer. Renders nothing unless tours are enabled and the
 * id resolves, so a stale fence never leaves a dead button.
 */
import { Sparkles } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useFeature } from '@/store/features'
import { useTourStore } from '@/features/tour/tourStore'
import { getTour } from '@/features/tour/tours'

export function MarkdownTourButton({ tourId }: { tourId: string }) {
  const toursEnabled = useFeature('toursEnabled')
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const tour = getTour(tourId)
  const completed = useTourStore((s) => s.completed.includes(tourId))

  if (!toursEnabled || !tour) return null

  // Standalone /guide and /docs readers have no overlay mounted — bounce into
  // the app with the deep-link; in-app, re-use the current route so the drawer
  // just closes and the tour starts in place.
  const onStandaloneDocs = pathname.startsWith('/guide') || pathname.startsWith('/docs')
  const go = () => {
    const base = onStandaloneDocs ? '/dashboard' : pathname
    navigate(`${base}?tour=${encodeURIComponent(tourId)}`)
  }

  return (
    <div className="my-5 flex items-center gap-3 rounded-2xl border border-accent-lineage/25 bg-accent-lineage/[0.05] p-4 not-prose">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-lineage/12 text-accent-lineage">
        <Sparkles className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{tour.title}</p>
        <p className="text-xs text-ink-muted">{tour.description} · {tour.estimate}</p>
      </div>
      <button type="button" onClick={go} className="btn-primary btn-sm shrink-0">
        <Sparkles className="h-4 w-4" />
        {completed ? 'Replay' : 'Take the tour'}
      </button>
    </div>
  )
}
