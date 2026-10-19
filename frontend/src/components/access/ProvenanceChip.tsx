/**
 * ProvenanceChip — how a grant came about, at a glance.
 *
 * Added directly · Approved request · Exception · Identity provider ·
 * Team · Organization-wide, each in its own colour, with the detail on
 * hover: who did it and when, the request it answered, the identity
 * provider's groups and the provider, the team, the organization role.
 * "Why can this person get in?" reads off the chip without leaving the
 * page.
 */
import {
    AlertTriangle, Building2, CheckCircle2, KeyRound, UserPlus, Users2, type LucideIcon,
} from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'
import type { AccessProvenance, AccessOrigin } from '@/services/workspaceMembersService'
import { provenanceSentence } from './accessRequestCopy'

const ORIGINS: Record<AccessOrigin, { label: string; icon: LucideIcon; pill: string }> = {
    direct: {
        label: 'Added directly',
        icon: UserPlus,
        pill: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20',
    },
    request: {
        label: 'Approved request',
        icon: CheckCircle2,
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
    exception: {
        label: 'Exception',
        icon: AlertTriangle,
        pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25',
    },
    idp: {
        label: 'Identity provider',
        icon: KeyRound,
        pill: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
    },
    team: {
        label: 'Team',
        icon: Users2,
        pill: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    },
    org_role: {
        label: 'Organization-wide',
        icon: Building2,
        pill: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    },
}

export function ProvenanceChip({ provenance, nameOf, className }: {
    provenance: AccessProvenance | null | undefined
    /** Names people for the hover; ids otherwise. */
    nameOf?: (id: string) => string
    className?: string
}) {
    if (!provenance) return null
    const meta = ORIGINS[provenance.origin] ?? ORIGINS.direct
    const Icon = meta.icon
    return (
        <HoverTip label={meta.label} detail={provenanceSentence(provenance, nameOf)}>
            <span
                className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap',
                    meta.pill,
                    className,
                )}
            >
                <Icon className="w-2.5 h-2.5" aria-hidden />
                {meta.label}
            </span>
        </HoverTip>
    )
}
