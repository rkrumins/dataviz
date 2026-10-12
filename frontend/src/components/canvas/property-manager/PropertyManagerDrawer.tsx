/**
 * PropertyManagerDrawer — the reusable right-side Property Manager for
 * canvas views. v1 ships the "display rules → tag overlay" experience:
 *
 *   • Properties tab — browse every property key / value / tag in use
 *     across the view (sourced from Advanced-Search discovery), with a
 *     one-click handoff to create a rule from any of them.
 *   • Display rules tab — CRUD the view's rules; each tags its matched
 *     entities with a colored chip on the canvas. Every change is saved to
 *     the view's library as it is made (on a draft, to the draft's own
 *     rules), and the library exports to — and imports from — a file.
 *
 * Built as a ``motion.aside`` flex-sibling (mirrors EntityDrawer) so it
 * shrinks the canvas rather than overlaying it, and is driven purely by
 * props + the referenceModelStore and viewLibraryStore — no canvas
 * coupling — so other canvases can mount it with just a ``viewId``.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Download, Loader2, RefreshCw, SlidersHorizontal, Tags, Layers, Upload, X } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import { useAppNotifications } from '@/components/ui/notifications'
import { exportViewLibrary, type LibraryImportResult } from '@/services/viewLibraryService'
import { useDisplayRules } from '@/store/referenceModelStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { DisplayRuleEditor } from './DisplayRuleEditor'
import { DisplayRuleList } from './DisplayRuleList'
import { LibraryImportDialog } from './LibraryImportDialog'
import { PropertyBrowser } from './PropertyBrowser'
import { saveLibraryFile } from './libraryFile'
import { MOTION } from '@/lib/motion'


export interface PropertyManagerDrawerProps {
    /** Active view this manager is bound to. Drives discovery + rule scope. */
    viewId: string
    open: boolean
    onClose: () => void
    /** Entity types known to the active view (for the criteria builder). */
    knownEntityTypes?: string[]
    /** Layer names from the view config (for the criteria builder). */
    knownLayers?: string[]
    /** Open the Advanced Search panel seeded + run with a predicate
     *  (the canvas owns the panel open-state). Powers the Properties
     *  tab's value clicks / quick actions. */
    onSearchPredicate?: (predicate: Predicate) => void
}

type Tab = 'properties' | 'rules'

/** Editor target: a brand-new rule (optionally seeded), or an edit. */
type EditorState =
    | { mode: 'closed' }
    | { mode: 'new'; seed?: DisplayRuleConfig }
    | { mode: 'edit'; rule: DisplayRuleConfig }


