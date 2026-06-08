import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { Server, Layers, Activity, DatabaseZap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { workspaceService } from '@/services/workspaceService'
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'
import { RegistryConnections } from '@/components/admin/RegistryConnections'
import { RegistryAssets } from '@/components/admin/RegistryAssets'
import { RegistryJobHistory } from '@/components/admin/RegistryJobHistory'
import { OnboardingProgress } from '@/components/admin/OnboardingProgress'

type IngestionTab = 'providers' | 'assets' | 'jobs'

interface TabDef {
    id: IngestionTab
    label: string
    icon: typeof Server
    desc: string
}

const ALL_TABS: TabDef[] = [
    { id: 'providers', label: 'Providers', icon: Server, desc: 'View provider credentials and health' },
    { id: 'assets', label: 'Data Sources', icon: Layers, desc: 'Register and configure data sources' },
    { id: 'jobs', label: 'Job History', icon: Activity, desc: 'Aggregation job history and monitoring' },
]

export function IngestionPage() {
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const isPlatformAdmin = usePermission('system:admin')
    // Phase 18: readers (workspace:provider:read) can now see the
    // Providers tab read-only. Edit/create/delete buttons in
    // RegistryConnections stay gated by system:admin.
    //
    // Rules of Hooks: always call the workspace probes (don't
    // short-circuit with ``||``) — the hook count must be stable
    // across renders even when ``isPlatformAdmin`` flips.
    const hasProviderRead = useAnyWorkspacePermission('workspace:provider:read')
    const hasCatalogRead = useAnyWorkspacePermission('workspace:catalog:read')
    const canReadProviders = isPlatformAdmin || hasProviderRead
    const canReadCatalog = isPlatformAdmin || hasCatalogRead

    // Visible tabs reflect what the current claim set can actually use.
    // Non-readers (no workspace bindings) skip Providers entirely.
    const visibleTabs = useMemo(
        () => ALL_TABS.filter(t => t.id !== 'providers' || canReadProviders),
        [canReadProviders],
    )

    const rawTab = searchParams.get('tab')
    const activeTab: IngestionTab = visibleTabs.some(t => t.id === rawTab)
        ? (rawTab as IngestionTab)
        : (visibleTabs[0]?.id ?? 'assets')

    const [counts, setCounts] = useState({ providers: -1, catalogs: 0, workspaces: 0, hasOntology: false })
    const [loadError, setLoadError] = useState<string | null>(null)

    useDocumentTitle('Ingestion')

    // Phase 18: providers + catalog reads are workspace-scoped. The
    // backend filters to what the caller's workspaces touch; the FE
    // skips the call when the user holds neither read perm so the
    // onboarding card stays accurate. Lifted into a stable callback
    // so the ``permissions:changed`` listener can call it without
    // re-creating the listener every render.
    const loadCounts = useCallback(async () => {
        setLoadError(null)
        const fetches: [Promise<unknown>, Promise<unknown>, Promise<unknown>] = [
            canReadProviders ? providerService.list() : Promise.resolve(null),
            canReadCatalog ? catalogService.list() : Promise.resolve([]),
            workspaceService.list(),
        ]
        const [providersResult, catalogsResult, workspacesResult] = await Promise.allSettled(fetches)
        const providers = providersResult.status === 'fulfilled'
            ? (providersResult.value as { length: number } | null)
            : null
        const catalogs = catalogsResult.status === 'fulfilled'
            ? (catalogsResult.value as { length: number })
            : { length: 0 }
        const workspaces = workspacesResult.status === 'fulfilled'
            ? (workspacesResult.value as Array<{ dataSources?: Array<{ ontologyId?: string | null }> }>)
            : []

        const errors: string[] = []
        if (canReadProviders && providersResult.status === 'rejected') errors.push('providers')
        if (canReadCatalog && catalogsResult.status === 'rejected') errors.push('catalog items')
        if (workspacesResult.status === 'rejected') errors.push('workspaces')

        const hasOntology = workspaces.some(ws =>
            ws.dataSources?.some(ds => !!ds.ontologyId)
        )
        setCounts({
            providers: providers ? providers.length : 0,
            catalogs: catalogs.length,
            workspaces: workspaces.length,
            hasOntology,
        })
        setLoadError(
            errors.length > 0
                ? `Could not load ${errors.join(', ')}. Showing partial data.`
                : null,
        )
    }, [canReadProviders, canReadCatalog])

    useEffect(() => {
        let cancelled = false
        void loadCounts().then(() => {
            if (cancelled) return
        })
        return () => { cancelled = true }
    }, [activeTab, loadCounts])

    // Refresh when a permissions change is announced (silent refresh,
    // 60s poller, or cross-tab BroadcastChannel). Without this, the
    // page keeps showing the pre-revocation counts while open.
    useEffect(() => {
        const onChange = () => { void loadCounts() }
        window.addEventListener('permissions:changed', onChange)
        return () => window.removeEventListener('permissions:changed', onChange)
    }, [loadCounts])

    const handleStageClick = (tab: string) => {
        if (tab === 'workspaces') {
            navigate('/workspaces')
            return
        }
        if ((tab === 'providers' && canReadProviders) || tab === 'assets') {
            setSearchParams({ tab })
        }
    }

    // Wait for the providers fetch to settle before painting (the
    // sentinel is -1 only when we attempted the fetch).
    if (canReadProviders && counts.providers === -1 && !loadError) return null

    const setTab = (id: IngestionTab) => setSearchParams({ tab: id })

    return (
        <div className="absolute inset-0 flex flex-col animate-in fade-in duration-500">
            {/* Fixed header area — does not scroll */}
            <div className="shrink-0 px-8 pt-8">
                <div className="max-w-7xl mx-auto">
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                            <DatabaseZap className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-bold text-ink leading-tight">Data Ingestion</h1>
                            <p className="text-[11px] text-ink-muted">Connect providers, register assets, and monitor your pipeline</p>
                        </div>
                    </div>

                    {loadError && (
                        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                            {loadError}
                        </div>
                    )}

                    {/* Onboarding Progress — admin-only because the first
                        two stages (providers, catalog) are admin-tier
                        concerns. Non-admins arrive at Ingestion to manage
                        data sources inside their workspaces; the
                        onboarding ladder doesn't apply to them. */}
                    {isPlatformAdmin && (
                        <OnboardingProgress
                            providerCount={Math.max(counts.providers, 0)}
                            catalogItemCount={counts.catalogs}
                            workspaceCount={counts.workspaces}
                            hasOntology={counts.hasOntology}
                            onStageClick={handleStageClick}
                        />
                    )}

                    {/* Phase 18: Provider write paths stay system:admin.
                        Readers see the rows but get a banner explaining
                        edit lives with admins. */}
                    {!isPlatformAdmin && canReadProviders && activeTab === 'providers' && (
                        <div className="mb-4 rounded-xl border border-glass-border bg-glass-base/30 px-4 py-2.5 text-xs text-ink-secondary">
                            You're viewing the providers your workspaces use. To register,
                            edit, or delete a provider, ask a platform administrator.
                        </div>
                    )}

                    {/* Tabs */}
                    <div
                        role="tablist"
                        aria-label="Ingestion sections"
                        className="flex items-center gap-1 border-b border-glass-border"
                    >
                        {visibleTabs.map(tab => {
                            const Icon = tab.icon
                            const isActive = activeTab === tab.id
                            return (
                                <button
                                    key={tab.id}
                                    role="tab"
                                    aria-selected={isActive}
                                    aria-controls={`ingestion-panel-${tab.id}`}
                                    id={`ingestion-tab-${tab.id}`}
                                    onClick={() => setTab(tab.id)}
                                    title={tab.desc}
                                    className={cn(
                                        'flex items-center gap-2 px-6 py-3 text-sm font-semibold transition-all border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                        isActive
                                            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                            : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl'
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    {tab.label}
                                </button>
                            )
                        })}
                    </div>
                </div>
            </div>

            {/* Content pane — fills remaining space */}
            <div
                role="tabpanel"
                id={`ingestion-panel-${activeTab}`}
                aria-labelledby={`ingestion-tab-${activeTab}`}
                className={cn(
                    'flex-1 min-h-0',
                    // Jobs tab manages its own scroll so it can pin header/filters
                    activeTab === 'jobs' ? 'flex flex-col' : 'overflow-y-auto',
                )}
            >
                {activeTab === 'jobs' ? (
                    <RegistryJobHistory />
                ) : (
                    <div className="px-8 py-6 max-w-7xl mx-auto">
                        {activeTab === 'providers' && canReadProviders && <RegistryConnections />}
                        {activeTab === 'assets' && <RegistryAssets />}
                    </div>
                )}
            </div>
        </div>
    )
}
