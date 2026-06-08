import { useMemo } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import GithubSlugger from 'github-slugger'
import {
  ChevronRight,
  ChevronLeft,
  FileText,
  Clock,
  List,
  Home,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDocsLoader } from '@/hooks/useDocsLoader'
import {
  getGuideEntry,
  getGuideSection,
  getPersona,
  getPagerNeighbors,
} from './guideConfig'
import { guideMarkdownComponents } from './guideMarkdown'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'

// Strip the inline markdown that doesn't survive into a heading's rendered
// text, so slug ids match what rehype-slug produces.
function headingText(raw: string): string {
  return raw
    .replace(/`/g, '')
    .replace(/\*\*?/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .trim()
}

// Build the "On this page" rail. We replay github-slugger over *every* heading
// in document order — the same instance rehype-slug uses — so the ids (and any
// duplicate "-1" suffixes) match the rendered anchors exactly. We surface h2s.
function extractHeadings(md: string): { id: string; text: string }[] {
  const slugger = new GithubSlugger()
  const out: { id: string; text: string }[] = []
  let inFence = false
  for (const raw of md.split('\n')) {
    if (/^\s*```/.test(raw)) inFence = !inFence
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(raw)
    if (!m) continue
    const text = headingText(m[2])
    const id = slugger.slug(text)
    if (m[1].length === 2) out.push({ id, text })
  }
  return out
}

export function GuideContent() {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const { slug } = useParams<{ slug: string }>()
  const location = useLocation()
  const entry = slug ? getGuideEntry(slug) : undefined
  const section = entry ? getGuideSection(entry.section) : undefined
  const persona = getPersona(entry?.persona)
  const { content, isLoading, error } = useDocsLoader(entry)

  const headings = useMemo(
    () => (content ? extractHeadings(content) : []),
    [content],
  )
  const { prev, next } = entry ? getPagerNeighbors(entry.slug) : { prev: undefined, next: undefined }

  if (error || !entry) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <FileText className="w-12 h-12 text-ink-muted mx-auto" />
          <h2 className="text-lg font-semibold text-ink">Page not found</h2>
          <p className="text-sm text-ink-muted">
            The guide page <code className="text-accent-lineage">"{slug}"</code> doesn't exist.
          </p>
          <Link to="/guide" className="btn btn-secondary inline-flex mt-2">
            <Home className="w-3.5 h-3.5" /> Back to the guide
          </Link>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-8 py-10 animate-pulse">
        <div className="h-4 w-48 bg-black/5 dark:bg-white/5 rounded mb-8" />
        <div className="h-9 w-3/4 bg-black/5 dark:bg-white/5 rounded mb-6" />
        <div className="space-y-3">
          <div className="h-4 w-full bg-black/5 dark:bg-white/5 rounded" />
          <div className="h-4 w-5/6 bg-black/5 dark:bg-white/5 rounded" />
          <div className="h-4 w-4/6 bg-black/5 dark:bg-white/5 rounded" />
          <div className="h-24 w-full bg-black/5 dark:bg-white/5 rounded-xl mt-6" />
          <div className="h-4 w-full bg-black/5 dark:bg-white/5 rounded mt-6" />
          <div className="h-4 w-3/4 bg-black/5 dark:bg-white/5 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-6 sm:px-8 py-10">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-ink-muted mb-6">
        <Link to="/guide" className="hover:text-ink transition-colors">User Guide</Link>
        {section && (
          <>
            <ChevronRight className="w-3 h-3" />
            <span>{section.label}</span>
          </>
        )}
        <ChevronRight className="w-3 h-3" />
        <span className="text-ink font-medium">{interp(entry.title)}</span>
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_220px] gap-10">
        {/* Article column */}
        <div className="min-w-0">
          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {persona && (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border',
                  persona.accent.soft,
                  persona.accent.text,
                  persona.accent.border,
                )}
              >
                <persona.icon className="w-3.5 h-3.5" />
                {persona.label}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-ink-muted bg-black/[0.04] dark:bg-white/[0.06]">
              <Clock className="w-3.5 h-3.5" />
              {entry.readingTime} read
            </span>
          </div>

          {/* Markdown body */}
          <article className="prose-synodic">
            <ReactMarkdown
              key={location.pathname}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug, rehypeHighlight]}
              components={guideMarkdownComponents}
            >
              {interp(content ?? '')}
            </ReactMarkdown>
          </article>

          {/* Prev / next pager */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-12 pt-8 border-t border-glass-border">
            {prev ? (
              <Link
                to={`/guide/${prev.slug}`}
                className="group flex flex-col gap-1 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 hover:border-indigo-500/30 hover:bg-indigo-500/[0.03] transition-colors"
              >
                <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                  <ChevronLeft className="w-3 h-3" /> Previous
                </span>
                <span className="text-sm font-semibold text-ink group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {interp(prev.title)}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link
                to={`/guide/${next.slug}`}
                className="group flex flex-col gap-1 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 text-right hover:border-indigo-500/30 hover:bg-indigo-500/[0.03] transition-colors sm:col-start-2"
              >
                <span className="flex items-center justify-end gap-1 text-[11px] text-ink-muted">
                  Next <ChevronRight className="w-3 h-3" />
                </span>
                <span className="text-sm font-semibold text-ink group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {interp(next.title)}
                </span>
              </Link>
            )}
          </div>

          <div className="h-16" />
        </div>

        {/* On this page rail */}
        {headings.length > 1 && (
          <aside className="hidden lg:block">
            <div className="sticky top-6">
              <div className="flex items-center gap-2 mb-3 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
                <List className="w-3.5 h-3.5" />
                On this page
              </div>
              <nav className="space-y-1 border-l border-glass-border">
                {headings.map((h) => (
                  <a
                    key={h.id}
                    href={`#${h.id}`}
                    className="block -ml-px pl-3 py-1 text-xs text-ink-muted border-l border-transparent hover:border-indigo-500 hover:text-ink transition-colors"
                  >
                    {h.text}
                  </a>
                ))}
              </nav>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
