import { useState, type FC, useEffect } from 'react'
import { Database, Network, X } from 'lucide-react'
import { EnvironmentsTab } from './EnvironmentsTab'
import { ConnectionsTab } from './ConnectionsTab'

interface WorkspacePanelProps {
    onClose?: () => void
    initialTab?: 'environments' | 'connections'
}

export const WorkspacePanel: FC<WorkspacePanelProps> = ({ onClose, initialTab = 'environments' }) => {
    const [activeTab, setActiveTab] = useState<'environments' | 'connections'>(initialTab)

    // Reset tab if initialTab changes (e.g. user opens standard or legacy connection button)
    useEffect(() => {
        setActiveTab(initialTab)
    }, [initialTab])

    return (
        <div className="flex flex-col h-full bg-canvas text-ink relative rounded-xl overflow-hidden">
            {/* Header Area */}
            <div className="flex flex-col pt-5 px-6 border-b border-glass-border bg-canvas-elevated sticky top-0 z-10 shrink-0">
                <div className="flex items-start justify-between">
                    <div>
                        <h2 className="text-xl font-bold flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-business/20 to-accent-lineage/20 flex items-center justify-center border border-glass-border shadow-inner">
                                {activeTab === 'environments' ? <Database className="w-4 h-4 text-accent-business" /> : <Network className="w-4 h-4 text-accent-business" />}
                            </div>
                            System Administration
                        </h2>
                        <p className="text-sm text-ink-muted mt-1.5 ml-1">Configure environments, data sources, and provider connections.</p>
                    </div>
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 text-ink-secondary hover:text-ink transition-colors focus:outline-none focus:ring-2 focus:ring-accent-business"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    )}
                </div>

                {/* Tabs Row */}
                <div className="flex items-center gap-6 mt-6 ml-1">
                    <button
                        onClick={() => setActiveTab('environments')}
                        className={`pb-3 text-sm font-semibold transition-all relative outline-none focus-visible:ring-2 focus-visible:ring-accent-business focus-visible:ring-offset-2 focus-visible:ring-offset-canvas rounded-t-sm ${activeTab === 'environments'
                            ? 'text-accent-business'
                            : 'text-ink-secondary hover:text-ink'
                            }`}
                    >
                        Environments
                        {activeTab === 'environments' && (
                            <span className="absolute bottom-0 left-0 w-full h-[3px] bg-accent-business rounded-t-full" />
                        )}
                    </button>
                    <button
                        onClick={() => setActiveTab('connections')}
                        className={`pb-3 text-sm font-semibold transition-all relative outline-none focus-visible:ring-2 focus-visible:ring-accent-business focus-visible:ring-offset-2 focus-visible:ring-offset-canvas rounded-t-sm ${activeTab === 'connections'
                            ? 'text-accent-business'
                            : 'text-ink-secondary hover:text-ink'
                            }`}
                    >
                        Legacy Connections
                        {activeTab === 'connections' && (
                            <span className="absolute bottom-0 left-0 w-full h-[3px] bg-accent-business rounded-t-full" />
                        )}
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative bg-canvas/50">
                {activeTab === 'environments' ? <EnvironmentsTab /> : <ConnectionsTab />}
            </div>
        </div>
    )
}