export function PropertyManagerDrawer({
    viewId, open, onClose, knownEntityTypes = [], knownLayers = [], onSearchPredicate,
}: PropertyManagerDrawerProps) {
    const [tab, setTab] = useState<Tab>('rules')
    const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })

    const [importOpen, setImportOpen] = useState(false)

    const rules = useDisplayRules()
    // The library the canvas loaded, when it is this view's.
    const libraryStatus = useViewLibraryStore((s) => (s.viewId === viewId ? s.status : 'loading'))
    const libraryError = useViewLibraryStore((s) => s.error)
    const canEdit = useViewLibraryStore((s) => s.viewId === viewId && s.canEdit)
    const branchId = useViewLibraryStore((s) => s.branchId)
    const saveRule = useViewLibraryStore((s) => s.saveRule)
    const removeRule = useViewLibraryStore((s) => s.removeRule)
    const toggleRule = useViewLibraryStore((s) => s.toggleRule)
    const reorderRules = useViewLibraryStore((s) => s.reorderRules)
    const reloadLibrary = useViewLibraryStore((s) => s.reload)
    const { notify } = useAppNotifications()

    const reportFailure = (what: string) => (e: unknown) =>
        notify('error', `Couldn't ${what} — ${(e as Error).message}`)

    /** Saved when the server says so; a refusal stays in the editor. */
    const handleSaveRule = async (rule: DisplayRuleConfig) => {
        const isUpdate = rules.some((r) => r.id === rule.id)
        await saveRule(rule)
        setEditor({ mode: 'closed' })
        // Premium feedback: confirm the rule applied. The engine recomputes
        // the match set asynchronously; the notification reassures the user the
        // tag is now live on the canvas.
        notify('success', `“${rule.name}” ${isUpdate ? 'updated' : 'applied'} — tagging matched entities`)
    }

    /** Reveal a rule's matches by running its criteria as a search: the
     *  search panel lists every match in the view with its exact count,
     *  lights them up on the canvas and badges the containers they sit
     *  in — the same answer, and the same controls, as any search. */
    const handleRevealRule = (rule: DisplayRuleConfig) => {
        if (!onSearchPredicate) return
        onSearchPredicate(rule.predicate as Predicate)
        notify('info', `Showing the matches for “${rule.name}”`)
    }

    // Names of OTHER rules — feeds the editor's duplicate-name guard.
    const otherNames = rules
        .filter((r) => (editor.mode === 'edit' ? r.id !== editor.rule.id : true))
        .map((r) => r.name)

    const handleExport = async () => {
        try {
            saveLibraryFile(await exportViewLibrary(viewId, branchId))
        } catch (e) {
            reportFailure('export the library')(e)
        }
    }

    const handleImported = (result: LibraryImportResult) => {
        setImportOpen(false)
        notify('success', `Imported ${result.added.toLocaleString()} ${result.added === 1 ? 'item' : 'items'} into this view`)
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
        <>
        <AnimatePresence>
            {open && (
                <motion.aside
                    data-panel="property-manager"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 'clamp(380px, 30vw, 520px)', opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={MOTION.drawerSlide}
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

                        {/* Body — animated list ⇄ editor transition.
                            ``min-h-0`` lets this flex child shrink below its
                            content so ``overflow-y-auto`` actually scrolls
                            (without it the body grows past the overflow-hidden
                            shell and clips — the Properties tab "won't scroll"
                            bug). */}
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
                            {tab === 'properties' && (
                                <PropertyBrowser
                                    viewId={viewId}
                                    knownEntityTypes={knownEntityTypes}
                                    knownLayers={knownLayers}
                                    onCreateRuleFromPredicate={handleCreateFromPredicate}
                                    onSearchPredicate={onSearchPredicate}
                                />
                            )}
                            {tab === 'rules' && (
                                <AnimatePresence mode="wait" initial={false}>
                                    {editor.mode === 'closed' ? (
                                        <motion.div
                                            key="rule-list"
                                            initial={{ opacity: 0, x: -8 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -8 }}
                                            transition={{ duration: 0.16 }}
                                        >
                                            {libraryStatus === 'loading' && rules.length === 0 ? (
                                                <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-muted">
                                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    Loading this view's rules…
                                                </div>
                                            ) : libraryStatus === 'error' ? (
                                                <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-center">
                                                    <p className="text-xs text-ink">Couldn't load this view's rules</p>
                                                    <p className="mt-1 text-[11px] text-ink-muted">{libraryError}</p>
                                                    <button
                                                        type="button"
                                                        onClick={() => void reloadLibrary()}
                                                        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-lineage/15 text-accent-lineage hover:bg-accent-lineage/25 transition-colors"
                                                    >
                                                        <RefreshCw className="w-3.5 h-3.5" /> Try again
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
                                                    <DisplayRuleList
                                                        rules={rules}
                                                        readOnly={!canEdit}
                                                        onNew={() => setEditor({ mode: 'new' })}
                                                        onEdit={(rule) => setEditor({ mode: 'edit', rule })}
                                                        onToggle={(id) => { toggleRule(id).catch(reportFailure('change the rule')) }}
                                                        onDelete={(id) => { removeRule(id).catch(reportFailure('delete the rule')) }}
                                                        onReorder={(ids) => { reorderRules(ids).catch(reportFailure('reorder the rules')) }}
                                                        onReveal={handleRevealRule}
                                                    />
                                                    <LibraryActions
                                                        canImport={canEdit}
                                                        onExport={() => void handleExport()}
                                                        onImport={() => setImportOpen(true)}
                                                    />
                                                </>
                                            )}
                                        </motion.div>
                                    ) : (
                                        <motion.div
                                            key="rule-editor"
                                            initial={{ opacity: 0, x: 8 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: 8 }}
                                            transition={{ duration: 0.16 }}
                                        >
                                            <DisplayRuleEditor
                                                viewId={viewId}
                                                knownEntityTypes={knownEntityTypes}
                                                knownLayers={knownLayers}
                                                rule={editor.mode === 'edit' ? editor.rule : editor.seed}
                                                existingNames={otherNames}
                                                onSave={handleSaveRule}
                                                onCancel={() => setEditor({ mode: 'closed' })}
                                            />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            )}
                        </div>
                    </div>
                </motion.aside>
            )}
        </AnimatePresence>
        {importOpen && (
            <LibraryImportDialog
                viewId={viewId}
                branchId={branchId}
                onClose={() => setImportOpen(false)}
                onImported={handleImported}
            />
        )}
        </>
    )
}


/** Take the view's rules and saved queries elsewhere, or bring another
 *  view's in. */
function LibraryActions({ canImport, onExport, onImport }: {
    canImport: boolean
    onExport: () => void
    onImport: () => void
}) {
    const button = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors'
    return (
        <div className="mt-4 pt-3 border-t border-glass-border flex items-center gap-1">
            <span className="mr-auto text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                Rules &amp; saved queries
            </span>
            <button type="button" onClick={onExport} className={button}
                title="Download this view's display rules and saved queries as a file">
                <Download className="w-3.5 h-3.5" /> Export
            </button>
            {canImport && (
                <button type="button" onClick={onImport} className={button}
                    title="Add display rules and saved queries from a library file">
                    <Upload className="w-3.5 h-3.5" /> Import…
                </button>
            )}
        </div>
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
