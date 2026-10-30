/**
 * The workspace's drafts and reviews policy: where new drafts start, the levels a draft may have,
 * and whether whoever opens a review may approve it and merge it.
 *
 * Sits beside the node-identity default for the same reason: it governs every source in this
 * workspace that does not set its own (on that source's Versioning tab). A workspace admin changes
 * it; everyone else reads it.
 */
import { useState } from 'react'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DraftsPolicyFields } from '@/features/versioning/components/DraftsPolicyFields'
import { useSetWorkspaceDraftsPolicy, useWorkspaceDraftsPolicy } from '@/features/versioning/hooks/useVersioning'

export function WorkspaceDraftsPolicy({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
    const policyQ = useWorkspaceDraftsPolicy(wsId)
    const put = useSetWorkspaceDraftsPolicy(wsId)
    const [open, setOpen] = useState(false)

    // A policy that failed to load must never block the page.
    if (!policyQ.data) return null

    return (
        <div className="mb-4 rounded-xl border border-glass-border overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
            >
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500/15 to-orange-500/15 text-amber-500 flex-shrink-0">
                    <ShieldCheck className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-ink">Drafts and reviews</span>
                    <p className="text-[11px] text-ink-muted mt-0.5 truncate">
                        Whether drafts are public or private, and who may approve and merge a review
                    </p>
                </div>
                <ChevronDown className={cn('w-4 h-4 text-ink-muted transition-transform flex-shrink-0', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="px-3 pb-3 pt-2 border-t border-glass-border">
                    <p className="text-[11px] text-ink-secondary leading-relaxed">
                        Every data source in this workspace follows these, unless it sets its own on its Versioning tab.
                    </p>
                    <DraftsPolicyFields
                        own={policyQ.data.settings}
                        canEdit={canEdit}
                        onSave={(change) => put.mutateAsync(change)}
                    />
                </div>
            )}
        </div>
    )
}
