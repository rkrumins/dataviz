import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Server, Layers, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { workspaceService } from '@/services/workspaceService'
import { RegistryConnections } from '@/components/admin/RegistryConnections'
import { RegistryAssets } from '@/components/admin/RegistryAssets'
import { RegistryJobHistory } from '@/components/admin/RegistryJobHistory'
import { FirstRunHero } from '@/components/admin/FirstRunHero'
import { OnboardingProgress } from '@/components/admin/OnboardingProgress'

type IngestionTab = 'providers' | 'assets' | 'jobs'

const TABS: { id: IngestionTab; label: string; icon: typeof Server; desc: string }[] = [
    { id: 'providers', label: 'Providers', icon: Server, desc: 'Manage provider credentials and health' },
    { id: 'assets', label: 'Data Sources', icon: Layers, desc: 'Register and configure data sources' },
    { id: 'jobs', label: 'Job History', icon: Activity, desc: 'Aggregation job history and monitoring' },
]

export function IngestionPage() {
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const rawTab = searchParams.get('tab')
    const activeTab: IngestionTab = TABS.some(t => t.id === rawTab) ? (rawTab as IngestionTab) : 'providers'

    const [counts, setCounts] = useState({ providers: -1, catalogs: 0, workspaces: 0, hasOntology: false })
    const [loadError, setLoadError] = useState<string | null>(null)
    const [startProviderOnboarding, setStartProviderOnboarding] = useState(false)

    useEffect(() => {
        document.title = 'Ingestion · Synodic'
    }, [])

    useEffect(() => {
        let cancelled = false
        setLoadError(null)
        Promise.allSettled([
            providerService.list(),
            catalogService.list(),
            workspaceService.list(),
        ]).then(([providersResult, catalogsResult, workspacesResult]) => {
            if (cancelled) return
            const providers = providersResult.status === 'fulfilled' ? providersResult.value : null
            const catalogs = catalogsResult.status === 'fulfilled' ? catalogsResult.value : []
            const workspaces = workspacesResult.status === 'fulfilled' ? workspacesResult.value : []

            const errors: string[] = []
            if (providersResult.status === 'rejected') errors.push('providers')
            if (catalogsResult.status === 'rejected') errors.push('catalog items')
            if (workspacesResult.status === 'rejected') errors.push('workspaces')

            const hasOntology = workspaces.some(ws =>
                ws.dataSources?.some(ds => !!ds.ontologyId)
            )
            setCounts({
                providers: providers ? providers.length : -1,
                catalogs: catalogs.length,
                workspaces: workspaces.length,
                hasOntology,
            })
            setLoadError(
                errors.length > 0
                    ? `Could not load ${errors.join(', ')}.`
                    : null,
            )
        })
        return () => { cancelled = true }
    }, [activeTab])

    useEffect(() => {
        if (counts.providers > 0 && startProviderOnboarding) {
            setStartProviderOnboarding(false)
        }
    }, [counts.providers, startProviderOnboarding])

    const handleStageClick = (tab: string) => {
        if (tab === 'workspaces') {
            navigate('/workspaces')
            return
        }
        if (tab === 'providers' || tab === 'assets') {
            setSearchParams({ tab })
        }
    }

    if (counts.providers === 0 && !loadError && !startProviderOnboarding) {
        return (
            <FirstRunHero
                onGetStarted={() => {
                    setStartProviderOnboarding(true)
                    setSearchParams({ tab: 'providers' })
                }}
            />
        )
    }

    if (counts.providers === -1) return null

    const setTab = (id: IngestionTab) => setSearchParams({ tab: id })

    return (
        <div className="p-8 max-w-7xl mx-auto flex flex-col h-full animate-in fade-in duration-500">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-3xl font-bold tracking-tight text-ink">Data Ingestion</h1>
                <p className="text-sm text-ink-muted mt-2 max-w-2xl">
                    Connect providers, register assets, and monitor the pipeline that feeds your workspaces.
                </p>
            </div>

            {loadError && (
                <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
                    {loadError}
                </div>
            )}

            {/* Onboarding Progress */}
            <OnboardingProgress
                providerCount={Math.max(counts.providers, 0)}
                catalogItemCount={counts.catalogs}
                workspaceCount={counts.workspaces}
                hasOntology={counts.hasOntology}
                onStageClick={handleStageClick}
            />

            {/* Tabs */}
            <div
                role="tablist"
                aria-label="Ingestion sections"
                className="flex items-center gap-1 border-b border-glass-border mb-8 shrink-0"
            >
                {TABS.map(tab => {
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

            {/* Content pane */}
            <div
                role="tabpanel"
                id={`ingestion-panel-${activeTab}`}
                aria-labelledby={`ingestion-tab-${activeTab}`}
                className="flex-1 min-h-0"
            >
                {activeTab === 'providers' && (
                    <RegistryConnections
                        autoOpenWizard={startProviderOnboarding}
                    />
                )}
                {activeTab === 'assets' && <RegistryAssets />}
                {activeTab === 'jobs' && <RegistryJobHistory />}
            </div>
        </div>
    )
}
