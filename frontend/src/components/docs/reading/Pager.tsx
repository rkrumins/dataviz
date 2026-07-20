import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export interface PagerLink {
  slug: string
  title: string
}

/**
 * Previous / next article navigation shown at the foot of a doc or guide page.
 */
export function Pager({
  prev,
  next,
  basePath,
}: {
  prev?: PagerLink
  next?: PagerLink
  basePath: '/docs' | '/guide'
}) {
  if (!prev && !next) return null
  return (
    <div className="mt-12 grid grid-cols-1 gap-3 border-t border-glass-border pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          to={`${basePath}/${prev.slug}`}
          className="group flex flex-col gap-1 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 transition-colors hover:border-accent-lineage/30 hover:bg-accent-lineage/[0.04]"
        >
          <span className="flex items-center gap-1 text-[11px] text-ink-muted">
            <ChevronLeft className="h-3 w-3 transition-transform group-hover:-translate-x-0.5" /> Previous
          </span>
          <span className="text-sm font-semibold text-ink transition-colors group-hover:text-accent-lineage">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          to={`${basePath}/${next.slug}`}
          className="group flex flex-col gap-1 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 text-right transition-colors hover:border-accent-lineage/30 hover:bg-accent-lineage/[0.04] sm:col-start-2"
        >
          <span className="flex items-center justify-end gap-1 text-[11px] text-ink-muted">
            Next <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="text-sm font-semibold text-ink transition-colors group-hover:text-accent-lineage">
            {next.title}
          </span>
        </Link>
      )}
    </div>
  )
}
