/**
 * TransferPreviewSummary — what a move takes with it, before anyone commits.
 *
 * Three tiles answer the questions people actually ask (which views, does
 * the history come, will it have to rebuild), then anything that stands in
 * the way, then the views themselves. Shared by the move wizard and the
 * review dialog, so the proposer and the reviewer read the same page.
 */
import { useState } from 'react'
import {
    ChevronDown, Eye, GitBranch, Globe, Lock, Settings2, Trash2, Users, Megaphone, CornerDownRight,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { TransferIssue, TransferPreview, TransferView } from '@/services/dataSourceTransferService'
import { TransferRoute } from './TransferRoute'
import { ISSUE_TONES, plural, workspaceLabel } from './transferCopy'

const VIEWS_SHOWN = 8

export function TransferPreviewSummary({ preview }: { preview: TransferPreview }) {
    const { viewCounts: counts, versioning } = preview
    const from = workspaceLabel(preview.fromWorkspace.name)
    const warnings = preview.notes.filter(n => n.severity === 'warning')
    const infos = preview.notes.filter(n => n.severity === 'info')

    return (
        <div className="space-y-5">
            <TransferRoute from={preview.fromWorkspace} to={preview.toWorkspace} sourceName={preview.dataSource.name} />

            {/* Said once, politely, for a screen reader arriving on this step. */}
            <p className="sr-only" aria-live="polite">
                {preview.blockers.length
                    ? `${plural(preview.blockers.length, 'thing')} to resolve before moving`
                    : 'Nothing stands in the way'}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <StatTile icon={Eye} tint="text-indigo-500 bg-indigo-500/10" label="Views" value={counts.total.toLocaleString()}>
                    {counts.total === 0 ? (
                        <span>Nothing is built on it yet</span>
                    ) : (
                        <span className="flex flex-wrap gap-1">
                            {counts.private > 0 && <Chip icon={Lock}>{counts.private} private</Chip>}
                            {counts.workspace > 0 && <Chip icon={Users}>{counts.workspace} workspace</Chip>}
                            {counts.enterprise > 0 && <Chip icon={Globe}>{counts.enterprise} everyone</Chip>}
                            {counts.trashed > 0 && <Chip icon={Trash2}>+{counts.trashed} in the trash</Chip>}
                            {counts.followsDefault > 0 && (
                                <Chip icon={CornerDownRight}>+{counts.followsDefault} follow {from}’s default</Chip>
                            )}
                        </span>
                    )}
                </StatTile>
                <StatTile
                    icon={GitBranch}
                    tint="text-violet-500 bg-violet-500/10"
                    label="Version history"
                    value={versioning ? versioning.commits.toLocaleString() : '—'}
                >
                    {versioning
                        ? `${plural(versioning.commits, 'revision')} · ${plural(versioning.openDrafts, 'open draft')} · ${plural(versioning.openReviews, 'open review')}`
                        : 'Not under version control'}
                </StatTile>
                <StatTile icon={Settings2} tint="text-emerald-500 bg-emerald-500/10" label="Settings & rollups" value="Kept">
                    Aggregation, freshness and stats come with it — no rebuild
                </StatTile>
            </div>

            {preview.blockers.length > 0 && <IssueGroup severity="blocker" issues={preview.blockers} />}
            {warnings.length > 0 && <IssueGroup severity="warning" issues={warnings} />}
            {infos.length > 0 && <IssueGroup severity="info" issues={infos} />}

            {preview.views.length > 0 && <ViewsMoving views={preview.views} total={counts.total} />}
        </div>
    )
}

function StatTile({ icon: Icon, tint, label, value, children }: {
    icon: typeof Eye
    tint: string
    label: string
    value: string
    children: React.ReactNode
}) {
    return (
        <div className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated p-4">
            <div className="flex items-center gap-2">
                <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', tint)}>
                    <Icon className="w-3.5 h-3.5" aria-hidden />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
            </div>
            <p className="mt-2.5 text-2xl font-bold text-ink tabular-nums">{value}</p>
            <div className="mt-1 text-[11px] leading-relaxed text-ink-muted">{children}</div>
        </div>
    )
}

function Chip({ icon: Icon, children }: { icon: typeof Eye; children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">
            <Icon className="w-2.5 h-2.5" aria-hidden />
            {children}
        </span>
    )
}

function IssueGroup({ severity, issues }: { severity: TransferIssue['severity']; issues: TransferIssue[] }) {
    const tone = ISSUE_TONES[severity]
    return (
        <section aria-label={tone.title} className="space-y-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{tone.title}</h4>
            <ul className="space-y-2">
                {issues.map(issue => <IssueRow key={issue.code} issue={issue} />)}
            </ul>
        </section>
    )
}

function IssueRow({ issue }: { issue: TransferIssue }) {
    const [open, setOpen] = useState(false)
    const tone = ISSUE_TONES[issue.severity]
    const Icon = tone.icon
    return (
        <li className={cn('rounded-xl border px-3.5 py-2.5', tone.box)}>
            <div className="flex items-start gap-2.5">
                <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', tone.iconClass)} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink leading-snug">{issue.message}</p>
                    {issue.severity === 'blocker' && issue.transient && (
                        <p className="text-[11px] text-ink-muted mt-0.5">Clears by itself — try again shortly.</p>
                    )}
                </div>
                {issue.items.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-expanded={open}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-secondary hover:text-ink shrink-0"
                    >
                        {open ? 'Hide' : `Show ${issue.items.length}`}
                        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
                    </button>
                )}
            </div>
            {open && (
                <ul className="mt-2 pl-10 space-y-0.5 text-xs text-ink-secondary list-disc">
                    {issue.items.map(item => <li key={item.id} className="break-words">{item.name}</li>)}
                </ul>
            )}
        </li>
    )
}

