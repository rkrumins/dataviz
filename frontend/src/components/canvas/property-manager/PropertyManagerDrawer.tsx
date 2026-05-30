/**
 * PropertyManagerDrawer — the reusable right-side Property Manager for
 * canvas views. v1 ships the "display rules → tag overlay" experience:
 *
 *   • Properties tab — browse every property key / value / tag in use
 *     across the view (sourced from Advanced-Search discovery), with a
 *     one-click handoff to create a rule from any of them.
 *   • Display rules tab — CRUD the saved rules; each tags its matched
 *     entities with a colored chip on the canvas. Rules persist in the
 *     view blueprint via Save Blueprint.
 *
 * Built as a ``motion.aside`` flex-sibling (mirrors EntityDrawer) so it
 * shrinks the canvas rather than overlaying it, and is driven purely by
 * props + the referenceModelStore — no canvas coupling — so other
 * canvases can mount it with just a ``viewId``.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Layers, SlidersHorizontal, Tags, X } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import {
    useDisplayRules,
    useReferenceModelStore,
} from '@/store/referenceModelStore'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { DisplayRuleEditor } from './DisplayRuleEditor'
import { DisplayRuleList } from './DisplayRuleList'
import { PropertyBrowser } from './PropertyBrowser'


export interface PropertyManagerDrawerProps {
    /** Active view this manager is bound to. Drives discovery + rule scope. */
    viewId: string
    open: boolean
    onClose: () => void
    /** Entity types known to the active view (for the criteria builder). */
    knownEntityTypes?: string[]
    /** Layer names from the view config (for the criteria builder). */
    knownLayers?: string[]
}

type Tab = 'properties' | 'rules'

/** Editor target: a brand-new rule (optionally seeded), or an edit. */
type EditorState =
    | { mode: 'closed' }
    | { mode: 'new'; seed?: DisplayRuleConfig }
    | { mode: 'edit'; rule: DisplayRuleConfig }


export function PropertyManagerDrawer({
    viewId, open, onClose, knownEntityTypes = [], knownLayers = [],
}: PropertyManagerDrawerProps) {
    const [tab, setTab] = useState<Tab>('rules')
    const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })

    const rules = useDisplayRules()
    const addDisplayRule = useReferenceModelStore((s) => s.addDisplayRule)
    const updateDisplayRule = useReferenceModelStore((s) => s.updateDisplayRule)
    const removeDisplayRule = useReferenceModelStore((s) => s.removeDisplayRule)
    const toggleDisplayRule = useReferenceModelStore((s) => s.toggleDisplayRule)

    const handleSaveRule = (rule: DisplayRuleConfig) => {
        if (rules.some((r) => r.id === rule.id)) {
            updateDisplayRule(rule.id, rule)
        } else {
            addDisplayRule(rule)
        }
        setEditor({ mode: 'closed' })
    }

    const handleCreateFromPredicate = (predicate: Predicate, suggestedName: string) => {
        setTab('rules')
        setEditor({
            mode: 'new',
            seed: {
                id: '', // assigned on save
                name: suggestedName,
                color: '#6366f1',
                predicate,
                enabled: true,
                createdAt: new Date().toISOString(),
            },
        })
    }

    return (
        <AnimatePresence>
            {open && (
                <motion.aside
                    data-panel="property-manager"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 'clamp(380px, 30vw, 520px)', opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                    className={cn(
                        'relative h-full flex-shrink-0 overflow-hidden',
                        'bg-canvas-elevated/98 backdrop-blur-2xl',
                        'border-l border-glass-border shadow-lg shadow-black/20',
                    )}
                >
                    <div className="w-[clamp(380px,30vw,520px)] h-full flex flex-col overflow-hidden">
                        {/* Header */}
                        <div className="flex-shrink-0 p-4 border-b border-glass-border/50 bg-gradient-to-br from-accent-lineage/[0.08] to-transparent">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="w-8 h-8 rounded-xl bg-accent-lineage/15 flex items-center justify-center">
                                        <SlidersHorizontal className="w-4 h-4 text-accent-lineage" />
                                    </span>
                                    <div>
                                        <h2 className="text-sm font-display font-semibold text-ink leading-tight">
                                            Property Manager
                                        </h2>
                                        <p className="text-[10px] text-ink-muted/80">
                                            Browse properties · tag matched entities
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={onClose}
                                    aria-label="Close Property Manager"
                                    className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-white/10 transition-colors"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            {/* Tabs */}
                            <div className="mt-3 flex items-center gap-1 p-1 rounded-xl bg-canvas-base/40 border border-glass-border/40">
                                <TabButton
                                    active={tab === 'rules'}
                                    onClick={() => { setTab('rules'); setEditor({ mode: 'closed' }) }}
                                    icon={<Tags className="w-3.5 h-3.5" />}
                                    label="Display rules"
                                    count={rules.length}
                                />
                                <TabButton
                                    active={tab === 'properties'}
                                    onClick={() => { setTab('properties'); setEditor({ mode: 'closed' }) }}
                                    icon={<Layers className="w-3.5 h-3.5" />}
                                    label="Properties"
                                />
                            </div>
                        </div>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                            {tab === 'properties' && (
                                <PropertyBrowser
                                    viewId={viewId}
                                    onCreateRuleFromPredicate={handleCreateFromPredicate}
                                />
                            )}
                            {tab === 'rules' && (
                                editor.mode === 'closed' ? (
                                    <DisplayRuleList
                                        rules={rules}
                                        onNew={() => setEditor({ mode: 'new' })}
                                        onEdit={(rule) => setEditor({ mode: 'edit', rule })}
                                        onToggle={toggleDisplayRule}
                                        onDelete={removeDisplayRule}
                                    />
                                ) : (
                                    <DisplayRuleEditor
                                        viewId={viewId}
                                        knownEntityTypes={knownEntityTypes}
                                        knownLayers={knownLayers}
                                        rule={editor.mode === 'edit' ? editor.rule : editor.seed}
                                        onSave={handleSaveRule}
                                        onCancel={() => setEditor({ mode: 'closed' })}
                                    />
                                )
                            )}
                        </div>
                    </div>
                </motion.aside>
            )}
        </AnimatePresence>
    )
}


function TabButton({
    active, onClick, icon, label, count,
}: {
    active: boolean
    onClick: () => void
    icon: React.ReactNode
    label: string
    count?: number
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all',
                active
                    ? 'bg-accent-lineage/20 text-accent-lineage shadow-sm'
                    : 'text-ink-muted hover:text-ink hover:bg-glass/30',
            )}
        >
            {icon}
            {label}
            {typeof count === 'number' && count > 0 && (
                <span className="px-1.5 py-0.5 rounded-md bg-accent-lineage/20 text-[10px] tabular-nums">
                    {count}
                </span>
            )}
        </button>
    )
}
