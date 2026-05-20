/**
 * Verb-driven question picker — the "easy" entry point for both
 * business and technical users.
 *
 * Grouped into three sections matching how a user typically thinks
 * about exploring a catalog:
 *
 *   Overview    — get the lay of the land (counts, distributions)
 *   Find        — locate specific things (by name, property, tag)
 *   Discover    — explore metadata coverage and existence
 *
 * Each card carries its own accent color (drawn from a curated
 * palette) so the picker reads as a typed taxonomy of questions,
 * not a flat list. Lucide icon in a gradient container, display
 * font for the label, tasteful hover lift + colored shadow in
 * dark mode.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { type FC, useMemo } from 'react'

import { cn } from '@/lib/utils'

import { TEMPLATES, type SearchTemplate } from './searchTemplates'


/** Grouping the templates makes a long list feel like a curated menu
 * rather than a dump. Each group has a section header. */
const SECTIONS: { id: string; title: string; description: string; templateIds: string[] }[] = [
    {
        id: 'overview',
        title: 'Overview',
        description: 'Get the lay of the land — counts and distributions',
        templateIds: ['overview-by-type', 'overview-by-layer'],
    },
    {
        id: 'find',
        title: 'Find',
        description: 'Locate specific entities by name, property, or tag',
        templateIds: ['find-all-of-type', 'name-contains', 'property-equals',
                      'biggest-by-property', 'tag-matches'],
    },
    {
        id: 'discover',
        title: 'Discover',
        description: 'Explore metadata coverage across your graph',
        templateIds: ['has-property'],
    },
]


/** Per-template accent — picked from a curated palette so cards
 * read as a typed taxonomy. Falls back to lineage. */
const TEMPLATE_ACCENTS: Record<string, {
    iconBg: string
    iconText: string
    shadow: string
    border: string
}> = {
    'overview-by-type':       { iconBg: 'from-accent-lineage/25 to-cyan-500/15', iconText: 'text-accent-lineage', shadow: 'group-hover:shadow-accent-lineage/15', border: 'group-hover:border-accent-lineage/40' },
    'overview-by-layer':      { iconBg: 'from-purple-500/25 to-violet-500/15',    iconText: 'text-purple-600 dark:text-purple-400', shadow: 'group-hover:shadow-purple-500/15', border: 'group-hover:border-purple-500/40' },
    'find-all-of-type':       { iconBg: 'from-emerald-500/25 to-teal-500/15',     iconText: 'text-emerald-600 dark:text-emerald-400', shadow: 'group-hover:shadow-emerald-500/15', border: 'group-hover:border-emerald-500/40' },
    'name-contains':          { iconBg: 'from-sky-500/25 to-blue-500/15',         iconText: 'text-sky-600 dark:text-sky-400', shadow: 'group-hover:shadow-sky-500/15', border: 'group-hover:border-sky-500/40' },
    'property-equals':        { iconBg: 'from-indigo-500/25 to-blue-500/15',      iconText: 'text-indigo-600 dark:text-indigo-400', shadow: 'group-hover:shadow-indigo-500/15', border: 'group-hover:border-indigo-500/40' },
    'biggest-by-property':    { iconBg: 'from-orange-500/25 to-amber-500/15',     iconText: 'text-orange-600 dark:text-orange-400', shadow: 'group-hover:shadow-orange-500/15', border: 'group-hover:border-orange-500/40' },
    'tag-matches':            { iconBg: 'from-amber-500/25 to-yellow-500/15',     iconText: 'text-amber-600 dark:text-amber-400', shadow: 'group-hover:shadow-amber-500/15', border: 'group-hover:border-amber-500/40' },
    'has-property':           { iconBg: 'from-rose-500/25 to-pink-500/15',        iconText: 'text-rose-600 dark:text-rose-400', shadow: 'group-hover:shadow-rose-500/15', border: 'group-hover:border-rose-500/40' },
}

