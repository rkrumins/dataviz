import { useSearchParams } from 'react-router-dom'
import { Server, Database, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RegistryConnections } from './RegistryConnections'
import { RegistryWorkspaces } from './RegistryWorkspaces'
import { RegistryAssets } from './RegistryAssets'

export function AdminRegistry() {
    const [searchParams, setSearchParams] = useSearchParams()
    const activeTab = searchParams.get('tab') || 'connections'

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
