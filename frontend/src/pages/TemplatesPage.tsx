/**
 * TemplatesPage — gallery + CRUD for ContextViewCanvas templates.
 *
 * URL-synced filter state (`?scope=`, `?search=`, `?sort=`, `?category=`,
 * `?tag=`) so deep links land on the same view a teammate shared.
 *
 * Composition:
 *   - Sticky header with title + "New template" menu
 *   - Two-column body: filters (left) + gallery (right)
 *   - Drawer for template detail; portal-mounted dialogs for create / edit
 *     / duplicate / delete / import flows.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
    LayoutTemplate, Plus, ChevronDown, Sparkles, Wand2, Copy, Upload,
} from 'lucide-react'
import { useWorkspacesStore } from '@/store/workspaces'
import { useToast } from '@/components/ui/toast'
import { useTemplatesList } from '@/hooks/useTemplates'
import type { ContextModel, TemplateListFilter } from '@/services/contextModelService'
import { TemplateCard, type TemplateCardAction } from '@/components/templates/TemplateCard'
import { TemplateFilters } from '@/components/templates/TemplateFilters'
import { TemplateDetailDrawer } from '@/components/templates/TemplateDetailDrawer'
import { DeleteTemplateDialog } from '@/components/templates/dialogs/DeleteTemplateDialog'
import { DuplicateTemplateDialog } from '@/components/templates/dialogs/DuplicateTemplateDialog'
import { ImportTemplateDialog } from '@/components/templates/dialogs/ImportTemplateDialog'
import { TemplateWizard } from '@/components/templates/wizard/TemplateWizard'
import { cn } from '@/lib/utils'

const VALID_SCOPES = new Set(['all', 'global', 'workspace'])
const VALID_SORTS = new Set(['recent', 'popular', 'name'])

function parseFilterFromUrl(
    params: URLSearchParams,
    workspaceId: string | null,
): TemplateListFilter {
    const rawScope = params.get('scope') ?? 'all'
    const rawSort = params.get('sort') ?? 'recent'
    return {
        scope: VALID_SCOPES.has(rawScope) ? (rawScope as TemplateListFilter['scope']) : 'all',
        sort: VALID_SORTS.has(rawSort) ? (rawSort as TemplateListFilter['sort']) : 'recent',
        search: params.get('search') ?? undefined,
        category: params.get('category') ?? undefined,
        tag: params.get('tag') ?? undefined,
        workspaceId: workspaceId ?? undefined,
    }
}

function filterToUrl(filter: TemplateListFilter): Record<string, string> {
    const next: Record<string, string> = {}
    if (filter.scope && filter.scope !== 'all') next.scope = filter.scope
    if (filter.sort && filter.sort !== 'recent') next.sort = filter.sort
    if (filter.search) next.search = filter.search
    if (filter.category) next.category = filter.category
    if (filter.tag) next.tag = filter.tag
    return next
}

export function TemplatesPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const { showToast } = useToast()

    useEffect(() => {
        document.title = 'Templates · Synodic'
    }, [])

    const filter = useMemo(
        () => parseFilterFromUrl(searchParams, activeWorkspaceId),
        [searchParams, activeWorkspaceId],
    )

    const updateFilter = useCallback((next: TemplateListFilter) => {
        setSearchParams(filterToUrl(next), { replace: true })
    }, [setSearchParams])

    const { data: templates = [], isLoading, isError, refetch } = useTemplatesList(filter)

    const { categories, tags } = useMemo(() => {
        const catSet = new Set<string>()
        const tagSet = new Set<string>()
        for (const t of templates) {
            if (t.category) catSet.add(t.category)
            for (const tag of t.tags) tagSet.add(tag)
        }
        return {
            categories: Array.from(catSet).sort(),
            tags: Array.from(tagSet).sort(),
        }
    }, [templates])

    // ── Dialog/drawer state ────────────────────────────────────────
    const [detail, setDetail] = useState<ContextModel | null>(null)
    const [editing, setEditing] = useState<ContextModel | null>(null)
    const [wizardOpen, setWizardOpen] = useState(false)
    const [duplicating, setDuplicating] = useState<ContextModel | null>(null)
    const [deleting, setDeleting] = useState<ContextModel | null>(null)
    const [importing, setImporting] = useState(false)
    const [createMenuOpen, setCreateMenuOpen] = useState(false)
    const createMenuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!createMenuOpen) return
        const onClick = (e: MouseEvent) => {
            if (!createMenuRef.current?.contains(e.target as Node)) setCreateMenuOpen(false)
        }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [createMenuOpen])

    const handleExport = useCallback((template: ContextModel) => {
        const payload = {
            name: template.name,
            description: template.description,
            category: template.category,
            layersConfig: template.layersConfig,
            scopeFilter: template.scopeFilter,
            scopeEdgeConfig: template.scopeEdgeConfig,
            icon: template.icon,
            accentColor: template.accentColor,
            maintainer: template.maintainer,
            aboutMarkdown: template.aboutMarkdown,
            tags: template.tags,
            visibility: template.visibility,
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${template.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'template'}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        showToast('success', `Exported "${template.name}".`)
    }, [showToast])

    const handleCardAction = useCallback((action: TemplateCardAction, template: ContextModel) => {
        switch (action) {
            case 'open':      setDetail(template); break
            case 'edit':      setEditing(template); setWizardOpen(true); break
            case 'duplicate': setDuplicating(template); break
            case 'export':    handleExport(template); break
            case 'delete':    setDeleting(template); break
        }
    }, [handleExport])

    const openCreateWizard = () => {
        setEditing(null)
        setWizardOpen(true)
        setCreateMenuOpen(false)
    }

    const openSaveAsTemplateFromActiveCanvas = () => {
        showToast('info', 'Open a canvas and use "Save as template" to capture its current state.')
        setCreateMenuOpen(false)
    }

    return (
        <div className="flex-1 overflow-y-auto bg-canvas">
            {/* Header */}
            <header className="sticky top-0 z-20 backdrop-blur-xl bg-canvas/80 border-b border-glass-border">
                <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20 shrink-0">
                            <LayoutTemplate className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-xl font-bold text-ink tracking-tight">Templates</h1>
                            <p className="text-xs text-ink-muted">
                                Reusable ContextViewCanvas blueprints for your workspaces
                            </p>
                        </div>
                    </div>

                    <div ref={createMenuRef} className="relative">
                        <button
                            onClick={() => setCreateMenuOpen((o) => !o)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:bg-accent-lineage/90 transition-colors shadow-sm shadow-accent-lineage/20"
                        >
                            <Plus className="w-4 h-4" />
                            New template
                            <ChevronDown className="w-3.5 h-3.5 opacity-80" />
                        </button>
                        {createMenuOpen && (
                            <div className="absolute right-0 top-full mt-1 w-72 rounded-xl border border-glass-border bg-canvas-elevated shadow-xl shadow-black/20 py-1.5 z-30">
                                <CreateMenuItem
                                    icon={Wand2}
                                    label="Build from scratch"
                                    description="Step through metadata, layers, and preview"
                                    onClick={openCreateWizard}
                                />
                                <CreateMenuItem
                                    icon={Sparkles}
                                    label="Save current canvas"
                                    description="Capture the canvas you're working on"
                                    onClick={openSaveAsTemplateFromActiveCanvas}
                                />
                                <CreateMenuItem
                                    icon={Copy}
                                    label="Duplicate an existing template"
                                    description="Pick a template from the gallery"
                                    onClick={() => {
                                        showToast('info', 'Click the kebab menu on any template card and choose "Duplicate".')
                                        setCreateMenuOpen(false)
                                    }}
                                />
                                <CreateMenuItem
                                    icon={Upload}
                                    label="Import from JSON"
                                    description="Paste or drop an exported payload"
                                    onClick={() => {
                                        setImporting(true)
                                        setCreateMenuOpen(false)
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </header>

            {/* Body */}
            <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-6">
                {/* Filters */}
                <aside className="lg:sticky lg:top-[101px] lg:self-start">
                    <div className="glass-panel rounded-xl border border-glass-border p-4">
                        <TemplateFilters
                            filter={filter}
                            onChange={updateFilter}
                            categories={categories}
                            tags={tags}
                            isWorkspaceContext={!!activeWorkspaceId}
                        />
                    </div>
                </aside>

                {/* Gallery */}
                <section>
                    {isLoading ? (
                        <SkeletonGrid />
                    ) : isError ? (
                        <ErrorState onRetry={refetch} />
                    ) : templates.length === 0 ? (
                        <EmptyState onCreate={openCreateWizard} onImport={() => setImporting(true)} />
                    ) : (
                        <AnimatePresence mode="popLayout">
                            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                                {templates.map((t, i) => (
                                    <TemplateCard
                                        key={t.id}
                                        template={t}
                                        delayMs={Math.min(i, 8) * 30}
                                        onMenuAction={handleCardAction}
                                        onOpen={(template) => setDetail(template)}
                                    />
                                ))}
                            </div>
                        </AnimatePresence>
                    )}
                </section>
            </div>

            {/* Drawer */}
            <TemplateDetailDrawer
                template={detail}
                onClose={() => setDetail(null)}
                onEdit={(t) => { setDetail(null); setEditing(t); setWizardOpen(true) }}
                onDuplicate={(t) => { setDetail(null); setDuplicating(t) }}
                onDelete={(t) => { setDetail(null); setDeleting(t) }}
                onExport={(t) => handleExport(t)}
            />

            {/* Dialogs */}
            <TemplateWizard
                isOpen={wizardOpen}
                onClose={() => { setWizardOpen(false); setEditing(null) }}
                editing={editing}
                activeWorkspaceId={activeWorkspaceId}
                onSaved={() => { /* React Query invalidation handles refresh */ }}
            />
            <DuplicateTemplateDialog
                isOpen={duplicating !== null}
                template={duplicating}
                onClose={() => setDuplicating(null)}
                activeWorkspaceId={activeWorkspaceId}
            />
            <DeleteTemplateDialog
                isOpen={deleting !== null}
                template={deleting}
                onClose={() => setDeleting(null)}
            />
            <ImportTemplateDialog
                isOpen={importing}
                onClose={() => setImporting(false)}
                activeWorkspaceId={activeWorkspaceId}
            />
        </div>
    )
}

function CreateMenuItem({
    icon: Icon, label, description, onClick,
}: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    description: string
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full px-3 py-2.5 text-left flex items-start gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
            <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 bg-accent-lineage/10 text-accent-lineage">
                <Icon className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{label}</div>
                <div className="text-[11px] text-ink-muted leading-snug">{description}</div>
            </div>
        </button>
    )
}

function SkeletonGrid() {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
                <div
                    key={i}
                    className="glass-panel rounded-2xl border border-glass-border p-5 animate-pulse"
                >
                    <div className="flex items-start gap-3 mb-3">
                        <div className="w-11 h-11 rounded-xl bg-black/5 dark:bg-white/5" />
                        <div className="flex-1 space-y-1.5">
                            <div className="h-3.5 w-3/4 rounded bg-black/5 dark:bg-white/5" />
                            <div className="h-3 w-full rounded bg-black/5 dark:bg-white/5" />
                            <div className="h-3 w-1/2 rounded bg-black/5 dark:bg-white/5" />
                        </div>
                    </div>
                    <div className="flex gap-1.5 mb-3">
                        <div className="h-4 w-12 rounded bg-black/5 dark:bg-white/5" />
                        <div className="h-4 w-10 rounded bg-black/5 dark:bg-white/5" />
                    </div>
                    <div className="h-px bg-glass-border my-3" />
                    <div className="flex justify-between">
                        <div className="h-3 w-20 rounded bg-black/5 dark:bg-white/5" />
                        <div className="h-4 w-14 rounded-full bg-black/5 dark:bg-white/5" />
                    </div>
                </div>
            ))}
        </div>
    )
}

