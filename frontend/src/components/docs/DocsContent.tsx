import { useMemo } from 'react'
import { useParams, useLocation, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { ChevronRight, FileText, Clock, Home } from 'lucide-react'
import { getEntryBySlug, getSectionById, getPagerNeighbors } from './docsConfig'
import { markdownComponents } from './MarkdownComponents'
import { useDocsLoader } from '@/hooks/useDocsLoader'
import { interpolateBrand } from '@/lib/brandText'
import { useBrand } from '@/store/branding'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { extractHeadings } from './reading/headings'
import { readingTime } from './reading/readingTime'
import { OnThisPage } from './reading/OnThisPage'
import { Pager } from './reading/Pager'
import { ContentSkeleton } from './reading/ContentSkeleton'
import { UpdatedChip } from './reading/UpdatedChip'
import { PageFeedback } from './reading/PageFeedback'
import { getDocType, DocTypeBadge } from './reading/DocTypeBadge'
import { docMeta } from './reading/docMeta.generated'

export function DocsContent() {
  const { slug } = useParams<{ slug: string }>()
  const location = useLocation()
  const brand = useBrand()
  const interp = (t: string) => interpolateBrand(t, brand)
  const entry = slug ? getEntryBySlug(slug) : undefined
  const section = entry ? getSectionById(entry.section) : undefined
  const { content, isLoading, error } = useDocsLoader(entry)

  useDocumentTitle(entry?.title ? `${entry.title} · Docs` : 'Docs')

  const headings = useMemo(() => (content ? extractHeadings(content) : []), [content])
  const minutes = useMemo(() => (content ? readingTime(content) : ''), [content])
  const { prev, next } = entry ? getPagerNeighbors(entry.slug) : { prev: undefined, next: undefined }

  if (error || !entry) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <FileText className="w-12 h-12 text-ink-muted mx-auto" />
          <h2 className="text-lg font-semibold text-ink">Document not found</h2>
          <p className="text-sm text-ink-muted">
            The document <code className="text-accent-lineage">"{slug}"</code> doesn't exist.
          </p>
          <Link to="/docs" className="btn btn-secondary inline-flex mt-2">
            <Home className="w-3.5 h-3.5" /> Back to docs
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
        <Link to="/docs" className="hover:text-ink transition-colors">Documentation</Link>
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
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <DocTypeBadge type={getDocType(entry.slug)} />
            {minutes && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-ink-muted bg-black/[0.04] dark:bg-white/[0.06]">
                <Clock className="w-3.5 h-3.5" />
                {minutes} read
              </span>
            )}
            <UpdatedChip date={docMeta[entry.slug]?.updated} />
          </div>

          <article className="prose-synodic">
            <ReactMarkdown
              key={location.pathname}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug, rehypeHighlight]}
              components={markdownComponents}
            >
              {interp(content ?? '')}
            </ReactMarkdown>
          </article>

          <PageFeedback path={docMeta[entry.slug]?.path} pageKey={`docs:${entry.slug}`} />

          <Pager
            basePath="/docs"
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
