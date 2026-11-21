/**
 * AnswerMarkdown — the answer's words. The model's output is user content: it is rendered with
 * the user-content map (no Mermaid, no docs widgets), never the docs' own. A `[1]` that names a
 * source becomes a link to it in the list beneath; while the words stream, a caret follows them.
 */
import { useMemo, type ComponentProps, type ReactElement } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { userContentMarkdownComponents } from '@/components/docs/MarkdownComponents'
import { cn } from '@/lib/utils'
import { CITE_HREF, linkCitations } from '../lib/citations'

const BaseLink = userContentMarkdownComponents.a as (props: ComponentProps<'a'> & { node?: unknown }) => ReactElement

export function AnswerMarkdown({ text, cited, anchorPrefix, streaming = false }: {
    text: string
    /** The source numbers the answer may cite. */
    cited: ReadonlySet<number>
    /** Prefix of the source list's anchors (`<prefix>-cite-<n>`). */
    anchorPrefix: string
    streaming?: boolean
}) {
    const components = useMemo<Components>(() => ({
        ...userContentMarkdownComponents,
        a: ({ node: _node, href, children, ...props }) => {
            if (href?.startsWith(CITE_HREF)) {
                const n = href.slice(CITE_HREF.length)
                return (
                    <a
                        href={href}
                        aria-label={`Source ${n}`}
                        onClick={(e) => {
                            e.preventDefault()
                            document.getElementById(`${anchorPrefix}-cite-${n}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                        }}
                        className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded bg-emerald-500/10 px-1 align-baseline text-2xs font-bold tabular-nums text-emerald-700 no-underline hover:bg-emerald-500/20 dark:text-emerald-300"
                    >
                        {n}
                    </a>
                )
            }
            return <BaseLink href={href} {...props}>{children}</BaseLink>
        },
    }), [anchorPrefix])
    const source = useMemo(() => linkCitations(text, cited), [text, cited])

    return (
        <div className={cn(
            'prose-synodic max-w-none break-words text-sm text-ink',
            '[&_h1]:mb-2 [&_h1]:text-base [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:border-0 [&_h2]:pb-0 [&_h2]:text-sm',
            '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h4]:text-sm [&_ol]:mb-2.5 [&_p:last-child]:mb-0 [&_p]:mb-2.5',
            '[&_pre]:text-xs [&_table]:text-xs [&_ul]:mb-2.5',
            // The typing caret, after the last thing written.
            streaming && cn('[&>*:last-child]:after:ml-0.5 [&>*:last-child]:after:inline-block [&>*:last-child]:after:h-3.5',
                '[&>*:last-child]:after:w-1.5 [&>*:last-child]:after:translate-y-0.5 [&>*:last-child]:after:rounded-sm',
                '[&>*:last-child]:after:bg-accent-lineage [&>*:last-child]:after:align-baseline [&>*:last-child]:after:content-[""]',
                '[&>*:last-child]:after:animate-pulse motion-reduce:[&>*:last-child]:after:animate-none'),
        )}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>
        </div>
    )
}
