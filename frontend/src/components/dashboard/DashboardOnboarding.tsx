import { motion } from 'framer-motion'
import {
    Database,
    Eye,
    LayoutTemplate,
    CheckCircle2,
    ArrowRight,
    Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface DashboardOnboardingProps {
    completedSteps: string[]
    onCreateWorkspace: () => void
    onBrowseTemplates: () => void
    onDismiss: () => void
}

const ONBOARDING_STEPS = [
    {
        id: 'workspace_created',
        label: 'Connect your first data source',
        description: 'Link a database, warehouse, or API to start exploring your data graph.',
        icon: Database,
        primary: true,
    },
    {
        id: 'first_view',
        label: 'Create your first context view',
        description: 'Save a focused perspective of your graph for quick access later.',
        icon: Eye,
        requiresPrevious: true,
    },
    {
        id: 'template_deployed',
        label: 'Deploy a starter template',
        description: 'Jumpstart your workspace with a pre-built semantic layer and layout.',
        icon: LayoutTemplate,
    },
] as const

export function DashboardOnboarding({
    completedSteps,
    onCreateWorkspace,
    onBrowseTemplates,
    onDismiss,
}: DashboardOnboardingProps) {
    const completedCount = ONBOARDING_STEPS.filter(s =>
        completedSteps.includes(s.id)
    ).length
    const progressPercent = (completedCount / ONBOARDING_STEPS.length) * 100

    const isStepDisabled = (step: (typeof ONBOARDING_STEPS)[number], index: number) => {
        if (completedSteps.includes(step.id)) return false
        if ('requiresPrevious' in step && step.requiresPrevious && index > 0) {
            return !completedSteps.includes(ONBOARDING_STEPS[index - 1].id)
        }
        return false
    }

    return (
        <section className="relative w-full flex flex-col items-center px-4 pt-14 pb-10">
            {/* Ambient glow */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="w-[900px] h-[400px] bg-accent-business/8 blur-[140px] rounded-[100%]" />
            </div>

            {/* Welcome header */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className="relative z-10 text-center mb-10"
            >
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.05, duration: 0.2 }}
                    className="inline-flex items-center gap-2 mb-5 px-4 py-1.5 rounded-full glass-panel border border-accent-business/30 text-accent-business text-sm font-semibold"
                >
                    <Sparkles className="w-3.5 h-3.5" />
                    Getting Started
                </motion.div>
                <h1 className="text-4xl md:text-5xl font-extrabold text-ink tracking-tight mb-3 leading-[1.1]">
                    Welcome to{' '}
                    <span className="bg-gradient-to-r from-accent-business to-accent-explore bg-clip-text text-transparent">
                        Synodic
                    </span>
                </h1>
                <p className="text-base text-ink-muted max-w-md mx-auto">
                    Set up your first workspace in a few quick steps — you'll be exploring your data graph in no time.
                </p>
            </motion.div>

            {/* Checklist card */}
            <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut', delay: 0.1 }}
                className="relative z-10 w-full max-w-lg glass-panel border border-glass-border rounded-2xl overflow-hidden mb-6"
            >
                {/* Progress bar */}
                <div className="px-5 pt-5 pb-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-ink-muted uppercase tracking-widest">
                            Setup Progress
                        </span>
                        <span className="text-xs font-semibold text-ink-muted">
                            {completedCount}/{ONBOARDING_STEPS.length}
                        </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                        <motion.div
                            className="h-full rounded-full bg-accent-business"
                            initial={{ width: 0 }}
                            animate={{ width: `${progressPercent}%` }}
                            transition={{ duration: 0.4, ease: 'easeOut', delay: 0.2 }}
                        />
                    </div>
                </div>

                {/* Steps */}
                <div className="px-2 pb-2">
                    {ONBOARDING_STEPS.map((step, i) => {
                        const completed = completedSteps.includes(step.id)
                        const disabled = isStepDisabled(step, i)
                        const Icon = step.icon

                        return (
                            <motion.button
                                key={step.id}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                    duration: 0.2,
                                    ease: 'easeOut',
                                    delay: 0.15 + i * 0.05,
                                }}
                                disabled={disabled}
                                onClick={() => {
                                    if (completed) return
                                    if (step.id === 'workspace_created') onCreateWorkspace()
                                    if (step.id === 'template_deployed') onBrowseTemplates()
                                }}
                                className={cn(
                                    'w-full flex items-center gap-3.5 px-3 py-3.5 rounded-xl text-left transition-all group/step',
                                    completed
                                        ? 'opacity-60'
                                        : disabled
                                          ? 'opacity-40 cursor-not-allowed'
                                          : 'hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer'
                                )}
                            >
                                {/* Icon */}
                                <div
                                    className={cn(
                                        'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 transition-colors',
                                        completed
                                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                                            : 'primary' in step && step.primary && !disabled
                                              ? 'border-accent-business/40 bg-accent-business/10 text-accent-business'
                                              : 'border-glass-border bg-black/5 dark:bg-white/5 text-ink-muted'
                                    )}
                                >
                                    {completed ? (
                                        <CheckCircle2 className="w-4.5 h-4.5" />
                                    ) : (
                                        <Icon className="w-4.5 h-4.5" />
                                    )}
                                </div>

                                {/* Text */}
                                <div className="flex-1 min-w-0">
                                    <span
                                        className={cn(
                                            'text-sm font-semibold block transition-colors',
                                            completed
                                                ? 'text-ink-muted line-through'
                                                : 'text-ink group-hover/step:text-accent-business'
                                        )}
                                    >
                                        {step.label}
                                    </span>
                                    <span className="text-xs text-ink-muted mt-0.5 block">
                                        {step.description}
                                    </span>
                                </div>

                                {/* Arrow */}
                                {!completed && !disabled && (
                                    <ArrowRight className="w-4 h-4 text-ink-muted/0 group-hover/step:text-accent-business transition-all group-hover/step:translate-x-0.5 shrink-0" />
                                )}
                            </motion.button>
                        )
                    })}
                </div>
            </motion.div>

            {/* Quick-start cards */}
            <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut', delay: 0.2 }}
                className="relative z-10 w-full max-w-lg grid grid-cols-2 gap-3 mb-6"
            >
                {/* Import from Provider */}
                <button
                    onClick={onCreateWorkspace}
                    className="group glass-panel border border-glass-border rounded-xl p-5 text-left hover:border-accent-business/40 hover:bg-accent-business/5 transition-all"
                >
                    <div className="w-10 h-10 rounded-xl border border-accent-business/30 bg-accent-business/10 text-accent-business flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                        <Database className="w-5 h-5" />
                    </div>
                    <span className="text-sm font-semibold text-ink block mb-1 group-hover:text-accent-business transition-colors">
                        Import from a Provider
                    </span>
                    <span className="text-xs text-ink-muted">
                        Connect a database, warehouse, or cloud service.
                    </span>
                </button>

                {/* Start from Template */}
                <button
                    onClick={onBrowseTemplates}
                    className="group glass-panel border border-glass-border rounded-xl p-5 text-left hover:border-accent-business/40 hover:bg-accent-business/5 transition-all"
                >
                    <div className="w-10 h-10 rounded-xl border border-accent-business/30 bg-accent-business/10 text-accent-business flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                        <LayoutTemplate className="w-5 h-5" />
                    </div>
                    <span className="text-sm font-semibold text-ink block mb-1 group-hover:text-accent-business transition-colors">
                        Start from a Template
                    </span>
                    <span className="text-xs text-ink-muted">
                        Use a pre-built semantic layer to get started fast.
                    </span>
                </button>
            </motion.div>

            {/* Skip link */}
            <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, delay: 0.3 }}
                onClick={onDismiss}
                className="relative z-10 text-sm text-ink-muted hover:text-ink transition-colors font-medium"
            >
                Skip for now
            </motion.button>
        </section>
    )
}
