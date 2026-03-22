import { useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import { getEntryBySlug, getSectionById } from './docsConfig'
import { markdownComponents } from './MarkdownComponents'
import { useDocsLoader } from '@/hooks/useDocsLoader'
import { ChevronRight, FileText } from 'lucide-react'

export function DocsContent() {
  const { slug } = useParams<{ slug: string }>()
  const entry = slug ? getEntryBySlug(slug) : undefined
  const section = entry ? getSectionById(entry.section) : undefined
  const { content, isLoading, error } = useDocsLoader(entry)

  if (error || !entry) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <FileText className="w-12 h-12 text-ink-muted mx-auto" />
          <h2 className="text-lg font-semibold text-ink">Document not found</h2>
          <p className="text-sm text-ink-muted">
            The document <code className="text-accent-lineage">"{slug}"</code> doesn't exist.
          </p>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-8 py-10 animate-pulse">
        {/* Breadcrumb skeleton */}
        <div className="h-4 w-48 bg-black/5 dark:bg-white/5 rounded mb-8" />
        {/* Title skeleton */}
        <div className="h-8 w-3/4 bg-black/5 dark:bg-white/5 rounded mb-6" />
        {/* Content skeletons */}
        <div className="space-y-3">
          <div className="h-4 w-full bg-black/5 dark:bg-white/5 rounded" />
          <div className="h-4 w-5/6 bg-black/5 dark:bg-white/5 rounded" />
          <div className="h-4 w-4/6 bg-black/5 dark:bg-white/5 rounded" />
          <div className="h-20 w-full bg-black/5 dark:bg-white/5 rounded-xl mt-6" />
          <div className="h-4 w-full bg-black/5 dark:bg-white/5 rounded mt-6" />
          <div className="h-4 w-3/4 bg-black/5 dark:bg-white/5 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-10">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-ink-muted mb-6">
        <span>Documentation</span>
        {section && (
          <>
            <ChevronRight className="w-3 h-3" />
            <span>{section.label}</span>
          </>
        )}
        <ChevronRight className="w-3 h-3" />
        <span className="text-ink font-medium">{entry.title}</span>
      </nav>

      {/* Markdown content */}
      <article className="prose-synodic">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, rehypeHighlight]}
          components={markdownComponents}
        >
          {content ?? ''}
        </ReactMarkdown>
      </article>

      {/* Bottom padding for scroll comfort */}
      <div className="h-20" />
    </div>
  )
}
