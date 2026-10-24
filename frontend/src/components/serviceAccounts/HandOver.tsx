/**
 * Handing a person's service accounts to a successor, before they leave.
 *
 * Every account their leaving touches, and what it involves: the seats they
 * hold themselves, which the successor — a person or a team — takes, and is
 * told; the accounts they manage through a team, which keeps its seat;
 * whether anyone else answers for each — if nobody does, its keys pause some
 * days after they go — and the keys they made that still work, on any
 * account: they may have kept a copy, so those are worth rotating, or
 * revoking at once.
 */
import { useEffect, useState } from 'react'
import { Bot, KeySquare, User, Users, X } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { serviceAccountService, type ServiceAccount } from '@/services/serviceAccountService'
import { SubjectPicker, type Subject } from './SubjectPicker'

/** The accounts `userId`'s leaving touches, with what it involves for each;
 *  null while loading, and for nobody. */
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

function summary(name: string, accounts: ServiceAccount[]): string {
    const answers = accounts.filter((a) => a.handOver?.seat || a.handOver?.teams.length)
    const madeOnly = accounts.length - answers.length
    if (!answers.length) {
        return `${name} manages no service account, but made keys that still work for ${madeOnly} service account${madeOnly === 1 ? '' : 's'}.`
    }
    const stranded = answers.filter((a) => a.handOver?.lastManager).length
    const nobody = stranded === 0 ? ''
        : stranded < answers.length ? ` — nobody else manages ${stranded}`
            : answers.length === 1 ? ' — nobody else does' : ' — nobody else manages any of them'
    const more = madeOnly ? ` They also made keys that still work for ${madeOnly} more.` : ''
    return `${name} manages ${answers.length} service account${answers.length === 1 ? '' : 's'}${nobody}.${more}`
}

function Standing({ account }: { account: ServiceAccount }) {
    const facts = account.handOver
    if (facts?.seat) {
        return facts.lastManager
            ? <Badge tone="warning" size="md">Only them</Badge>
            : <Badge tone="neutral" size="md">Others too</Badge>
    }
    if (facts?.teams.length) {
        return <Badge tone={facts.lastManager ? 'warning' : 'neutral'} size="md">Through {facts.teams.join(', ')}</Badge>
    }
    return <Badge tone="neutral" size="md">Made its keys</Badge>
}

export function HandOverPanel({ person, accounts, successor, onSuccessor, revokeKeys, onRevokeKeys }: {
    person: { id: string; name: string }
    accounts: ServiceAccount[]
    successor: Subject | null
    onSuccessor: (subject: Subject | null) => void
    /** Whether to revoke the keys they made, when the panel may offer it. */
    revokeKeys?: boolean
    /** Offers to revoke the keys they made; without it, the panel advises rotating them. */
    onRevokeKeys?: (revoke: boolean) => void
}) {
    const seats = accounts.filter((a) => a.handOver?.seat).length
    const throughTeams = accounts.some((a) => !a.handOver?.seat && a.handOver?.teams.length)
    const theirKeys = accounts.flatMap((a) => (a.handOver?.keysCreatedBy ?? []).map((k) => ({ ...k, account: a.name })))
    const them = theirKeys.length === 1 ? 'it' : 'them'
    const SuccessorIcon = successor?.type === 'group' ? Users : User
    return (
        <div className="space-y-3">
            <p className="text-sm text-ink-secondary">{summary(person.name, accounts)}</p>
            <ul aria-label="Service accounts they manage" className="rounded-xl border border-black/[0.08] dark:border-white/[0.10] divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                {accounts.map((a) => (
                    <li key={a.id} className="flex items-center gap-2.5 px-3 py-2">
                        <Bot className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 text-sm font-medium text-ink truncate">{a.name}</span>
                        <Standing account={a} />
                    </li>
                ))}
            </ul>
            {throughTeams && (
                <p className="text-xs text-ink-muted">A team keeps its seat when they go: only the seats they hold themselves are handed over.</p>
            )}
            {theirKeys.length > 0 && (
                <div className="space-y-2">
                    <p className="flex items-start gap-2 text-xs text-ink-muted leading-relaxed">
                        <KeySquare className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                        <span>
                            They made {theirKeys.length} key{theirKeys.length === 1 ? '' : 's'} still in date
                            ({theirKeys.map((k) => `“${k.name}” for ${k.account}`).join(', ')}). They may have kept a
                            copy{onRevokeKeys ? '.' : `: rotate ${them} once they have gone.`}
                        </span>
                    </p>
                    {onRevokeKeys && (
                        <label className="flex items-start gap-2 text-sm text-ink">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={!!revokeKeys}
                                onChange={(e) => onRevokeKeys(e.target.checked)}
                            />
                            <span>
                                Revoke the {theirKeys.length === 1 ? 'key' : `${theirKeys.length} keys`} they made
                                <span className="block text-xs text-ink-muted">
                                    Whatever uses {them} stops until someone makes a new key; those who answer for each account are told.
                                </span>
                            </span>
                        </label>
                    )}
                </div>
            )}
            {seats === 0 ? (
                <p className="text-xs text-ink-muted">They hold no seat themselves, so there is nothing to hand over.</p>
            ) : successor ? (
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