function EmptyState({
    onCreate, onImport,
}: {
    onCreate: () => void
    onImport: () => void
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center p-16 rounded-3xl border-2 border-dashed border-glass-border"
        >
            <div className="w-14 h-14 rounded-2xl bg-accent-lineage/10 text-accent-lineage flex items-center justify-center mb-4">
                <LayoutTemplate className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-ink mb-1">No templates yet</h3>
            <p className="text-sm text-ink-muted text-center max-w-sm mb-5">
                Build a reusable blueprint for ContextViewCanvas layers. Workspaces can instantiate it with one click.
            </p>
            <div className="flex items-center gap-2">
                <button
                    onClick={onCreate}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:bg-accent-lineage/90 transition-colors"
                >
                    <Wand2 className="w-3.5 h-3.5" />
                    Build from scratch
                </button>
                <button
                    onClick={onImport}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-glass-border text-ink-secondary hover:text-ink hover:border-accent-lineage/40 text-sm font-medium transition-colors"
                >
                    <Upload className="w-3.5 h-3.5" />
                    Import JSON
                </button>
            </div>
        </motion.div>
    )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className={cn(
            'flex flex-col items-center justify-center p-12 rounded-2xl border border-red-500/20 bg-red-500/5',
        )}>
            <p className="text-sm text-red-500 mb-3">Failed to load templates.</p>
            <button
                onClick={() => onRetry()}
                className="px-3 py-1.5 rounded-lg border border-red-500/30 text-red-500 text-xs font-medium hover:bg-red-500/10 transition-colors"
            >
                Retry
            </button>
        </div>
    )
}
