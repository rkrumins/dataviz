/**
 * "Needs your attention" — the few things in this workspace that wait on the reader.
 *
 * They used to be banners and panels spread over the Data Sources tab (transfer
 * requests, drafts whose owner left, a policy accordion) and other tabs
 * (reviews, people asking to join), so a workspace admin had to visit every tab
 * to find out whether anything needed them. Here they are one list: a row only
 * for what has something in it, only for someone who can act on it, each with
 * the one place to go. Nothing waiting is said plainly.
 */
import type { ComponentType } from 'react'
import {
    ArrowRight, BellRing, CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionTitle } from './SectionTitle'

export interface AttentionItem {
    key: string
    icon: ComponentType<{ className?: string }>
    tone: 'accent' | 'warning' | 'danger' | 'info'
    title: string
    detail?: string
    actionLabel: string
    onAction: () => void
}

const TONE: Record<AttentionItem['tone'], string> = {
    accent: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    info: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    danger: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
}

export function AttentionCard({ items, loading }: { items: AttentionItem[]; loading?: boolean }) {
    return (
        <section aria-labelledby="attention-title" className="rounded-3xl border border-glass-border bg-canvas-elevated p-5" data-tour="workspace-attention">
            <SectionTitle
                id="attention-title" icon={BellRing} title="Needs your attention"
                tone={items.length > 0 ? 'text-rose-500 bg-rose-500/10' : 'text-emerald-500 bg-emerald-500/10'}
                className="mb-3"
                action={items.length > 0 ? (
                    <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-bold text-rose-500">{items.length}</span>
                ) : undefined}
            />
            {items.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-ink-muted">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-hidden />
                    {loading ? 'Checking…' : 'You’re all caught up — nothing here is waiting on you.'}
                </p>
            ) : (
                <ul className="space-y-2">
                    {items.map(({ key, icon: Icon, tone, title, detail, actionLabel, onAction }) => (
                        <li key={key} className="group flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                            <span className={cn('w-8 h-8 rounded-xl border flex items-center justify-center shrink-0', TONE[tone])}>
                                <Icon className="w-4 h-4" aria-hidden />
                            </span>
                            <span className="min-w-0 flex-1 basis-40">
                                <span className="block text-sm font-semibold text-ink">{title}</span>
                                {detail && <span className="block truncate text-xs text-ink-muted">{detail}</span>}
                            </span>
                            <button
                                type="button"
                                onClick={onAction}
                                className="ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 shrink-0"
                            >
                                {actionLabel} <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}
