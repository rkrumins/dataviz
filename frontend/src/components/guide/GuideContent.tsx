import { useMemo } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { ChevronRight, FileText, Clock, Home } from 'lucide-react'
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
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { extractHeadings } from '@/components/docs/reading/headings'
import { OnThisPage } from '@/components/docs/reading/OnThisPage'
import { Pager } from '@/components/docs/reading/Pager'
import { ContentSkeleton } from '@/components/docs/reading/ContentSkeleton'
import { UpdatedChip } from '@/components/docs/reading/UpdatedChip'
import { PageFeedback } from '@/components/docs/reading/PageFeedback'
import { guideMeta } from '@/components/docs/reading/docMeta.generated'

export function GuideContent() {
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const { slug } = useParams<{ slug: string }>()
  const location = useLocation()
  const entry = slug ? getGuideEntry(slug) : undefined
  const section = entry ? getGuideSection(entry.section) : undefined
  const persona = getPersona(entry?.persona)
  const { content, isLoading, error } = useDocsLoader(entry)

  useDocumentTitle(entry?.title ? `${entry.title} · Guide` : 'User Guide')

  const headings = useMemo(() => (content ? extractHeadings(content) : []), [content])
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

  if (isLoading) return <ContentSkeleton />

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
            <UpdatedChip date={guideMeta[entry.slug]?.updated} />
          </div>

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

          <PageFeedback path={guideMeta[entry.slug]?.path} pageKey={`guide:${entry.slug}`} />

          <Pager
            basePath="/guide"
            prev={prev ? { slug: prev.slug, title: interp(prev.title) } : undefined}
            next={next ? { slug: next.slug, title: interp(next.title) } : undefined}
          />

          <div className="h-16" />
        </div>

        {/* On this page rail */}
        {headings.length > 1 && <OnThisPage headings={headings} />}
      </div>
    </div>
  )
}
