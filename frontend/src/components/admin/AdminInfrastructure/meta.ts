/**
 * Shared status metadata + formatters for the Infrastructure page.
 *
 * Status colors follow the app's reserved state language (emerald /
 * amber / red / slate) and are ALWAYS paired with an icon + word —
 * never color alone (see providerHealthModel.ts for the precedent).
 */
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, type LucideIcon } from 'lucide-react'
import type { ServiceStatus } from '@/services/systemStatusService'

export interface StatusMeta {
    dot: string
    text: string
    chip: string
    icon: LucideIcon
    label: string
}

export const STATUS_META: Record<ServiceStatus, StatusMeta> = {
    healthy: {
        dot: 'bg-emerald-500',
        text: 'text-emerald-600 dark:text-emerald-400',
        chip: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
        icon: CheckCircle2,
        label: 'Healthy',
    },
    degraded: {
        dot: 'bg-amber-400',
        text: 'text-amber-600 dark:text-amber-400',
        chip: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
        icon: AlertTriangle,
        label: 'Degraded',
    },
    down: {
        dot: 'bg-red-500',
        text: 'text-red-600 dark:text-red-400',
        chip: 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400',
        icon: XCircle,
        label: 'Down',
    },
    unknown: {
        dot: 'bg-slate-300 dark:bg-slate-600',
        text: 'text-ink-muted',
        chip: 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-muted',
        icon: HelpCircle,
        label: 'Not configured',
    },
}

export function formatBytes(bytes: number | null | undefined): string | null {
    if (bytes == null) return null
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${bytes} B`
}

/** Compact duration from milliseconds: 850ms · 12s · 4m · 3h · 2d */
export function formatAgeMs(ms: number | null | undefined): string | null {
    if (ms == null) return null
    if (ms < 1000) return `${Math.round(ms)}ms`
    const s = ms / 1000
    if (s < 60) return `${Math.round(s)}s`
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    return `${Math.floor(s / 86400)}d`
}

/** Relative "Xs ago" from an ISO timestamp; null when unparseable. */
export function formatSince(iso: string | null | undefined): string | null {
    if (!iso) return null
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return null
    const age = formatAgeMs(Math.max(0, Date.now() - t))
    return age ? `${age} ago` : null
}

export function compactNum(n: number | null | undefined): string {
    if (n == null) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

/** Narrowing getters for the free-form ``detail`` payload. */
export function num(detail: Record<string, unknown>, key: string): number | null {
    const v = detail[key]
    return typeof v === 'number' ? v : null
}

export function str(detail: Record<string, unknown>, key: string): string | null {
    const v = detail[key]
    return typeof v === 'string' ? v : null
}

export function obj(detail: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const v = detail[key]
    return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>) : null
}
