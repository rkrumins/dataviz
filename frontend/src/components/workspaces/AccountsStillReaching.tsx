/**
 * Removing someone from a workspace: the service accounts they manage —
 * themselves or through a team — that keep a role here giving more than
 * they keep. Whoever manages an account can do whatever it can, so through
 * its keys they could still act here; each can be removed along with them.
 */
import { Bot } from 'lucide-react'

import { roleVisualFor } from '@/lib/roleVisual'
import type { ImpactPreviewServiceAccount } from '@/services/permissionsService'

export function AccountsStillReaching({ accounts, chosen, onChange }: {
    accounts: ImpactPreviewServiceAccount[]
    /** Its bindings to remove as well. */
    chosen: ReadonlySet<string>
    onChange: (next: Set<string>) => void
}) {
    if (accounts.length === 0) return null
    const toggle = (bindingIds: string[], on: boolean) => {
        const next = new Set(chosen)
        for (const id of bindingIds) {
            if (on) next.add(id)
            else next.delete(id)
        }
        onChange(next)
    }
    return (
        <section
            aria-label="Service accounts that keep access here"
            className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 space-y-3"
        >
            <div>
                <p className="text-sm font-semibold text-ink">
                    They could still act here through service accounts they manage
                </p>
                <p className="text-xs text-ink-secondary mt-0.5">
                    Whoever manages a service account can do whatever it can. Remove its role here too, or ask
                    its other managers to remove them as a manager.
                </p>
            </div>
            <ul className="space-y-2">
                {accounts.map((a) => {
                    const ids = a.bindings.map((b) => b.bindingId)
                    return (
                        <li key={a.id} className="flex items-start gap-3">
                            <Bot className="w-4 h-4 mt-0.5 text-sky-600 dark:text-sky-400 shrink-0" aria-hidden />
                            <div className="min-w-0 flex-1 text-sm">
                                <p className="font-semibold text-ink">{a.name}</p>
                                <p className="text-xs text-ink-muted">
                                    {a.bindings.map((b) => roleVisualFor(b.role).label).join(', ')} here ·{' '}
                                    {a.managedBy.join(', ')} {a.managedBy.length === 1 ? 'manages' : 'manage'} it
                                </p>
                            </div>
                            <label className="flex items-center gap-1.5 text-xs text-ink-secondary shrink-0">
                                <input
                                    type="checkbox"
                                    checked={ids.every((id) => chosen.has(id))}
                                    onChange={(e) => toggle(ids, e.target.checked)}
                                />
                                {ids.length === 1 ? 'Remove its role here too' : 'Remove its roles here too'}
                            </label>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
