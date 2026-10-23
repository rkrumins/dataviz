/**
 * Handing a person's service accounts to a successor, before they leave.
 *
 * For each account they manage themselves, what handing it over involves:
 * whether anyone else answers for it — if nobody does, its keys pause some
 * days after they go — and the keys they made, which they may have kept a
 * copy of: those are worth rotating once they have gone. The successor, a
 * person or a team, takes their seat on every one, and is told.
 */
import { useEffect, useState } from 'react'
import { Bot, KeySquare, User, Users, X } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { serviceAccountService, type ServiceAccount } from '@/services/serviceAccountService'
import { SubjectPicker, type Subject } from './SubjectPicker'

/** The accounts `userId` manages themselves, with what handing each over
 *  involves; null while loading, and for nobody. */
export function useManagedBy(userId: string | null): { accounts: ServiceAccount[] | null; error: string | null } {
    const [answer, setAnswer] = useState<{ userId: string; accounts: ServiceAccount[] | null; error: string | null } | null>(null)
    useEffect(() => {
        if (!userId) return
        let live = true
        serviceAccountService.list({ managedBy: userId, limit: 200 })
            .then((res) => { if (live) setAnswer({ userId, accounts: res.items, error: null }) })
            .catch((err: unknown) => {
                if (live) setAnswer({ userId, accounts: null, error: err instanceof Error ? err.message : 'Their service accounts could not be read.' })
            })
        return () => { live = false }
    }, [userId])
    return answer && answer.userId === userId ? answer : { accounts: null, error: null }
}

export function HandOverPanel({ person, accounts, successor, onSuccessor }: {
    person: { id: string; name: string }
    accounts: ServiceAccount[]
    successor: Subject | null
    onSuccessor: (subject: Subject | null) => void
}) {
    const stranded = accounts.filter((a) => a.handOver?.lastManager).length
    const theirKeys = accounts.flatMap((a) => (a.handOver?.keysCreatedBy ?? []).map((k) => ({ ...k, account: a.name })))
    const SuccessorIcon = successor?.type === 'group' ? Users : User
    return (
        <div className="space-y-3">
            <p className="text-sm text-ink-secondary">
                {person.name} manages {accounts.length} service account{accounts.length === 1 ? '' : 's'}
                {stranded > 0 && <> — {stranded === accounts.length ? (accounts.length === 1 ? 'nobody else does' : 'nobody else manages any of them') : `nobody else manages ${stranded}`}</>}.
            </p>
            <ul aria-label="Service accounts they manage" className="rounded-xl border border-black/[0.08] dark:border-white/[0.10] divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                {accounts.map((a) => (
                    <li key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                        <Bot className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 text-sm font-medium text-ink truncate">{a.name}</span>
                        {a.handOver?.lastManager
                            ? <Badge tone="warning" size="md">Only them</Badge>
                            : <Badge tone="neutral" size="md">Others too</Badge>}
                    </li>
                ))}
            </ul>
            {theirKeys.length > 0 && (
                <p className="flex items-start gap-2 text-xs text-ink-muted leading-relaxed">
                    <KeySquare className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    <span>
                        They made {theirKeys.length} key{theirKeys.length === 1 ? '' : 's'} still in date
                        ({theirKeys.map((k) => `“${k.name}” for ${k.account}`).join(', ')}). They may have kept a
                        copy: rotate {theirKeys.length === 1 ? 'it' : 'them'} once they have gone.
                    </span>
                </p>
            )}
            {successor ? (
                <div className="flex items-center gap-2.5 p-3 rounded-xl bg-indigo-500/[0.06] border border-indigo-500/20">
                    <SuccessorIcon className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 text-sm text-ink">
                        Hand over to <span className="font-semibold">{successor.name}</span>
                    </span>
                    <button
                        type="button"
                        onClick={() => onSuccessor(null)}
                        aria-label={`Choose someone other than ${successor.name}`}
                        className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ) : (
                <SubjectPicker label="Hand them over to" exclude={[`user:${person.id}`]} onPick={onSuccessor} />
            )}
        </div>
    )
}
