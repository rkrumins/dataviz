/**
 * A request for a service account, as its approvers see it: what the account
 * is for, who manages it — a team the identity provider keeps, marked — and
 * who asked. Whoever approves lets its managers act in the workspace through
 * it, so they are named wherever the request is answered.
 */
import { Bot } from 'lucide-react'

import type { AccessRequestResponse } from '@/services/accessRequestsService'

export function ServiceAccountFacts({ request }: { request: AccessRequestResponse }) {
    const account = request.serviceAccount
    if (!account) return null
    const asker = request.requestedBy?.displayName ?? request.requestedBy?.email ?? null
    const managers = account.managers.map(m => (m.fromIdp ? `${m.name} (from your identity provider)` : m.name))
    return (
        <div className="mt-1.5 rounded-xl border border-sky-500/20 bg-sky-500/[0.05] px-3 py-2 text-xs text-ink-secondary space-y-0.5">
            <p className="flex items-center gap-1.5 font-semibold text-ink">
                <Bot className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 shrink-0" aria-hidden />
                Service account{account.description ? `: ${account.description}` : ''}
            </p>
            <p>
                {managers.length ? `Managed by ${managers.join(', ')}` : 'Nobody manages it'} — approving lets them
                act here through it.
            </p>
            {asker && <p>Asked by {asker}</p>}
        </div>
    )
}
