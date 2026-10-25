/**
 * How a service account stands, and who answers for it — the same on
 * Account → API keys, on the account's own page and in Administration.
 *
 * An account's keys work while it is enabled and someone in good standing
 * manages it: a person who can sign in now, or a team with such a person in
 * it. When the last one goes its keys keep working until `pausesAt`, then
 * pause until a manager is appointed. One chip says the most pressing of
 * those facts, and its tip says what follows from it.
 *
 * Whether the keys work follows `pausesAt`, as the server decides it: set
 * when the account was found with nobody — at once by any change to its
 * managers, within the hour when a manager's sign-in lapses or comes back.
 * `managed` is who can act this minute, which can run ahead of it.
 */
import { User, Users } from 'lucide-react'

import { formatDay } from '@/components/apiKeys/apiKeyFormat'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { HoverTip } from '@/components/ui/HoverTip'
import type { ServiceAccount, ServiceAccountManager } from '@/services/serviceAccountService'

/** Marks a service account wherever it is listed among people. */
export function ServiceAccountBadge() {
    return <Badge tone="info" size="sm" className="shrink-0">Service account</Badge>
}

export interface Standing {
    tone: BadgeTone
    label: string
    detail: string
}

/** The one thing to know about an account, most pressing first. */
export function standingOf(
    account: Pick<ServiceAccount, 'status' | 'managed' | 'singleManager' | 'pausesAt' | 'adminHold'>,
    now: Date = new Date(),
): Standing {
    if (account.status === 'disabled') {
        return {
            tone: 'neutral',
            label: 'Disabled',
            detail: account.adminHold
                ? 'An administrator disabled it: its keys don’t work until an administrator enables it.'
                : 'Its keys don’t work until one of its managers enables it.',
        }
    }
    if (account.pausesAt && new Date(account.pausesAt) <= now) {
        return {
            tone: 'danger',
            label: 'Needs a manager — keys paused',
            detail: account.managed
                ? 'Someone can act for it again: its keys work again within the hour.'
                : 'Nobody manages it, so its keys are refused. They work again as soon as an administrator appoints a manager.',
        }
    }
    if (!account.managed) {
        return account.pausesAt ? {
            tone: 'warning',
            label: `Needs a manager — keys pause ${formatDay(account.pausesAt, now)}`,
            detail: 'Nobody who manages it can act for it now. Its keys work until then; appointing a manager keeps them working.',
        } : {
            tone: 'warning',
            label: 'Needs a manager',
            detail: 'Nobody who manages it can act for it now. Its keys still work, and pause some days after this is noticed unless a manager is appointed.',
        }
    }
    if (account.singleManager) {
        return {
            tone: 'info',
            label: 'Single manager',
            detail: 'Only one person can act for it. Add a team or a second person, so it outlives one of them leaving.',
        }
    }
    return { tone: 'success', label: 'Managed', detail: 'Someone answers for it, and its keys work.' }
}

export function StandingChip({ account, now }: {
    account: Pick<ServiceAccount, 'status' | 'managed' | 'singleManager' | 'pausesAt' | 'adminHold'>
    now?: Date
}) {
    const standing = standingOf(account, now)
    return (
        <HoverTip label={standing.label} detail={standing.detail} className="shrink-0">
            <Badge tone={standing.tone} size="md">{standing.label}</Badge>
        </HoverTip>
    )
}

/** Why a manager cannot act for the account right now. */
function standingNote(manager: ServiceAccountManager): string {
    if (manager.type === 'group') return 'Nobody in this team can sign in right now.'
    return 'Can’t sign in right now — suspended, or not signed in through the identity provider lately.'
}

/** A person or a team who manages the account, and whether they can act now. */
export function ManagerRow({ manager, action }: { manager: ServiceAccountManager; action?: React.ReactNode }) {
    const Icon = manager.type === 'group' ? Users : User
    const members = manager.membersInGoodStanding ?? 0
    return (
        <li className="flex items-center gap-3 py-2.5">
            <span className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink truncate">{manager.name}</span>
                <span className="block text-xs text-ink-muted truncate">
                    {manager.type === 'group'
                        ? `Team · ${members} member${members === 1 ? '' : 's'} who can act`
                        : manager.email ?? 'Person'}
                </span>
            </span>
            {!manager.inGoodStanding && (
                <HoverTip label="Can’t act for it now" detail={standingNote(manager)} className="shrink-0">
                    <Badge tone="warning" size="md">Can’t act now</Badge>
                </HoverTip>
            )}
            {action}
        </li>
    )
}

/** "Anyone in Data platform can make keys that act as Metadata sync." */
export function TeamNote({ teams, account }: { teams: string[]; account: string }) {
    if (teams.length === 0) return null
    return (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
            <Users className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
            Anyone in {teams.join(' or ')} can make keys that act as {account}.
        </p>
    )
}
