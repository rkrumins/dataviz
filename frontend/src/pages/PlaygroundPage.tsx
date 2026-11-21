/**
 * /playground — the way into the Playground, for anyone who can sign in.
 *
 * The Playground is a common area: nobody asks to be let in. Arriving here makes
 * the person a Playground member if they aren't one yet (the server records it, so
 * access stays audited) and opens it. Every way in — the sidebar, the cards on the
 * Dashboard and Workspaces, a shared link to the Playground itself — comes here.
 */
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { FlaskConical, RotateCcw } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { EmptyState } from '@/components/ui/EmptyState'
import { PlaygroundCard } from '@/components/playground/PlaygroundCard'
import { useJoinPlayground, usePlayground } from '@/hooks/usePlayground'

export function PlaygroundPage() {
    const navigate = useNavigate()
    const { data: info, isError: unreadable, refetch } = usePlayground()
    const join = useJoinPlayground()
    const asked = useRef(false)

    useEffect(() => {
        if (!info?.enabled || !info.exists || !info.workspaceId) return
        const open = (wsId: string) => navigate(`/workspaces/${wsId}`, { replace: true })
        if (info.joined) { open(info.workspaceId); return }
        if (asked.current) return
        asked.current = true
        join.mutate(undefined, { onSuccess: (joined) => open(joined.workspaceId ?? info.workspaceId!) })
    }, [info, join, navigate])

    if (unreadable || join.isError) {
        return (
            <Centered>
                <EmptyState
                    icon={FlaskConical}
                    title="Couldn’t open the Playground"
                    description="Something went wrong on the way in. Try again in a moment."
                    action={{
                        label: 'Try again', icon: RotateCcw,
                        onClick: () => { asked.current = false; join.reset(); void refetch() },
                    }}
                />
            </Centered>
        )
    }

    if (info && (!info.enabled || !info.exists)) {
        return (
            <Centered>
                {info.canSetUp ? (
                    <PlaygroundCard className="w-full max-w-3xl" />
                ) : (
                    <EmptyState
                        icon={FlaskConical}
                        title="The Playground isn’t open yet"
                        description="It’s a common area where anyone can build graphs and try ideas out, apart from production. A platform administrator sets it up."
                    />
                )}
            </Centered>
        )
    }

    return (
        <Centered>
            <div role="status" className="flex flex-col items-center text-center gap-4">
                <span className="relative flex h-16 w-16 items-center justify-center">
                    <span aria-hidden className="absolute inset-0 rounded-[22px] bg-gradient-to-br from-violet-500 to-fuchsia-500 opacity-30 animate-ping" />
                    <span className="relative flex h-16 w-16 items-center justify-center rounded-[22px] bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/30">
                        <FlaskConical className="h-8 w-8" aria-hidden />
                    </span>
                </span>
                <div>
                    <p className="font-display text-xl font-bold text-ink">Opening the Playground…</p>
                    <p className="mt-1 text-sm text-ink-secondary">A common area to build graphs and try ideas — apart from production.</p>
                </div>
            </div>
        </Centered>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="w-full h-full overflow-y-auto custom-scrollbar bg-canvas">
            <PageContainer className="flex min-h-full items-center justify-center py-16">{children}</PageContainer>
        </div>
    )
}
