/**
 * What the rail shows when it cannot answer at all: no model connected yet (with the way to
 * Administration → AI for those who can set one up), no access, a persona switched off, or the
 * service out of reach.
 */
import { useNavigate } from 'react-router-dom'
import { Lock, PlugZap, Power, RotateCcw, Settings } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { usePermission } from '@/store/auth'

export type UnavailableReason = 'not_configured' | 'no_access' | 'persona_off' | 'unreachable'

export function Unavailable({ reason, onRetry }: { reason: UnavailableReason; onRetry?: () => void }) {
    const navigate = useNavigate()
    const isAdmin = usePermission('system:admin')
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4">
            {reason === 'not_configured' && (
                <EmptyState
                    icon={PlugZap}
                    title="No AI model is connected yet"
                    description="An administrator needs to connect an AI model under Administration → AI. Until then there’s nothing to answer with."
                    action={isAdmin ? { label: 'Set up the assistant', icon: Settings, onClick: () => navigate('/admin/ai') } : undefined}
                />
            )}
            {reason === 'no_access' && (
                <EmptyState
                    icon={Lock}
                    title="You can’t use the assistant here"
                    description="Ask an administrator for access to the assistant in this workspace."
                />
            )}
            {reason === 'persona_off' && (
                <EmptyState
                    icon={Power}
                    title="This part of the assistant is switched off"
                    description="An administrator has turned it off. The other half may still be on — switch above."
                />
            )}
            {reason === 'unreachable' && (
                <EmptyState
                    icon={PlugZap}
                    title="The assistant can’t be reached"
                    description="It may be restarting. Try again in a moment."
                    action={onRetry ? { label: 'Try again', icon: RotateCcw, onClick: onRetry } : undefined}
                />
            )}
        </div>
    )
}