const DEFAULT_ACCENT = {
    iconBg: 'from-accent-lineage/20 to-purple-500/15',
    iconText: 'text-accent-lineage',
    shadow: 'group-hover:shadow-accent-lineage/15',
    border: 'group-hover:border-accent-lineage/40',
}


function iconFor(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


export interface TemplatePickerProps {
    onPick: (template: SearchTemplate) => void
}

export const TemplatePicker: FC<TemplatePickerProps> = ({ onPick }) => {
    // Templates by id for fast section lookups.
    const byId = useMemo(() => {
        const m = new Map<string, SearchTemplate>()
        for (const t of TEMPLATES) m.set(t.id, t)
        return m
    }, [])

    return (
        <div className="flex flex-col gap-6">
            {/* Headline */}
            <div>
                <h2 className="text-lg font-display font-semibold text-ink tracking-tight">
                    What do you want to find?
                </h2>
                <p className="mt-1 text-xs text-ink-muted leading-relaxed max-w-[28rem]">
                    Pick a question to start. The panel rolls up matches by
                    ancestor first, so you can orient before drilling into
                    specific results.
                </p>
            </div>

            {SECTIONS.map((section, sIdx) => {
                const sectionTemplates = section.templateIds
                    .map((id) => byId.get(id))
                    .filter((t): t is SearchTemplate => Boolean(t))
                if (sectionTemplates.length === 0) return null

                return (
                    <motion.div
                        key={section.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                            duration: 0.22,
                            delay: sIdx * 0.04,
                            ease: [0.22, 1, 0.36, 1],
                        }}
                        className="flex flex-col gap-2.5"
                    >
                        <div className="px-1">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                                {section.title}
                            </div>
                            <div className="text-[11px] text-ink-muted/70 mt-0.5">
                                {section.description}
                            </div>
                        </div>

                        {sectionTemplates.map((t, tIdx) => {
                            const Icon = iconFor(t.icon)
                            const accent = TEMPLATE_ACCENTS[t.id] ?? DEFAULT_ACCENT
                            return (
                                <motion.button
                                    key={t.id}
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{
                                        duration: 0.18,
                                        delay: sIdx * 0.04 + tIdx * 0.02,
                                        ease: [0.22, 1, 0.36, 1],
                                    }}
                                    whileHover={{ y: -1 }}
                                    onClick={() => onPick(t)}
                                    className={cn(
                                        "group relative w-full text-left",
                                        "rounded-2xl border border-glass-border",
                                        "bg-gradient-to-br from-canvas-elevated/90 via-canvas-elevated/70 to-canvas-elevated/90",
                                        "backdrop-blur-md",
                                        "p-4",
                                        "shadow-sm transition-all duration-200",
                                        "hover:shadow-lg dark:hover:shadow-xl",
                                        accent.shadow,
                                        accent.border,
                                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                                    )}
                                >
                                    <div className="flex items-start gap-3.5">
                                        <div className={cn(
                                            "shrink-0 w-11 h-11 rounded-xl flex items-center justify-center",
                                            "bg-gradient-to-br shadow-sm",
                                            accent.iconBg,
                                        )}>
                                            <Icon
                                                className={cn("w-5 h-5", accent.iconText)}
                                                strokeWidth={2}
                                            />
                                        </div>
                                        <div className="flex-1 min-w-0 pt-0.5">
                                            <div className="text-sm font-display font-semibold text-ink leading-tight">
                                                {t.label}
                                            </div>
                                            <div className="mt-1 text-xs text-ink-muted leading-snug">
                                                {t.description}
                                            </div>
                                        </div>
                                        <LucideIcons.ChevronRight
                                            className={cn(
                                                "shrink-0 w-4 h-4 text-ink-muted mt-3",
                                                "opacity-0 -translate-x-1",
                                                "group-hover:opacity-100 group-hover:translate-x-0",
                                                "transition-all duration-200",
                                            )}
                                            strokeWidth={2}
                                        />
                                    </div>
                                </motion.button>
                            )
                        })}
                    </motion.div>
                )
            })}
        </div>
    )
}
