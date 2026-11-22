/**
 * How the kit draws its vocabulary: each status, level, verdict and risk with words, a tone and an
 * icon, so nothing is said by colour alone.
 *
 * "In effect" is the quiet default and carries no colour; amber marks a value the platform changed
 * (adjusted), rose only a deployment value that could not be used. The rest are neutral: they
 * explain, they don't alarm.
 */
import {
    Ban, Box, Building2, CircleCheck, CircleSlash, Equal, Globe, Lock, Minus, Moon, Network, Plus, ShieldAlert,
    SlidersHorizontal, type LucideIcon,
} from 'lucide-react'
import type { BadgeTone } from '@/components/ui/Badge'
import type { Risk, Status, TrailScope, Verdict } from './types'

export interface StatusMeta {
    label: string
    tone: BadgeTone
    icon: LucideIcon
    /** One line on what the status means. */
    hint: string
}

export const STATUS_META: Record<Status, StatusMeta> = {
    in_effect: { label: 'In effect', tone: 'neutral', icon: CircleCheck, hint: 'The value chosen is the value in force.' },
    adjusted: { label: 'Adjusted', tone: 'warning', icon: SlidersHorizontal, hint: 'The value in force differs from the one chosen.' },
    dormant: { label: 'Inactive', tone: 'neutral', icon: Moon, hint: 'Has no effect until what it needs is turned on.' },
    not_used: { label: 'Not used', tone: 'neutral', icon: CircleSlash, hint: 'Nothing reads it with the other settings in force.' },
    locked: { label: 'Locked', tone: 'neutral', icon: Lock, hint: 'The platform set it for everyone.' },
    exception: { label: 'Exception', tone: 'info', icon: ShieldAlert, hint: 'A system admin’s value outside the limits, kept in force.' },
    invalid_env: { label: 'Deployment value ignored', tone: 'danger', icon: Ban, hint: 'The deployment’s value is not valid, so the default applies.' },
}

export const SCOPE_ICON: Record<TrailScope, LucideIcon> = { default: Box, platform: Globe, workspace: Building2, graph: Network }

export const VERDICT_META: Record<Verdict, { label: string; icon: LucideIcon; chip: string; glyph: string }> = {
    better: { label: 'better', icon: Plus, chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', glyph: 'text-emerald-600 dark:text-emerald-400' },
    same: { label: 'no change', icon: Equal, chip: 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.07]', glyph: 'text-ink-muted' },
    worse: { label: 'worse', icon: Minus, chip: 'bg-amber-500/10 text-amber-800 dark:text-amber-300', glyph: 'text-amber-600 dark:text-amber-400' },
}

export const RISK_META: Record<Risk, { label: string; tone: BadgeTone }> = {
    low: { label: 'Low risk', tone: 'neutral' },
    medium: { label: 'Medium risk', tone: 'warning' },
    high: { label: 'High risk', tone: 'danger' },
}