const VIS_ICON: Record<string, typeof Eye> = { private: Lock, workspace: Users, enterprise: Globe }
const VIS_LABEL: Record<string, string> = { private: 'Private', workspace: 'Workspace', enterprise: 'Everyone' }

function ViewsMoving({ views, total }: { views: TransferView[]; total: number }) {
    const [all, setAll] = useState(false)
    const shown = all ? views : views.slice(0, VIEWS_SHOWN)
    const hidden = total - shown.length
    return (
        <section aria-label="Views that move" className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated overflow-hidden">
            <div className="px-4 py-2.5 border-b border-black/[0.08] dark:border-white/[0.10] flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-indigo-500" aria-hidden />
                <h4 className="text-xs font-bold text-ink">Views that move with it</h4>
                <span className="ml-auto text-[11px] text-ink-muted tabular-nums">{plural(total, 'view')}</span>
            </div>
            <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
                {shown.map(v => {
                    const Vis = VIS_ICON[v.visibility] ?? Lock
                    return (
                        <li key={v.id} className={cn('px-4 py-2 flex items-center gap-2.5', v.trashed && 'opacity-60')}>
                            <Vis className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-label={VIS_LABEL[v.visibility] ?? v.visibility} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm text-ink truncate">{v.name}</span>
                                {v.ownerName && <span className="block text-[11px] text-ink-muted truncate">{v.ownerName}</span>}
                            </span>
                            <span className="flex items-center gap-1 shrink-0">
                                {v.trashed && <Tag className="bg-slate-500/10 text-slate-600 dark:text-slate-400">In the trash</Tag>}
                                {v.followsDefault && <Tag className="bg-sky-500/10 text-sky-600 dark:text-sky-400">Follows default</Tag>}
                                {v.publishRequested && (
                                    <Tag className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                                        <Megaphone className="w-2.5 h-2.5" aria-hidden /> Publish requested
                                    </Tag>
                                )}
                            </span>
                        </li>
                    )
                })}
            </ul>
            {(views.length > VIEWS_SHOWN || hidden > 0) && (
                <div className="px-4 py-2 border-t border-black/[0.06] dark:border-white/[0.06] flex items-center gap-2 text-xs">
                    {views.length > VIEWS_SHOWN && (
                        <button type="button" onClick={() => setAll(a => !a)} className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                            {all ? 'Show fewer' : `Show all ${views.length}`}
                        </button>
                    )}
                    {all && hidden > 0 && <span className="text-ink-muted">and {plural(hidden, 'more view')} not listed</span>}
                </div>
            )}
        </section>
    )
}

function Tag({ className, children }: { className: string; children: React.ReactNode }) {
    return (
        <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', className)}>
            {children}
        </span>
    )
}
