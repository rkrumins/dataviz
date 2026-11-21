/**
 * What the rail shows before the first question: what it can do here, what it already knows about
 * the page (a one-line card that opens the full "What I know"), and questions to start from,
 * chosen for where the person is — a selection on a view, a view, a page, anywhere, or Help.
 */
import { motion } from 'framer-motion'
import type { UseQueryResult } from '@tanstack/react-query'
import { ArrowUpRight, BookOpen, Database, ShieldCheck } from 'lucide-react'
import { MOTION } from '@/lib/motion'
import type { AssistantPageKind, AssistantPersona, ContextBrief } from '../api/types'
import { starterPrompts, type StarterSituation } from '../lib/starterPrompts'
import { useAssistantStore } from '../store/assistantStore'
import { ContextCard, ContextCardSkeleton } from './ContextCard'
import { AssistantAvatar } from './MessageView'

const HEADING: Partial<Record<AssistantPageKind, string>> = {
    view: 'Ask about this view',
    workspace: 'Ask about this workspace',
    data_source: 'Ask about this data source',
    ontology: 'Ask about this semantic layer',
}

export function Welcome({ persona, at, brief, onAsk }: {
    persona: AssistantPersona
    at: StarterSituation
    /** What it knows about the page, where there is a card for it here. */
    brief: UseQueryResult<ContextBrief> | null
    onAsk: (question: string) => void
}) {
    const prompts = starterPrompts(persona, at, brief?.data)
    const help = persona === 'help'
    const openCard = useAssistantStore((s) => s.setContextOpen)
    const heading = help ? 'How can I help?' : (at.page && HEADING[at.page.kind]) ?? 'Ask about your data'
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto custom-scrollbar px-5 py-8">
            <div className="m-auto flex w-full max-w-sm flex-col items-center text-center">
                <AssistantAvatar size="lg" />
                <h3 className="mt-4 bg-gradient-to-r from-accent-lineage to-violet-600 bg-clip-text text-lg font-semibold text-transparent">
                    {heading}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                    {help
                        ? at.page?.kind === 'doc'
                            ? 'Ask about this page, or how to do something in the product. Answers come from the guide, and say which page they’re from.'
                            : 'Ask how to do something in the product. Answers come from the guide, and say which page they’re from.'
                        : 'Ask about lineage, ownership and what your data holds. Every answer shows how it was found, and what it couldn’t see.'}
                </p>
                {brief && (
                    <div className="mt-5 w-full">
                        {brief.data
                            ? <ContextCard variant="summary" brief={brief.data} onOpen={() => openCard(true)} />
                            : brief.isLoading ? <ContextCardSkeleton variant="summary" /> : null}
                    </div>
                )}
                <ul className="mt-5 w-full space-y-2" aria-label="Questions to start from">
                    {prompts.map((q, i) => (
                        <motion.li key={q} initial={{ opacity: 0, y: MOTION.cardY }} animate={{ opacity: 1, y: 0 }}
                                   transition={{ ...MOTION.cardEntry, delay: Math.min(i, MOTION.staggerMax) * MOTION.cardStagger }}>
                            <button
                                type="button"
                                onClick={() => onAsk(q)}
                                className="group flex w-full items-center gap-2.5 rounded-xl border border-glass-border bg-canvas px-3 py-2.5 text-left text-sm text-ink shadow-sm transition-colors hover:border-accent-lineage/40 hover:bg-accent-lineage/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
                            >
                                {help
                                    ? <BookOpen className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                                    : <Database className="h-4 w-4 shrink-0 text-accent-lineage" aria-hidden />}
                                <span className="min-w-0 flex-1">{q}</span>
                                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-muted transition-colors group-hover:text-accent-lineage" aria-hidden />
                            </button>
                        </motion.li>
                    ))}
                </ul>
                {!help && (
                    <p className="mt-5 flex items-center gap-1.5 text-xs text-ink-muted">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                        It reads only what you can see, and changes nothing.
                    </p>
                )}
            </div>
        </div>
    )
}
