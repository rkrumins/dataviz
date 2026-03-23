import { Children, isValidElement } from 'react'
import type { Components } from 'react-markdown'
import { Link as RouterLink } from 'react-router-dom'
import { Hash } from 'lucide-react'
import { MermaidBlock } from './MermaidBlock'

// Map the actual filenames from docs/ to route slugs
const filenameMap: Record<string, string> = {
  'OVERVIEW.md': 'overview',
  'SETUP.md': 'setup',
  'ARCHITECTURE.md': 'architecture',
  'DECISIONS.md': 'decisions',
  'BACKEND.md': 'backend',
  'FRONTEND.md': 'frontend',
  'DATA_ARCHITECTURE.md': 'data-architecture',
  'API_FEATURES.md': 'api-features',
  'TECHNICAL_DEBT.md': 'technical-debt',
  'SIGNUP_USER_SERVICE_PLAN.md': 'signup-service',
}

function rewriteDocLink(href: string): string {
  const cleaned = href.replace(/^\.\//, '')
  if (cleaned.endsWith('.md')) {
    const slug = filenameMap[cleaned]
    if (slug) return `/docs/${slug}`
  }
  if (href.startsWith('#')) return href
  return href
}

function HeadingWithAnchor({
  level,
  id,
  children,
}: {
  level: number
  id?: string
  children: React.ReactNode
}) {
  const content = (
    <>
      {children}
      {id && (
        <a href={`#${id}`} className="heading-anchor" aria-hidden>
          <Hash className="w-4 h-4 inline" />
        </a>
      )}
    </>
  )

  switch (level) {
    case 1: return <h1 id={id}>{content}</h1>
    case 2: return <h2 id={id}>{content}</h2>
    case 3: return <h3 id={id}>{content}</h3>
    case 4: return <h4 id={id}>{content}</h4>
    case 5: return <h5 id={id}>{content}</h5>
    default: return <h6 id={id}>{content}</h6>
  }
}

/**
 * Extract the language and text from a <pre><code class="language-X">...</code></pre>
 * structure that react-markdown produces for fenced code blocks.
 */
function extractCodeFromPre(children: React.ReactNode): { lang: string | null; text: string } | null {
  const child = Children.toArray(children)[0]
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: React.ReactNode }
  const match = /language-(\w+)/.exec(props.className || '')
  return {
    lang: match?.[1] ?? null,
    text: String(props.children ?? '').replace(/\n$/, ''),
  }
}

export const markdownComponents: Components = {
  h1: ({ children, id }) => <HeadingWithAnchor level={1} id={id}>{children}</HeadingWithAnchor>,
  h2: ({ children, id }) => <HeadingWithAnchor level={2} id={id}>{children}</HeadingWithAnchor>,
  h3: ({ children, id }) => <HeadingWithAnchor level={3} id={id}>{children}</HeadingWithAnchor>,
  h4: ({ children, id }) => <HeadingWithAnchor level={4} id={id}>{children}</HeadingWithAnchor>,
  h5: ({ children, id }) => <HeadingWithAnchor level={5} id={id}>{children}</HeadingWithAnchor>,
  h6: ({ children, id }) => <HeadingWithAnchor level={6} id={id}>{children}</HeadingWithAnchor>,

  // Intercept <pre> to detect mermaid blocks (avoids nesting <div> inside <pre>)
  pre: ({ children, ...props }) => {
    const info = extractCodeFromPre(children)
    if (info?.lang === 'mermaid') {
      return <MermaidBlock code={info.text} />
    }
    return <pre {...props}>{children}</pre>
  },

  // Tables: scrollable wrapper
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto my-4 rounded-xl border border-glass-border">
      <table {...props}>{children}</table>
    </div>
  ),

  // Links: rewrite .md links to SPA routes
  a: ({ href, children, ...props }) => {
    if (!href) return <a {...props}>{children}</a>

    const rewritten = rewriteDocLink(href)

    if (rewritten.startsWith('/docs/')) {
      return (
        <RouterLink to={rewritten} {...props}>
          {children}
        </RouterLink>
      )
    }

    if (rewritten.startsWith('#')) {
      return <a href={rewritten} {...props}>{children}</a>
    }

    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    )
  },

  // Images
  img: ({ src, alt, ...props }) => (
    <img src={src} alt={alt ?? ''} loading="lazy" {...props} />
  ),
}
