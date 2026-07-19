import { BookOpen, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { getGuideEntry } from '@/components/guide/guideConfig'

/**
 * A contextual, in-app link into the Guide (or Docs) — the one affordance to
 * use anywhere a surface would benefit from "learn more" without the user
 * having to go hunting. Routes in-SPA (``/guide/:slug`` and ``/docs/:slug``
 * already resolve), so no full page reload.
 *
 * Prefer a Guide slug (end-user articles). Pass ``area="docs"`` for the
 * engineering docs. In dev, an unknown Guide slug warns rather than failing —
 * the link still renders and lands on the in-app not-found panel.
 */
type Variant = 'inline' | 'button' | 'icon'

interface DocsLinkProps {
  /** Guide slug (default) or docs slug when ``area="docs"``. */
  slug: string
  area?: 'guide' | 'docs'
  variant?: Variant
  /** Overrides the default label (the Guide entry's title). */
  label?: string
  className?: string
}

export function DocsLink({
  slug,
  area = 'guide',
  variant = 'inline',
  label,
  className,
}: DocsLinkProps) {
  const entry = area === 'guide' ? getGuideEntry(slug) : undefined
  if (area === 'guide' && !entry && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[DocsLink] unknown guide slug "${slug}" — check guideConfig.ts`)
  }
  const to = `/${area}/${slug}`
  const text = label ?? entry?.title ?? 'Learn more'

  if (variant === 'icon') {
    return (
      <Link
        to={to}
        aria-label={`Guide: ${text}`}
        title={text}
        className={cn(
          'inline-flex items-center justify-center w-8 h-8 rounded-lg text-ink-muted',
          'hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          className,
        )}
      >
        <BookOpen className="w-4 h-4" />
      </Link>
    )
  }

  if (variant === 'button') {
    return (
      <Link
        to={to}
        className={cn(
          'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-ink-muted',
          'hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          className,
        )}
      >
        <BookOpen className="w-4 h-4" />
        {text}
      </Link>
    )
  }

  // inline
  return (
    <Link
      to={to}
      className={cn(
        'group inline-flex items-center gap-1.5 text-sm font-semibold text-accent-lineage',
        'hover:underline underline-offset-2 rounded',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
        className,
      )}
    >
      <BookOpen className="w-3.5 h-3.5 shrink-0" />
      {text}
      <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
    </Link>
  )
}
