/**
 * ConnectionSelector — dropdown in the top bar for switching the active connection.
 *
 * When only one connection exists it renders a static label.
 * When multiple connections exist it renders a select dropdown.
 * Clicking "Manage" opens the ConnectionsPanel (passed as onManage callback).
 */
import { type FC } from 'react'
import { useConnections } from '@/hooks/useConnections'

const PROVIDER_LABELS: Record<string, string> = {
    falkordb: 'FalkorDB',
    neo4j: 'Neo4j',
    datahub: 'DataHub',
    mock: 'Mock',
}

interface ConnectionSelectorProps {
    /** Called when the user clicks "Manage connections" */
    onManage?: () => void
    className?: string
}

export const ConnectionSelector: FC<ConnectionSelectorProps> = ({ onManage, className }) => {
    const { connections, activeConnectionId, setActiveConnection, isLoading } = useConnections()

    if (isLoading) {
        return (
            <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className ?? ''}`}>
                <span className="animate-pulse">Loading connections…</span>
            </div>
        )
    }

    if (connections.length === 0) {
        return (
            <div className={`flex items-center gap-2 text-sm ${className ?? ''}`}>
                <span className="text-muted-foreground">No connections</span>
                {onManage && (
                    <button
                        onClick={onManage}
                        className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                    >
                        Add one
                    </button>
                )}
            </div>
        )
    }

    const active = connections.find((c) => c.id === activeConnectionId)

    return (
        <div className={`flex items-center gap-2 text-sm ${className ?? ''}`}>
            {connections.length === 1 ? (
                // Single connection — static label
                <span className="font-medium">
                    {active?.name ?? connections[0].name}
                    <span className="ml-1 text-xs text-muted-foreground">
                        ({PROVIDER_LABELS[active?.providerType ?? connections[0].providerType] ?? active?.providerType})
                    </span>
                </span>
            ) : (
                // Multiple connections — dropdown
                <select
                    value={activeConnectionId ?? ''}
                    onChange={(e) => setActiveConnection(e.target.value || null)}
                    className="rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Active connection"
                >
                    {connections.map((conn) => (
                        <option key={conn.id} value={conn.id}>
                            {conn.name}
                            {conn.isPrimary ? ' ★' : ''}
                            {' '}
                            ({PROVIDER_LABELS[conn.providerType] ?? conn.providerType})
                        </option>
                    ))}
                </select>
            )}

            {onManage && (
                <button
                    onClick={onManage}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Manage connections"
                >
                    Manage
                </button>
            )}
        </div>
    )
}
