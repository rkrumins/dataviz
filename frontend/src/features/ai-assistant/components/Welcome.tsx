/**
 * What the rail shows before the first question: what it can do here, and questions to start
 * from, chosen for where the person is — a selection on a view, a view, anywhere, or Help.
 */
import { motion } from 'framer-motion'
import { ArrowUpRight, BookOpen, Database, ShieldCheck } from 'lucide-react'
import { MOTION } from '@/lib/motion'
import type { AssistantPersona } from '../api/types'
import { starterPrompts, type StarterSituation } from '../lib/starterPrompts'
import { AssistantAvatar } from './MessageView'

export function Welcome({ persona, at, onAsk }: {
    persona: AssistantPersona
    at: StarterSituation
    onAsk: (question: string) => void
}) {
    const prompts = starterPrompts(persona, at)
    const help = persona === 'help'
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto custom-scrollbar px-5 py-8">
            <div className="m-auto flex w-full max-w-sm flex-col items-center text-center">
                <AssistantAvatar size="lg" />
                <h3 className="mt-4 bg-gradient-to-r from-accent-lineage to-violet-600 bg-clip-text text-lg font-semibold text-transparent">
                    {help ? 'How can I help?' : at.onView ? 'Ask about this view' : 'Ask about your data'}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                    {help
                        ? 'Ask how to do something in the product. Answers come from the guide, and say which page they’re from.'
                        : 'Ask about lineage, ownership and what your data holds. Every answer shows how it was found, and what it couldn’t see.'}
                </p>
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
