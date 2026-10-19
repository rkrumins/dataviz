/**
 * How access requests read — the levels someone may ask for, in plain
 * language, and what each status means to the person waiting.
 *
 * Shared by Request access, Find a workspace, My Access and the Requests
 * tab, so a request reads the same wherever it appears.
 */
import { CheckCircle2, Clock, KeyRound, Undo2, XCircle, type LucideIcon } from 'lucide-react'

import type { AccessRequestStatus, RequestableRole } from '@/services/accessRequestsService'
import { SYSTEM_ROLE_LABELS, type SystemRole } from '@/store/auth'

/** The built-in levels, as someone asking would put them. */
const LEVELS: Record<string, { title: string; blurb: string }> = {
    workspace_viewer: { title: 'View', blurb: 'Open its views and read its data.' },
    workspace_member: { title: 'Contribute', blurb: 'Build and edit views, and work with its data sources.' },
    workspace_data_engineer: {
        title: 'Engineer the data',
        blurb: 'Look after its data sources and semantic layers, as well as its views.',
    },
}

export function accessLevel(role: Pick<RequestableRole, 'name' | 'description'>): { title: string; blurb: string } {
    return LEVELS[role.name] ?? { title: roleLabel(role.name), blurb: role.description ?? 'A role this workspace defines.' }
}

/** "Member", "Viewer", "Steward" — or a custom role's own name. */
export function roleLabel(name: string): string {
    return SYSTEM_ROLE_LABELS[name as SystemRole] ?? name
}

export interface StatusMeta {
    label: string
    icon: LucideIcon
    /** Literal classes: the JIT only sees names that appear verbatim. */
    pill: string
}

export const STATUS_META: Record<AccessRequestStatus, StatusMeta> = {
    pending: {
        label: 'Waiting for approval',
        icon: Clock,
        pill: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
    awaiting_idp: {
        label: 'Waiting on your identity provider',
        icon: KeyRound,
        pill: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
    },
    approved: {
        label: 'Approved',
        icon: CheckCircle2,
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
    denied: {
        label: 'Declined',
        icon: XCircle,
        pill: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    },
    withdrawn: {
        label: 'Withdrawn',
        icon: Undo2,
        pill: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    },
}

/** What to do while a request waits on the identity provider. */
export function idpInstruction(group: string, provider?: string | null): string {
    return `Ask your IT team to add you to “${group}”${provider ? ` in ${provider}` : ''}. Your access arrives the next time you sign in after that.`
}
