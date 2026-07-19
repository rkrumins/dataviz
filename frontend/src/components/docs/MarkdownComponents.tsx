import { Children, isValidElement } from 'react'
import type { Components } from 'react-markdown'
import { Link as RouterLink } from 'react-router-dom'
import { Hash, Info, Lightbulb, AlertCircle, AlertTriangle, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MermaidBlock } from './MermaidBlock'

// Map the actual filenames from docs/ to route slugs. Adding a new doc to
// docsConfig.ts? Add its filename here too, or its relative .md links from
// other docs will fall through to the "external link" branch below instead
// of routing in-SPA.
export const filenameMap: Record<string, string> = {
  'OVERVIEW.md': 'overview',
  'SETUP.md': 'setup',
  'ARCHITECTURE.md': 'architecture',
  'DECISIONS.md': 'decisions',
  'CHANGELOG.md': 'changelog',
  'BACKEND.md': 'backend',
  'FRONTEND.md': 'frontend',
  'DATA_ARCHITECTURE.md': 'data-architecture',
  'API_FEATURES.md': 'api-features',
  'TECHNICAL_DEBT.md': 'technical-debt',
  'SIGNUP_USER_SERVICE_PLAN.md': 'signup-service',
  'architecture-when-scaling.md': 'scaling-architecture',
  'AGGREGATION_PIPELINE.md': 'aggregation-pipeline',
  'local-integration-testing.md': 'integration-testing',
  'VERSIONING_E2E.md': 'versioning-e2e',
  '01-overview-and-architecture.md': 'versioning-overview',
  '06-api-reference.md': 'versioning-api-reference',
  'README-index.md': 'versioning-deep-dives',
  'RBAC.md': 'rbac',
  'SSO.md': 'sso',
  'SSO_INTEGRATION.md': 'sso-integration',
  'DEPLOYMENT.md': 'deployment',
  'FALKORDB_DEPLOYMENT.md': 'falkordb-deployment',
  'FALKORDB_DR_RUNBOOK.md': 'falkordb-dr',
  'INFRASTRUCTURE_LAUNCH_SCALE.md': 'infra-launch-scale',
  'INFRASTRUCTURE_SCALING_250M.md': 'infra-scaling-250m',
  // Platform Services (subfolder; keys path-qualified to avoid basename clashes)
  'services/OVERVIEW.md': 'services-overview',
  'services/INSIGHTS.md': 'services-insights',
  'services/SEARCH.md': 'services-search',
  'services/CONTEXT_ENGINE.md': 'services-context-engine',
  'services/ASSIGNMENTS.md': 'services-assignments',
  'INSIGHTS.md': 'services-insights',
  'SEARCH.md': 'services-search',
  'CONTEXT_ENGINE.md': 'services-context-engine',
  'ASSIGNMENTS.md': 'services-assignments',
}

// ── Callouts ────────────────────────────────────────────────────────
// A blockquote whose first line begins with a recognised label renders as
// an accented callout box. Authors write either GitHub-alert syntax
// (`> [!NOTE]`) or a bold label (`> **Note:** …`); anything else stays a
// plain blockquote. One place, so docs and guide share the treatment.

const CALLOUTS: Record<string, { icon: LucideIcon; box: string; icon_cls: string }> = {
  note: { icon: Info, box: 'border-sky-500/30 bg-sky-500/[0.06]', icon_cls: 'text-sky-500' },
  tip: { icon: Lightbulb, box: 'border-emerald-500/30 bg-emerald-500/[0.06]', icon_cls: 'text-emerald-500' },
  important: { icon: AlertCircle, box: 'border-violet-500/30 bg-violet-500/[0.06]', icon_cls: 'text-violet-500' },
  warning: { icon: AlertTriangle, box: 'border-amber-500/30 bg-amber-500/[0.08]', icon_cls: 'text-amber-500' },
  caution: { icon: AlertTriangle, box: 'border-red-500/30 bg-red-500/[0.06]', icon_cls: 'text-red-500' },
}

/** Recursively pull the plain text out of react-markdown children. */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** Detect a leading callout label, tolerant of `[!NOTE]` or `**Note:**`. */
function calloutKind(children: React.ReactNode): keyof typeof CALLOUTS | null {
  const text = nodeText(children).trimStart()
  const m = /^\[!(\w+)\]|^(note|tip|important|warning|caution)\b\s*:/i.exec(text)
  const raw = (m?.[1] ?? m?.[2] ?? '').toLowerCase()
  return raw in CALLOUTS ? (raw as keyof typeof CALLOUTS) : null
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

  // Blockquotes: render a labelled callout box, else a plain quote
  blockquote: ({ children }) => {
    const kind = calloutKind(children)
    if (!kind) return <blockquote>{children}</blockquote>
    const { icon: Icon, box, icon_cls } = CALLOUTS[kind]
    return (
      <div
        className={cn(
          'my-4 flex gap-3 rounded-xl border px-4 py-3',
          '[&>p]:m-0 [&>p+p]:mt-2 [&_code]:text-[0.85em]',
          box,
        )}
        role="note"
      >
        <Icon className={cn('w-5 h-5 shrink-0 mt-0.5', icon_cls)} aria-hidden />
        <div className="min-w-0 flex-1 text-sm leading-relaxed">{children}</div>
      </div>
    )
  },

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
