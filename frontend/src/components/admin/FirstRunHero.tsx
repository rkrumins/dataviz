/**
 * FirstRunHero — Full-page onboarding hero shown when no providers exist.
 * Replaces the tab layout entirely and guides the user into the setup wizard.
 */
import { motion } from 'framer-motion'
import { Server, Layers, Database, BookOpen, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FirstRunHeroProps {
    onGetStarted: () => void
}

const STAGES = [
    {
        icon: Server,
        title: 'Connect Infrastructure',
        description: 'Link your FalkorDB, Neo4j or DataHub instance',
        accent: 'bg-indigo-500/10 text-indigo-500',
    },
    {
        icon: Layers,
        title: 'Register Data Sources',
        description: 'Discover and catalog physical graphs',
        accent: 'bg-violet-500/10 text-violet-500',
    },
    {
        icon: Database,
        title: 'Create Workspace',
        description: 'Organize data into isolated domains',
        accent: 'bg-emerald-500/10 text-emerald-500',
    },
    {
        icon: BookOpen,
        title: 'Configure Semantics',
        description: 'Define entity types and relationships',
        accent: 'bg-amber-500/10 text-amber-500',
    },
] as const

export function FirstRunHero({ onGetStarted }: FirstRunHeroProps) {
    return (
        <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-canvas px-6">
            {/* ── Animated background blobs ── */}
            <div
                className="pointer-events-none absolute -left-40 -top-40 h-[500px] w-[500px] rounded-full bg-indigo-500/10 blur-3xl"
                style={{ animation: 'spin 60s linear infinite' }}
            />
            <div
                className="pointer-events-none absolute -bottom-40 -right-40 h-[500px] w-[500px] rounded-full bg-emerald-500/10 blur-3xl"
                style={{ animation: 'spin 45s linear infinite reverse' }}
            />

            {/* ── Heading ── */}
            <motion.h1
                className="relative z-10 text-center text-3xl font-bold text-ink"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
            >
                Set Up Your Data Intelligence Platform
            </motion.h1>

            {/* ── Subheading ── */}
            <motion.p
                className="relative z-10 mx-auto mt-3 max-w-md text-center text-sm text-ink-secondary"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
            >
                Connect your graph databases, register data sources, and configure
                semantic layers — all in one guided flow.
            </motion.p>

            {/* ── Stage cards row ── */}
            <div className="relative z-10 mt-10 flex items-center gap-3">
                {STAGES.map((stage, index) => {
                    const Icon = stage.icon
                    return (
                        <div key={stage.title} className="flex items-center gap-3">
                            <motion.div
                                className="glass-panel-subtle flex w-40 flex-col items-center rounded-2xl p-5 text-center"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.4, delay: index * 0.15 }}
                            >
                                <div
                                    className={cn(
                                        'flex h-10 w-10 items-center justify-center rounded-xl',
                                        stage.accent,
                                    )}
                                >
                                    <Icon className="h-5 w-5" />
                                </div>
                                <span className="mt-3 text-xs font-semibold text-ink">
                                    {stage.title}
                                </span>
                                <span className="mt-1 text-[10px] leading-tight text-ink-muted">
                                    {stage.description}
                                </span>
                            </motion.div>

                            {index < STAGES.length - 1 && (
                                <ChevronRight className="h-4 w-4 shrink-0 animate-pulse text-ink-muted" />
                            )}
                        </div>
                    )
                })}
            </div>

            {/* ── CTA ── */}
            <motion.button
                onClick={onGetStarted}
                className={cn(
                    'relative z-10 mt-10 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500',
                    'px-8 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20',
                    'transition-colors hover:from-indigo-500 hover:to-indigo-400',
                )}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.7 }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
            >
                Get Started
            </motion.button>

            <motion.span
                className="relative z-10 mt-3 text-[10px] uppercase tracking-wider text-ink-muted"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.9 }}
            >
                Takes about 3 minutes to complete
            </motion.span>
        </div>
    )
}
