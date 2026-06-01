/**
 * PickCanvasDialog — modal listing context-model canvases (instances)
 * across all workspaces, so the user can choose which canvas to turn
 * into a template.
 *
 * On select, calls `onPick(workspaceId, model)`. The parent typically
 * navigates to that canvas and then opens SaveAsTemplateDialog.
 */
import { useEffect, useMemo, useState } from 'react'
import { Layers, Loader2, Search, Building2 } from 'lucide-react'
import { TemplateDialogShell } from './TemplateDialogShell'
import { useWorkspacesStore } from '@/store/workspaces'
import { listContextModels, type ContextModel } from '@/services/contextModelService'
import { useToast } from '@/components/ui/toast'

interface PickCanvasDialogProps {
    isOpen: boolean
    onClose: () => void
    onPick: (workspaceId: string, model: ContextModel) => void
}

interface CanvasRow {
    workspaceId: string
    workspaceName: string
    model: ContextModel
}

export function PickCanvasDialog({ isOpen, onClose, onPick }: PickCanvasDialogProps) {
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    const { showToast } = useToast()
    const [loading, setLoading] = useState(false)
    const [rows, setRows] = useState<CanvasRow[]>([])
    const [search, setSearch] = useState('')

    useEffect(() => {
        if (!isOpen) return
        setLoading(true)
        setSearch('')
        Promise.allSettled(
            workspaces.map(async (ws) => {
                const models = await listContextModels(ws.id)
                return models
                    .filter((m) => !m.isTemplate)
                    .map<CanvasRow>((m) => ({
                        workspaceId: ws.id,
                        workspaceName: ws.name,
                        model: m,
                    }))
            }),
        )
            .then((results) => {
                const flat = results.flatMap((r) =>
                    r.status === 'fulfilled' ? r.value : [],
                )
                setRows(flat)
                const failed = results.filter((r) => r.status === 'rejected').length
                if (failed > 0) {
                    showToast('warning', `Could not load canvases from ${failed} workspace${failed === 1 ? '' : 's'}.`)
                }
            })
            .finally(() => setLoading(false))
    }, [isOpen, workspaces, showToast])

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return rows
        return rows.filter(
            (r) =>
                r.model.name.toLowerCase().includes(q) ||
                r.workspaceName.toLowerCase().includes(q),
        )
    }, [rows, search])

    return (
        <TemplateDialogShell
            isOpen={isOpen}
            onClose={onClose}
            title="Pick a canvas"
            subtitle="Choose which workspace canvas to capture as a template."
            icon={<Layers className="w-4 h-4" />}
            accentColor="#a855f7"
            size="lg"
        >
            <div className="space-y-3">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                        placeholder="Search canvas or workspace name…"
                        className="w-full pl-8 pr-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30"
                    />
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-10 text-ink-muted text-sm">
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        Loading canvases…
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-10 text-sm text-ink-muted">
                        No canvases found. Create one in a workspace first.
                    </div>
                ) : (
                    <div className="max-h-[50vh] overflow-y-auto custom-scrollbar space-y-1 -mx-1 px-1">
                        {filtered.map((row) => (
                            <button
                                key={`${row.workspaceId}:${row.model.id}`}
                                type="button"
                                onClick={() => onPick(row.workspaceId, row.model)}
                                className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-transparent hover:border-glass-border hover:bg-black/[0.025] dark:hover:bg-white/[0.025] transition-colors text-left"
                            >
                                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-accent-lineage/10 text-accent-lineage">
                                    <Layers className="w-4 h-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-ink truncate">{row.model.name}</div>
                                    <div className="text-[11px] text-ink-muted truncate inline-flex items-center gap-1">
                                        <Building2 className="w-2.5 h-2.5" />
                                        {row.workspaceName}
                                        <span className="mx-1">·</span>
                                        {row.model.layersConfig.length} layer{row.model.layersConfig.length === 1 ? '' : 's'}
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </TemplateDialogShell>
    )
}
