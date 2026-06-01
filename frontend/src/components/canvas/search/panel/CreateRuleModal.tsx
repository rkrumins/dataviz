/**
 * CreateRuleModal — turn the current Advanced-Search query into a
 * persistent Property Manager display rule.
 *
 * Hosts the shared ``DisplayRuleEditor`` (same editor the Property
 * Manager drawer uses) inside a portal modal, pre-seeded with the
 * query the user just built. Because both surfaces now build their
 * criteria with the same ``VisualQueryBuilder``, the seeded predicate
 * drops straight into the editor — fully editable — and the user just
 * adds a name / colour / icon and hits Create.
 *
 * Rendered via ``createPortal`` (mirrors SaveQueryDialog) so the
 * ``fixed inset-0`` overlay escapes the search panel's framer-motion
 * transform and resolves to the viewport.
 */
import { motion } from 'framer-motion'
import { Tags, X } from 'lucide-react'
import { type FC, useCallback } from 'react'
import { createPortal } from 'react-dom'

import { useToast } from '@/components/ui/toast'
import { DisplayRuleEditor } from '@/components/canvas/property-manager/DisplayRuleEditor'
import { cn, generateId } from '@/lib/utils'
import { useDisplayRules, useReferenceModelStore } from '@/store/referenceModelStore'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'


export interface CreateRuleModalProps {
    viewId: string
    /** The query to seed the rule's criteria with. */
    seedPredicate: Predicate
    knownEntityTypes: string[]
    knownLayers: string[]
    onClose: () => void
}


export const CreateRuleModal: FC<CreateRuleModalProps> = ({
    viewId, seedPredicate, knownEntityTypes, knownLayers, onClose,
}) => {
    const rules = useDisplayRules()
    const addDisplayRule = useReferenceModelStore((s) => s.addDisplayRule)
    const { showToast } = useToast()

    const handleSave = useCallback((rule: DisplayRuleConfig) => {
        addDisplayRule({ ...rule, id: rule.id || generateId('rule') })
        onClose()
        // Optimistic confirmation — the rule engine recomputes the match
        // set asynchronously, so we reassure the user the tag is now live
        // (matching the Property Manager drawer's wording).
        showToast('success', `“${rule.name}” applied — tagging matched entities`)
    }, [addDisplayRule, onClose, showToast])

    // Seed the editor with the current query as a brand-new (id-less)
    // rule. The editor mints a real id on save via its own logic.
    const seed: DisplayRuleConfig = {
        id: '',
        name: '',
        color: '#6366f1',
        predicate: seedPredicate,
        enabled: true,
        createdAt: new Date().toISOString(),
    }

    if (typeof document === 'undefined') return null
    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        >
            <div className="absolute inset-0 bg-black/50" aria-hidden />
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15 }}
                className={cn(
                    'relative w-full max-w-lg rounded-2xl overflow-hidden flex flex-col',
                    'max-h-[88vh]',
                    'bg-canvas-elevated',
                    'border border-slate-200 dark:border-glass-border',
                    'shadow-2xl shadow-black/40',
                )}
                role="dialog"
                aria-modal="true"
                aria-labelledby="create-rule-title"
            >
                {/* Header */}
                <div className={cn(
                    'flex items-center gap-3 px-5 py-4 shrink-0',
                    'border-b border-slate-200 dark:border-glass-border/60',
                )}>
                    <div className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                        'bg-accent-lineage/15',
                    )}>
                        <Tags className="w-5 h-5 text-accent-lineage" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3
                            id="create-rule-title"
                            className="text-[15px] font-display font-bold text-ink leading-tight"
                        >
                            Create display rule
                        </h3>
                        <p className="text-[11.5px] text-ink-muted mt-0.5">
                            Tag every entity matched by this query with a colored chip on the canvas.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={cn(
                            'inline-flex items-center justify-center w-8 h-8 rounded-lg',
                            'text-ink-muted hover:text-ink transition-colors',
                            'hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                        aria-label="Cancel"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body — the shared editor. ``data-search-panel-content``
                    lets the AddFilterPalette popover size to this card. */}
                <div
                    data-search-panel-content
                    className="px-5 py-4 overflow-y-auto custom-scrollbar"
                >
                    <DisplayRuleEditor
                        viewId={viewId}
                        knownEntityTypes={knownEntityTypes}
                        knownLayers={knownLayers}
                        rule={seed}
                        existingNames={rules.map((r) => r.name)}
                        onSave={handleSave}
                        onCancel={onClose}
                    />
                </div>
            </motion.div>
        </div>,
        document.body,
    )
}
