/**
 * Verb-driven question picker — the "easy" entry point for both
 * business and technical users. Each row is a tactile card:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [icon]  Layout by layer                              │
 *   │         Bucket every node by the value of a property │
 *   └──────────────────────────────────────────────────────┘
 *
 * Stagger-animated on first mount; subtle hover lift; click triggers
 * the parent's `selectTemplate`. No JSON, no predicate vocabulary.
 */
import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { type FC } from 'react'

import { cn } from '@/lib/utils'

import { TEMPLATES, type SearchTemplate } from './searchTemplates'


function iconFor(name: string): FC<{ className?: string }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


export interface TemplatePickerProps {
    onPick: (template: SearchTemplate) => void
}

export const TemplatePicker: FC<TemplatePickerProps> = ({ onPick }) => (
    <div className="space-y-2.5">
        <div className="px-1 mb-1">
            <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                What do you want to find?
            </div>
            <div className="text-xs text-ink-muted/70 mt-0.5">
                Pick a question to start. You can refine the parameters next.
            </div>
        </div>
        {TEMPLATES.map((t, i) => {
            const Icon = iconFor(t.icon)
            return (
                <motion.button
                    key={t.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                        duration: 0.18,
                        delay: i * 0.025,
                        ease: [0.22, 1, 0.36, 1],
                    }}
                    whileHover={{ y: -1 }}
                    onClick={() => onPick(t)}
                    className={cn(
                        "group w-full text-left",
                        "rounded-xl border border-glass-border",
                        "bg-canvas-elevated/60 backdrop-blur-sm",
                        "px-3.5 py-3 transition-all duration-150",
                        "hover:border-accent-lineage/50 hover:bg-canvas-elevated/90",
                        "hover:shadow-node-hover",
                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                    )}
                >
                    <div className="flex items-start gap-3">
                        <div className={cn(
                            "shrink-0 w-9 h-9 rounded-lg flex items-center justify-center",
                            "bg-accent-lineage/10 text-accent-lineage",
                            "group-hover:bg-accent-lineage/20",
                            "transition-colors",
                        )}>
                            <Icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-ink">
                                {t.label}
                            </div>
                            <div className="text-xs text-ink-muted leading-snug mt-0.5">
                                {t.description}
                            </div>
                        </div>
                        <LucideIcons.ChevronRight
                            className={cn(
                                "shrink-0 w-4 h-4 text-ink-muted mt-2",
                                "opacity-0 -translate-x-1",
                                "group-hover:opacity-100 group-hover:translate-x-0",
                                "transition-all duration-150",
                            )}
                        />
                    </div>
                </motion.button>
            )
        })}
    </div>
)
