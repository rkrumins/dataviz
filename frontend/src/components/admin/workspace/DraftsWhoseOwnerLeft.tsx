/**
 * Drafts whose owner left — the open drafts of someone no longer in the workspace (their account
 * is gone or suspended, or they no longer read its data sources), for a workspace admin to hand on
 * to someone who is.
 *
 * An admin sees what the server shows them of such a draft — its name, owner, level and when it
 * last changed — never what it holds. Anyone else sees nothing here.
 */
import { useState } from 'react'
import { ArrowRightLeft, GitBranch, Globe2, Lock, UserMinus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { timeAgo } from '@/lib/timeAgo'
import { usePermission } from '@/store/auth'
import { HandOnDraftForm } from '@/features/versioning/components/HandOnDraftForm'
import { useDraftsWhoseOwnerLeft } from '@/features/versioning/hooks/useVersioning'
import { ownerName } from '@/features/versioning/model/branchVocab'

export function DraftsWhoseOwnerLeft({ wsId }: { wsId: string }) {
    const isAdmin = usePermission('workspace:admin', wsId)
    const listQ = useDraftsWhoseOwnerLeft(isAdmin ? wsId : null)
    const [handingOn, setHandingOn] = useState<string | null>(null)

    // The list failing to load must never block the page.
    if (!isAdmin || !listQ.data) return null
    const drafts = listQ.data

    return (
        <section className="mb-4">
            <div className="flex items-center gap-2 mb-2">
                <UserMinus className="w-4 h-4 text-ink-muted" />
                <h3 className="text-sm font-semibold text-ink">Drafts whose owner left</h3>
                {drafts.length > 0 && (
                    <span className="text-xs text-ink-muted">{drafts.length === 1 ? '1 draft' : `${drafts.length} drafts`}</span>
                )}
            </div>

            {drafts.length === 0 ? (
                <div className="rounded-xl border border-glass-border">
                    <EmptyState
                        compact
                        icon={GitBranch}
                        title="No drafts are waiting for a new owner"
                        description="When someone leaves the workspace with drafts still open, they wait here to be handed on."
                    />
                </div>
            ) : (
                <ul className="rounded-xl border border-glass-border divide-y divide-glass-border overflow-hidden">
                    {drafts.map(d => {
                        const owner = ownerName(d.owner, d.userNames)
                        const open = handingOn === d.branchId
                        return (
                            <li key={d.branchId} className="px-4 py-3 bg-black/[0.015] dark:bg-white/[0.015]">
                                <div className="flex items-center gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-ink truncate">{d.name || 'Untitled draft'}</p>
                                        <p className="text-xs text-ink-muted truncate">
                                            Owned by {owner} · changed {timeAgo(d.updatedAt)}
                                        </p>
                                    </div>
                                    {d.visibility === 'private' ? (
                                        <Badge tone="accent" className="shrink-0"><Lock className="w-3 h-3" />Private</Badge>
                                    ) : (
                                        <Badge tone="info" className="shrink-0"><Globe2 className="w-3 h-3" />Public</Badge>
                                    )}
                                    <button
                                        onClick={() => setHandingOn(open ? null : d.branchId)}
                                        aria-expanded={open}
                                        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs
                                                   font-semibold text-ink bg-canvas border border-glass-border
                                                   hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                    >
                                        {!open && <ArrowRightLeft className="w-3.5 h-3.5" />}
                                        {open ? 'Cancel' : 'Hand on'}
                                    </button>
                                </div>
                                {open && (
                                    <div className="mt-3">
                                        <HandOnDraftForm
                                            wsId={wsId}
                                            graphId={d.graphId}
                                            branchId={d.branchId}
                                            previousOwner={d.owner}
                                            keepPreviousByDefault={false}
                                            keepPreviousLabel={`Keep ${owner} on as a maintainer`}
                                            onDone={() => { setHandingOn(null); void listQ.refetch() }}
                                        />
                                    </div>
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}
        </section>
    )
}
