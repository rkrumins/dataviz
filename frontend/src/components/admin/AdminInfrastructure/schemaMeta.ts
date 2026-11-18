/**
 * Display rules for the Database schema panel: the headline, what each history step is called, and a
 * revision id read as a name and a date.
 */
import {
    CheckCircle2, CircleAlert, DatabaseZap, FileDiff, MapPin, Play, RotateCcw, ShieldCheck, Sparkles,
    Stamp, Undo2, type LucideIcon,
} from 'lucide-react'
import type { SchemaHistoryEntry, SchemaStatus } from '@/services/systemStatusService'

export type Tone = 'good' | 'warn' | 'bad'

/** What the page says first: whether anything needs doing (the pill), and the banner's title. */
export function schemaHeadline(status: SchemaStatus): { label: string; title: string; tone: Tone } {
    const { plan } = status
    if (plan.verdict === 'refused') {
        return { label: 'Needs attention', title: 'An upgrade would stop, changing nothing', tone: 'bad' }
    }
    if (plan.verdict === 'fresh_install') {
        return { label: 'Not installed', title: 'An upgrade would install the schema', tone: 'warn' }
    }
    if (plan.verdict === 'upgrade') {
        const n = plan.wouldRun.length
        return n
            ? { label: `${n} migration${n === 1 ? '' : 's'} pending`, title: `An upgrade would run ${n} migration${n === 1 ? '' : 's'}`, tone: 'warn' }
            : { label: 'Upgrade pending', title: 'An upgrade would move the stamps', tone: 'warn' }
    }
    return plan.warnings.length
        ? { label: 'Up to date, with warnings', title: 'At this build’s head', tone: 'warn' }
        : { label: 'Up to date', title: 'At this build’s head', tone: 'good' }
}

export const TONE_STYLES: Record<Tone, { pill: string; dot: string; banner: string; glow: string; tile: string; icon: LucideIcon }> = {
    good: {
        pill: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        dot: 'bg-emerald-500',
        banner: 'border-emerald-500/25 from-emerald-500/[0.12] via-emerald-500/[0.04]',
        glow: 'shadow-emerald-500/25',
        tile: 'from-emerald-500 to-teal-600',
        icon: CheckCircle2,
    },
    warn: {
        pill: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        dot: 'bg-amber-500',
        banner: 'border-amber-500/25 from-amber-500/[0.12] via-amber-500/[0.04]',
        glow: 'shadow-amber-500/25',
        tile: 'from-amber-500 to-orange-600',
        icon: DatabaseZap,
    },
    bad: {
        pill: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
        dot: 'bg-rose-500',
        banner: 'border-rose-500/25 from-rose-500/[0.12] via-rose-500/[0.04]',
        glow: 'shadow-rose-500/25',
        tile: 'from-rose-500 to-pink-600',
        icon: CircleAlert,
    },
}

/** Each kind of history step: what it is called, and how it looks. */
export const KIND_META: Record<string, { label: string; icon: LucideIcon; node: string }> = {
    ran: { label: 'Ran', icon: Play, node: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30' },
    stamped: { label: 'Stamped', icon: Stamp, node: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-slate-500/30' },
    placed: { label: 'Placed', icon: MapPin, node: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 ring-indigo-500/30' },
    verified: { label: 'Schema checked', icon: ShieldCheck, node: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30' },
    restored: { label: 'Stamps put back', icon: RotateCcw, node: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-rose-500/30' },
    changed: { label: 'Migration changed', icon: FileDiff, node: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30' },
    seeded: { label: 'Built-in data added', icon: Sparkles, node: 'bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-violet-500/30' },
    downgraded: { label: 'Downgraded', icon: Undo2, node: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-rose-500/30' },
}

export function kindMeta(kind: SchemaHistoryEntry['kind']) {
    return KIND_META[kind] ?? { label: kind, icon: Stamp, node: 'bg-slate-500/15 text-slate-600 ring-slate-500/30' }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A revision id read as people do: ``20261118_1100_review_rules`` is "review rules", written
 *  18 Nov 2026 11:00. Ids that don't lead with a date keep their name, with no date. */
export function readRevision(id: string): { name: string; written: string | null } {
    const full = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})_(.+)$/.exec(id)
    if (full) {
        const [, y, m, d, hh, mm, rest] = full
        return { name: rest.replace(/_/g, ' '), written: `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}, ${hh}:${mm}` }
    }
    const dated = /^(\d{4})(\d{2})(\d{2})_(.+)$/.exec(id)
    if (dated) {
        const [, y, m, d, rest] = dated
        return { name: rest.replace(/_/g, ' '), written: `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` }
    }
    return { name: id.replace(/^\d+_/, '').replace(/_/g, ' '), written: null }
}
