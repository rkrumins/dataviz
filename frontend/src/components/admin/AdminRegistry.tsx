import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Server, Database, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { workspaceService } from '@/services/workspaceService'
import { RegistryConnections } from './RegistryConnections'
import { RegistryWorkspaces } from './RegistryWorkspaces'
import { RegistryAssets } from './RegistryAssets'
import { FirstRunHero } from './FirstRunHero'
import { OnboardingProgress } from './OnboardingProgress'

export function AdminRegistry() {
    const [searchParams, setSearchParams] = useSearchParams()
    const activeTab = searchParams.get('tab') || 'connections'

    // Lightweight counts for FirstRunHero + OnboardingProgress
    const [counts, setCounts] = useState({ providers: -1, catalogs: 0, workspaces: 0, hasOntology: false })

    useEffect(() => {
        let cancelled = false
        Promise.all([
            providerService.list(),
            catalogService.list(),
            workspaceService.list(),
        ]).then(([providers, catalogs, workspaces]) => {
            if (cancelled) return
            const hasOntology = workspaces.some(ws =>
                ws.dataSources?.some(ds => !!ds.ontologyId)
            )
            setCounts({
                providers: providers.length,
                catalogs: catalogs.length,
                workspaces: workspaces.length,
                hasOntology,
            })
        }).catch(() => {
            if (!cancelled) setCounts(prev => ({ ...prev, providers: 0 }))
        })
        return () => { cancelled = true }
    }, [activeTab]) // refetch when tab changes (user may have created entities)

    // Show FirstRunHero when no providers exist (and loading is done)
    if (counts.providers === 0) {
        return (
            <FirstRunHero
                onGetStarted={() => setSearchParams({ tab: 'connections' })}
            />
        )
    }

    // Still loading initial counts
    if (counts.providers === -1) return null

    const tabs = [
        {
            id: 'connections',
            label: 'Data Connections',
            icon: Server,
            desc: 'Manage provider credentials and health',
        },
        {
            id: 'assets',
            label: 'Data Assets',
            icon: Layers,
            desc: 'Register and configure catalog assets',
        },
        {
            id: 'workspaces',
            label: 'Workspaces',
            icon: Database,
            desc: 'Allocate assets to isolated domains',
        },
    ]

    return (
        <div className="p-8 max-w-7xl mx-auto flex flex-col h-full animate-in fade-in duration-500">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-3xl font-bold tracking-tight text-ink">Unified Registry</h1>
                <p className="text-sm text-ink-muted mt-2 max-w-2xl">
                    Manage the enterprise data topology — register physical connections, configure catalog assets, and allocate them to workspace domains.
                </p>
            </div>

            {/* Onboarding Progress */}
            <OnboardingProgress
                providerCount={counts.providers}
                catalogItemCount={counts.catalogs}
                workspaceCount={counts.workspaces}
                hasOntology={counts.hasOntology}
                onStageClick={(tab) => setSearchParams({ tab })}
            />

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-glass-border mb-8 shrink-0">
                {tabs.map(tab => {
                    const Icon = tab.icon
                    const isActive = activeTab === tab.id
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setSearchParams({ tab: tab.id })}
                            className={cn(
                                'flex items-center gap-2 px-6 py-3 text-sm font-semibold transition-all border-b-2',
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
            <div className="flex-1 min-h-0">
                {activeTab === 'connections' && <RegistryConnections />}
                {activeTab === 'assets' && <RegistryAssets />}
                {activeTab === 'workspaces' && <RegistryWorkspaces />}
            </div>
        </div>
    )
}
