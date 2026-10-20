/**
 * How a data source transfer reads — its status, the tone of each issue the
 * preview raises, and the history of where a source has lived as a list of
 * dated moments.
 *
 * Shared by the move wizard, the review dialog, the Requests tab, the
 * workspace banner and the source's lifecycle, so a transfer reads the same
 * wherever it appears.
 */
import {
    AlertTriangle, ArrowRightLeft, Ban, CheckCircle2, Clock, Info, Send, ShieldAlert, Undo2, XCircle,
    type LucideIcon,
} from 'lucide-react'

import type { RequestPolicy } from '@/services/accessRequestsService'
import type {
    DataSourceTransferResponse, TransferIssue, TransferStatus, TransferSubject,
} from '@/services/dataSourceTransferService'

/** How a person or group is told apart in a list of who loses access. */
export const subjectKey = (s: Pick<TransferSubject, 'type' | 'id'>) => `${s.type}:${s.id}`

/** A workspace's name, or how to refer to one the reader can't see. */
export function workspaceLabel(name: string | null | undefined): string {
    return name || 'another workspace'
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** "3 people and 1 group" — who loses access, or "No one". */
export function whoLoses(people: number, groups: number): string {
    return [people && plural(people, 'person', 'people'), groups && plural(groups, 'group')]
        .filter(Boolean).join(' and ') || 'No one'
}

/**
 * What the people who lose access are told about getting into `toName`: what its own page offers
 * them, by how it takes people. For a request, that happens once its admins accept.
 */
export function toldHowBackIn(policy: RequestPolicy, toName: string, request = false): string {
    const how = policy === 'open'
        ? `they can join ${toName}, which is open to everyone`
        : policy === 'closed'
            ? `to ask ${toName}’s admins to add them, as it takes no requests`
            : `how to ask to join ${toName}`
    return request ? `Once ${toName}’s admins accept, they’re told ${how}` : `They’re told ${how}`
}

/** Whether `iso` falls within the last `days` days. */
export function isWithinDays(iso: string | null | undefined, days: number, now = Date.now()): boolean {
    if (!iso) return false
    const ms = now - new Date(iso).getTime()
    return Number.isFinite(ms) && ms < days * 86_400_000
}

/** Whole days until `iso`, never below zero. */
export function daysUntil(iso: string | null | undefined, now = Date.now()): number {
    if (!iso) return 0
    const ms = new Date(iso).getTime() - now
    return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : 0
}

export interface StatusMeta {
    label: string
    icon: LucideIcon
    /** Literal classes: the JIT only sees names that appear verbatim. */
    pill: string
}

export const STATUS_META: Record<TransferStatus, StatusMeta> = {
    pending: {
        label: 'Waiting for their admins',
        icon: Clock,
        pill: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
    completed: {
        label: 'Moved',
        icon: CheckCircle2,
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
    declined: {
        label: 'Declined',
        icon: XCircle,
        pill: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    },
    cancelled: {
        label: 'Cancelled',
        icon: Ban,
        pill: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    },
    expired: {
        label: 'Expired',
        icon: Clock,
        pill: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    },
    undone: {
        label: 'Undone',
        icon: Undo2,
        pill: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
}

export interface IssueTone {
    icon: LucideIcon
    box: string
    iconClass: string
    title: string
}

/** Blockers stop the move; warnings change something people will notice; info is reassurance. */
export const ISSUE_TONES: Record<TransferIssue['severity'], IssueTone> = {
    blocker: {
        icon: ShieldAlert,
        box: 'border-rose-500/25 bg-rose-500/[0.06]',
        iconClass: 'text-rose-500',
        title: 'Resolve before moving',
    },
    warning: {
        icon: AlertTriangle,
        box: 'border-amber-500/25 bg-amber-500/[0.06]',
        iconClass: 'text-amber-500',
        title: 'Worth knowing',
    },
    info: {
        icon: Info,
        box: 'border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.03]',
        iconClass: 'text-ink-muted',
        title: 'For the record',
    },
}

export interface HistoryMoment {
    key: string
    at: string
    icon: LucideIcon
    /** Literal classes for the node on the timeline. */
    tint: string
    title: string
    by: string | null
    note: string | null
}

/**
 * A transfer as the moments a person would name: asked, accepted or declined,
 * moved, moved back. One row of history can be several of them — a request
 * that was accepted and later undone is three — newest first.
 */
export function historyMoments(transfers: DataSourceTransferResponse[]): HistoryMoment[] {
    const out: HistoryMoment[] = []
    for (const t of transfers) {
        const from = workspaceLabel(t.fromWorkspace.name)
        const to = workspaceLabel(t.toWorkspace.name)
        if (t.kind === 'request') {
            out.push({
                key: `${t.id}:asked`, at: t.createdAt, icon: Send,
                tint: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
                title: `Asked ${to} to take it`, by: t.createdBy?.name ?? null, note: t.reason,
            })
            if (t.status === 'declined' && t.resolvedAt) {
                out.push({
                    key: `${t.id}:declined`, at: t.resolvedAt, icon: XCircle,
                    tint: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
                    title: `${to} declined`, by: t.resolvedBy?.name ?? null, note: t.resolutionNote,
                })
            } else if (t.status === 'cancelled' && t.resolvedAt) {
                out.push({
                    key: `${t.id}:cancelled`, at: t.resolvedAt, icon: Ban,
                    tint: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
                    title: 'Request cancelled', by: t.resolvedBy?.name ?? null, note: t.resolutionNote,
                })
            } else if (t.status === 'expired' && (t.resolvedAt || t.expiresAt)) {
                out.push({
                    key: `${t.id}:expired`, at: (t.resolvedAt ?? t.expiresAt) as string, icon: Clock,
                    tint: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
                    title: 'Request expired unanswered', by: null, note: null,
                })
            }
        }
        if (t.completedAt) {
            out.push({
                key: `${t.id}:moved`, at: t.completedAt, icon: ArrowRightLeft,
                tint: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
                title: t.kind === 'request' ? `${to} accepted — moved from ${from}` : `Moved from ${from} to ${to}`,
                by: (t.kind === 'request' ? t.resolvedBy?.name : t.createdBy?.name) ?? null,
                note: t.kind === 'move' ? t.reason : null,
            })
        }
        if (t.status === 'undone' && t.undoneAt) {
            out.push({
                key: `${t.id}:undone`, at: t.undoneAt, icon: Undo2,
                tint: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
                title: `Move undone — back in ${from}`, by: t.undoneBy?.name ?? null, note: null,
            })
        }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
