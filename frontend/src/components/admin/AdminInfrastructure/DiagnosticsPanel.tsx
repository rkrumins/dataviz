/**
 * DiagnosticsPanel — the interpretation layer. Renders the ranked
 * findings from ``buildDiagnostics`` as rich cards: what's wrong, *why it
 * might be happening* (hypotheses), and *how to resolve it* (steps +
 * copy-able commands). Data-driven — it renders whatever insights the
 * engine produces, with no per-service or per-provider special-casing.
 */
import { useMemo, useState } from 'react'
import {
    AlertTriangle, XCircle, Info, Lightbulb, Wrench, Check, Copy, CheckCircle2,
    ChevronDown, ChevronRight, ChevronLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SystemStatusSnapshot } from '@/services/systemStatusService'
import { buildDiagnostics, type Insight, type Severity } from './diagnostics'

const PAGE_SIZE = 5

const SEV: Record<Severity, { border: string; chip: string; icon: typeof Info; iconCls: string }> = {
    critical: { border: 'border-l-red-500', chip: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20', icon: XCircle, iconCls: 'text-red-500' },
    warning: { border: 'border-l-amber-400', chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20', icon: AlertTriangle, iconCls: 'text-amber-500' },
    info: { border: 'border-l-indigo-400', chip: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20', icon: Info, iconCls: 'text-indigo-500' },
}

function CommandRow({ cmd }: { cmd: string }) {
    const [copied, setCopied] = useState(false)
    const copy = () => {
        navigator.clipboard?.writeText(cmd).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
    }
    return (
        <div className="flex items-center gap-2 group/cmd">
            <code className="flex-1 min-w-0 font-mono text-[11px] text-ink-secondary bg-black/5 dark:bg-white/5 border border-glass-border rounded-md px-2 py-1.5 overflow-x-auto whitespace-pre">{cmd}</code>
            <button
                onClick={copy}
                className="shrink-0 p-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                aria-label="Copy command"
            >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
        </div>
    )
}

function InsightCard({ insight, defaultOpen }: { insight: Insight; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen ?? false)
    const meta = SEV[insight.severity]
    const SevIcon = meta.icon
    const Chevron = open ? ChevronDown : ChevronRight
    return (
        <div className={cn('border border-glass-border border-l-2 rounded-xl bg-canvas-elevated', meta.border)}>
            {/* Header — the whole row toggles the card (collapsed shows the
                what + evidence; expanded reveals why + how + commands). */}
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full text-left p-4 flex items-start gap-2.5 group"
                aria-expanded={open}
            >
                <SevIcon className={cn('w-4 h-4 mt-0.5 shrink-0', meta.iconCls)} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn('inline-flex px-1.5 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide', meta.chip)}>
                            {insight.category}
                        </span>
                        <h3 className="text-sm font-semibold text-ink">{insight.title}</h3>
                        <Chevron className="w-4 h-4 ml-auto shrink-0 text-ink-muted group-hover:text-ink-secondary transition-colors" />
                    </div>
                    <p className="text-xs text-ink-secondary mt-1.5 leading-relaxed">{insight.symptom}</p>

                    {insight.evidence && insight.evidence.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {insight.evidence.map((e, i) => (
                                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 border border-glass-border text-[10px]">
                                    <span className="text-ink-muted">{e.label}</span>
                                    <span className="font-mono text-ink-secondary">{e.value}</span>
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </button>

            {open && (
                <div className="px-4 pb-4 pl-[42px] -mt-1">
                    {insight.why.length > 0 && (
                        <div className="mt-3 rounded-lg bg-amber-500/5 border border-amber-500/15 p-2.5">
                            <div className="flex items-center gap-1.5 mb-1.5">
                                <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Why this might be happening</span>
                            </div>
                            <ul className="space-y-1">
                                {insight.why.map((w, i) => (
                                    <li key={i} className="text-[11px] text-ink-secondary leading-relaxed flex gap-1.5">
                                        <span className="text-amber-500 shrink-0">•</span>{w}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {insight.resolution.length > 0 && (
                        <div className="mt-2.5">
                            <div className="flex items-center gap-1.5 mb-1.5">
                                <Wrench className="w-3.5 h-3.5 text-emerald-500" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">How to resolve</span>
                            </div>
                            <ol className="space-y-1">
                                {insight.resolution.map((r, i) => (
                                    <li key={i} className="text-[11px] text-ink-secondary leading-relaxed flex gap-2">
                                        <span className="shrink-0 w-4 h-4 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[9px] font-bold flex items-center justify-center mt-px">{i + 1}</span>
                                        {r}
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}

                    {insight.commands && insight.commands.length > 0 && (
                        <div className="mt-2.5 space-y-1.5">
                            {insight.commands.map((c, i) => (
                                <div key={i}>
                                    <p className="text-[10px] text-ink-muted mb-1">{c.label}</p>
                                    <CommandRow cmd={c.cmd} />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

export function DiagnosticsPanel({ snapshot }: { snapshot: SystemStatusSnapshot }) {
    const insights = buildDiagnostics(snapshot)

    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                <Wrench className="w-4 h-4 text-indigo-500" />
                <div>
                    <h2 className="text-sm font-semibold text-ink">Diagnostics &amp; remediation</h2>
                    <p className="text-[11px] text-ink-muted">What each signal means, why it might be happening, and how to resolve it.</p>
                </div>
                {insights.length > 0 && (
                    <span className="ml-auto text-[11px] text-ink-muted">{insights.length} finding{insights.length === 1 ? '' : 's'}</span>
                )}
            </div>
            {insights.length === 0 ? (
                <div className="px-5 pb-5 flex items-center gap-2 text-xs text-ink-muted">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    No issues detected — every component is within its healthy thresholds.
                </div>
            ) : (
                <div className="px-4 pb-4 space-y-3">
                    {insights.map(insight => <InsightCard key={insight.id} insight={insight} />)}
                </div>
            )}
        </div>
    )
}
