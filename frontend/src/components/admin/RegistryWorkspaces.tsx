import { useState, useEffect, useCallback } from 'react'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { useNavigate } from 'react-router-dom'
import {
    Database, Plus, Edit2, Settings, Loader2, Search, AlertTriangle,
} from 'lucide-react'
import { workspaceService, type WorkspaceResponse, type WorkspaceCreateRequest } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse, type CatalogItemBindingResponse } from '@/services/catalogService'
import { WorkspaceCard } from './WorkspaceCard'
import { AdminWizard, type WizardStep } from './AdminWizard'

export function RegistryWorkspaces() {
    const navigate = useNavigate()
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [catalogItems, setCatalogItems] = useState<CatalogItemResponse[]>([])
    const [dsStats, setDsStats] = useState<Record<string, { nodes: number; edges: number; types: number }>>({})
    const [catalogBindings, setCatalogBindings] = useState<CatalogItemBindingResponse[]>([])
    const [searchQuery, setSearchQuery] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [showWizard, setShowWizard] = useState(false)

    const [wizName, setWizName] = useState('')
    const [wizDesc, setWizDesc] = useState('')
    const [wizCatalogItemId, setWizCatalogItemId] = useState('')
    const [wizDsLabel, setWizDsLabel] = useState('')
    const [wizSubmitting, setWizSubmitting] = useState(false)

    const loadData = useCallback(async () => {
        setIsLoading(true)
        try {
            const [wsList, catList] = await Promise.all([
                workspaceService.list(),
                catalogService.list(),
            ])
            setWorkspaces(wsList)
            setCatalogItems(catList)

            const statsMap: Record<string, { nodes: number; edges: number; types: number }> = {}
            // Fetch cached stats from management DB (no provider dependency) in parallel
            const statsPromises = wsList.map(async (ws) => {
                let totalNodes = 0, totalEdges = 0, allTypes = new Set<string>()
                const dsPromises = (ws.dataSources || []).map(async (ds) => {
                    try {
                        const res = await fetchWithTimeout(`/api/v1/admin/workspaces/${ws.id}/datasources/${ds.id}/cached-stats`)
                        if (res.ok) {
                            const data = await res.json()
                            totalNodes += (data.nodeCount ?? 0)
                            totalEdges += (data.edgeCount ?? 0)
                            const typeCounts = data.entityTypeCounts ?? {}
                            Object.keys(typeCounts).forEach((t: string) => allTypes.add(t))
                        }
                    } catch { /* no cached stats yet */ }
                })
                await Promise.all(dsPromises)
                statsMap[ws.id] = { nodes: totalNodes, edges: totalEdges, types: allTypes.size }
            })
            await Promise.all(statsPromises)
            setDsStats(statsMap)
        } catch (err) { console.error('Failed to load workspaces', err) }
        finally { setIsLoading(false) }
    }, [])

    useEffect(() => { loadData() }, [loadData])

    useEffect(() => {
        catalogService.listWithBindings().then(setCatalogBindings).catch(console.error)
    }, [showWizard])

    const handleDelete = async (wsId: string) => {
        if (!confirm('Delete this workspace and all its data sources?')) return
        await workspaceService.delete(wsId)
        loadData()
    }

    const handleSetDefault = async (wsId: string) => {
        await workspaceService.setDefault(wsId)
        loadData()
    }

    const resetWizard = () => { setWizName(''); setWizDesc(''); setWizCatalogItemId(''); setWizDsLabel('') }

    const handleWizardComplete = async () => {
        setWizSubmitting(true)
        try {
            const req: WorkspaceCreateRequest = {
                name: wizName, description: wizDesc || undefined,
                dataSources: wizCatalogItemId ? [{ catalogItemId: wizCatalogItemId, label: wizDsLabel || undefined }] : [],
            }
            await workspaceService.create(req)
            setShowWizard(false); resetWizard(); loadData()
        } catch (err) { console.error('Failed to create workspace', err) }
        finally { setWizSubmitting(false) }
    }

    const wsNameDuplicate = workspaces.some(w => w.name.toLowerCase() === wizName.trim().toLowerCase())
    const unboundCatalogs = catalogBindings.filter(b => !b.boundWorkspaceId)

    const wizardSteps: WizardStep[] = [
        {
            id: 'basics', title: 'Basics', icon: Edit2, validate: () => wizName.trim() && !wsNameDuplicate ? true : !wizName.trim() ? 'Please enter a workspace name.' : 'A workspace with this name already exists.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Workspace Name *</label>
                        <input value={wizName} onChange={e => setWizName(e.target.value)} placeholder="e.g. Production Analytics" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                        {wsNameDuplicate && (
                            <p className="mt-1.5 text-xs text-amber-500 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                A workspace named &quot;{wizName.trim()}&quot; already exists
                            </p>
                        )}
                    </div>
                    <div><label className="block text-sm font-medium text-ink mb-1.5">Description</label><textarea value={wizDesc} onChange={e => setWizDesc(e.target.value)} placeholder="Optional description for this workspace" rows={3} className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none" /></div>
                </div>
            ),
        },
        {
            id: 'data-source', title: 'Data Source', icon: Database, validate: () => true,
            content: (
                <div className="space-y-4">
                    <p className="text-xs text-ink-muted mb-4">You can connect an initial data source to this workspace now, or do it later.</p>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Catalog Item</label>
                        <select value={wizCatalogItemId} onChange={e => setWizCatalogItemId(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"><option value="">Skip for now...</option>{unboundCatalogs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.sourceIdentifier})</option>)}</select>
                        <p className="mt-1.5 text-xs text-ink-muted">Only unallocated data sources are shown</p>
                    </div>
                    <div><label className="block text-sm font-medium text-ink mb-1.5">Label</label><input value={wizDsLabel} onChange={e => setWizDsLabel(e.target.value)} placeholder="e.g. Main Graph, Analytics DB" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                </div>
            ),
        },
        {
            id: 'review', title: 'Review', icon: Settings, validate: () => true,
            content: (
                <div className="space-y-4">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                        <h4 className="text-sm font-bold text-ink mb-3">Workspace Summary</h4>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div><dt className="text-ink-muted">Name</dt><dd className="font-semibold text-ink mt-0.5">{wizName || '—'}</dd></div>
                            <div><dt className="text-ink-muted">Description</dt><dd className="text-ink mt-0.5 line-clamp-2">{wizDesc || '—'}</dd></div>
                            <div><dt className="text-ink-muted">Catalog Item</dt><dd className="text-ink mt-0.5">{catalogItems.find(c => c.id === wizCatalogItemId)?.name || '—'}</dd></div>
                        </dl>
                    </div>
                </div>
            ),
        },
    ]

    const filtered = workspaces.filter(ws => !searchQuery || ws.name.toLowerCase().includes(searchQuery.toLowerCase()) || ws.description?.toLowerCase().includes(searchQuery.toLowerCase()))

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-ink">Workspaces</h2>
                    <p className="text-sm text-ink-muted mt-1">Tenant environments subscribed to data sources.</p>
                </div>
                <button onClick={() => { resetWizard(); setShowWizard(true) }} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors">
                    <Plus className="w-4 h-4" /> Create Workspace
                </button>
            </div>

            {workspaces.length > 0 && (
                <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search workspaces..." className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                </div>
            )}

            {isLoading ? (
                <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Database className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">{searchQuery ? 'No matching workspaces' : 'No workspaces yet'}</h3>
                    <p className="text-sm text-ink-muted">{searchQuery ? 'Try a different search term' : 'Create a workspace to get started'}</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {filtered.map((ws, i) => (
                        <WorkspaceCard key={ws.id} ws={ws} index={i} stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }} onOpen={() => navigate(`/admin/registry/workspaces/${ws.id}`)} onDelete={() => handleDelete(ws.id)} onSetDefault={() => handleSetDefault(ws.id)} />
                    ))}
                </div>
            )}

            <AdminWizard title="Create Workspace" steps={wizardSteps} isOpen={showWizard} onClose={() => { setShowWizard(false); resetWizard() }} onComplete={handleWizardComplete} isSubmitting={wizSubmitting} completionLabel="Create Workspace" />
        </div>
    )
}
