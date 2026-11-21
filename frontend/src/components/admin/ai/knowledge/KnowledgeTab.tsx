/**
 * What the assistant can look things up in: the product's own collections
 * (the guide and docs, and views) in the vector store, and external MCP
 * servers an administrator adds.
 */
import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenText, Database, FlaskConical, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyState, IconButton, Skeleton, type BadgeTone } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'
import { SsoCard } from '@/components/admin/sso/ui/SsoCard'
import { ErrorBanner } from '@/components/admin/sso/tabs/ErrorBanner'
import {
    aiAdminService, AI_ADMIN_KEYS,
    type KnowledgeCollection, type KnowledgeSource, type KnowledgeSourceTestReport, type KnowledgeStatus,
} from '@/services/aiAdminService'
import { cn } from '@/lib/utils'
import { CheckList } from '../connections/TestReportView'
import { detailText, hostOf } from '../connections/connectionFormat'
import { KnowledgeSourceDrawer } from './KnowledgeSourceDrawer'
import { PERSONAS } from './useKnowledgeSourceEditor'

const COLLECTION_LABELS: Record<string, { label: string; blurb: string }> = {
    docs: { label: 'Guide and docs', blurb: 'This product’s guide, for the Help persona' },
    views: { label: 'Views', blurb: 'Names and descriptions of views, to find one by what it is about' },
}

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
    ready: { label: 'Ready', tone: 'success' },
    building: { label: 'Building', tone: 'info' },
    lexical: { label: 'Words only', tone: 'warning' },
    disabled: { label: 'Off', tone: 'neutral' },
    failed: { label: 'Failed', tone: 'danger' },
}

const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

/** How far behind a collection is: a count of changes waiting, or the server's own words. */
function lagText(lag: KnowledgeCollection['lag']): string {
    if (lag == null || lag === '') return '—'
    if (typeof lag === 'number') return lag === 0 ? 'Up to date' : `${lag.toLocaleString()} waiting`
    return lag
}

export function CollectionsTable({ status, onReindex, reindexing }: {
    status: KnowledgeStatus
    onReindex: (name: string) => void
    /** The collection a re-index was just asked for. */
    reindexing?: string | null
}) {
    return (
        <div className="space-y-3">
            <p className="flex items-center gap-2 text-xs text-ink-muted">
                <Database className="w-3.5 h-3.5" aria-hidden />
                {status.store === 'none'
                    ? 'No vector store is configured, so collections are searched by their words only.'
                    : <>Vector store: <span className="font-mono text-ink-secondary">{status.store}</span></>}
            </p>
            <div className="rounded-xl border border-glass-border overflow-x-auto">
                <table className="w-full text-xs" aria-label="Knowledge collections">
                    <thead>
                        <tr className="border-b border-glass-border text-left text-[11px] text-ink-muted">
                            <th scope="col" className="px-4 py-2.5 font-semibold">Collection</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Version</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Model</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold text-right">Dimensions</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold text-right">Documents</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold text-right">Chunks</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Last sync</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Lag</th>
                            <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {status.collections.map(c => {
                            const meta = COLLECTION_LABELS[c.name]
                            const st = STATUS[c.status] ?? { label: c.status, tone: 'neutral' as BadgeTone }
                            return (
                                <Fragment key={c.name}>
                                    <tr className={cn('align-top', !c.error && 'border-b border-glass-border last:border-b-0')}>
                                        <td className="px-4 py-3">
                                            <span className="block font-semibold text-ink">{meta?.label ?? c.name}</span>
                                            {meta && <span className="block text-[10px] text-ink-muted">{meta.blurb}</span>}
                                        </td>
                                        <td className="px-3 py-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                                        <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary">{c.version ?? '—'}</td>
                                        <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary">{c.model ?? '—'}</td>
                                        <td className="px-3 py-3 text-right tabular-nums">{num(c.dimensions)}</td>
                                        <td className="px-3 py-3 text-right tabular-nums">{num(c.documents)}</td>
                                        <td className="px-3 py-3 text-right tabular-nums">{num(c.chunks)}</td>
                                        <td className="px-3 py-3"><DateTime at={c.lastSyncAt} empty="Never" /></td>
                                        <td className="px-3 py-3 text-ink-secondary">{lagText(c.lag)}</td>
                                        <td className="px-3 py-3 text-right">
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                leftIcon={RefreshCw}
                                                loading={reindexing === c.name}
                                                disabled={c.status === 'building' || c.status === 'disabled'}
                                                aria-label={`Re-index ${meta?.label ?? c.name}`}
                                                onClick={() => onReindex(c.name)}
                                            >
                                                Re-index
                                            </Button>
                                        </td>
                                    </tr>
                                    {c.error && (
                                        <tr className="border-b border-glass-border last:border-b-0">
                                            <td colSpan={10} className="px-4 pb-3 text-[11px] text-rose-600 dark:text-rose-400">{c.error}</td>
                                        </tr>
                                    )}
                                </Fragment>
                            )
                        })}
                    </tbody>
                </table>
            </div>
            <p className="text-[11px] text-ink-muted">
                Re-indexing builds a new version beside the one in use and switches over when it is complete, so answers keep working meanwhile.
            </p>
        </div>
    )
}

export function KnowledgeTab() {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const knowledgeQ = useQuery({
        queryKey: AI_ADMIN_KEYS.knowledge,
        queryFn: aiAdminService.knowledge,
        // Follow a build as it goes; stop asking once nothing is building.
        refetchInterval: q => (q.state.data?.collections.some(c => c.status === 'building') ? 5000 : false),
    })
    const sourcesQ = useQuery({ queryKey: AI_ADMIN_KEYS.sources, queryFn: aiAdminService.listKnowledgeSources })
    const [editing, setEditing] = useState<KnowledgeSource | 'new' | null>(null)
    const [deleting, setDeleting] = useState<KnowledgeSource | null>(null)
    const [reports, setReports] = useState<Record<string, KnowledgeSourceTestReport>>({})

    const reindex = useMutation({
        mutationFn: (name: string) => aiAdminService.reindex(name),
        onSuccess: (_, name) => {
            notify('success', `Re-indexing ${COLLECTION_LABELS[name]?.label ?? name}. Its status updates here as it goes.`)
            void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.knowledge })
        },
        onError: (err: Error) => notify('error', err.message || 'The re-index could not be started.'),
    })
    const test = useMutation({
        mutationFn: (id: string) => aiAdminService.testKnowledgeSource(id),
        onSuccess: (report, id) => setReports(r => ({ ...r, [id]: report })),
        onError: (err: Error) => notify('error', err.message || 'The test could not be run.'),
    })

    const sources = sourcesQ.data ?? []

    return (
        <div className="space-y-5">
            <SsoCard icon={Database} title="Collections" blurb="What the assistant searches inside the platform.">
                {knowledgeQ.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                ) : knowledgeQ.data ? (
                    <CollectionsTable
                        status={knowledgeQ.data}
                        onReindex={name => reindex.mutate(name)}
                        reindexing={reindex.isPending ? reindex.variables : null}
                    />
                ) : (
                    <ErrorBanner message={(knowledgeQ.error as Error | null)?.message ?? 'The knowledge status could not be read.'} />
                )}
            </SsoCard>

            <SsoCard
                icon={BookOpenText}
                title="External knowledge sources"
                blurb="MCP servers the assistant also asks — a wiki, a runbook search, a ticket system — beside this product’s own guide."
                actions={<Button size="sm" variant="primary" leftIcon={Plus} onClick={() => setEditing('new')}>Add a source</Button>}
            >
                <p className="mb-4 flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
                    <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    <span>
                        Answers from these sources are always labelled with the source’s name and trust label, and treated as
                        untrusted: the assistant may quote them, but never follows instructions found in them.
                    </span>
                </p>
                {sourcesQ.isLoading ? (
                    <Skeleton className="h-16 w-full" />
                ) : sourcesQ.error ? (
                    <ErrorBanner message={(sourcesQ.error as Error).message} />
                ) : sources.length === 0 ? (
                    <EmptyState compact icon={BookOpenText} title="No external sources"
                        description="The assistant answers from this product’s guide only." />
                ) : (
                    <div className="rounded-xl border border-glass-border overflow-x-auto">
                        <table className="w-full text-xs" aria-label="External knowledge sources">
                            <thead>
                                <tr className="border-b border-glass-border text-left text-[11px] text-ink-muted">
                                    <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                                    <th scope="col" className="px-3 py-2.5 font-semibold">Endpoint</th>
                                    <th scope="col" className="px-3 py-2.5 font-semibold">Tool</th>
                                    <th scope="col" className="px-3 py-2.5 font-semibold">Asked by</th>
                                    <th scope="col" className="px-3 py-2.5 font-semibold">State</th>
                                    <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {sources.map(s => {
                                    const report = reports[s.id]
                                    return (
                                        <Fragment key={s.id}>
                                            <tr className="border-b border-glass-border last:border-b-0 align-top">
                                                <td className="px-4 py-3">
                                                    <button type="button" onClick={() => setEditing(s)} className="font-semibold text-ink hover:underline text-left">
                                                        {s.name}
                                                    </button>
                                                    {s.trustLabel && <span className="block text-[10px] text-ink-muted">{s.trustLabel}</span>}
                                                </td>
                                                <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary">{hostOf(s.url)}</td>
                                                <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary">{s.toolName}</td>
                                                <td className="px-3 py-3 text-ink-secondary">
                                                    {s.personas.length
                                                        ? s.personas.map(p => PERSONAS.find(x => x.value === p)?.label ?? p).join(', ')
                                                        : 'No one'}
                                                </td>
                                                <td className="px-3 py-3">
                                                    {s.enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
                                                </td>
                                                <td className="px-3 py-3">
                                                    <span className="flex items-center justify-end gap-1">
                                                        <Button size="sm" variant="secondary" leftIcon={FlaskConical}
                                                            loading={test.isPending && test.variables === s.id}
                                                            onClick={() => test.mutate(s.id)}>
                                                            Test
                                                        </Button>
                                                        <IconButton icon={Pencil} size="sm" label={`Edit ${s.name}`} onClick={() => setEditing(s)} />
                                                        <IconButton icon={Trash2} size="sm" variant="danger" label={`Delete ${s.name}`} onClick={() => setDeleting(s)} />
                                                    </span>
                                                </td>
                                            </tr>
                                            {report && (
                                                <tr className="border-b border-glass-border last:border-b-0">
                                                    <td colSpan={6} className="px-4 pb-3">
                                                        <SourceTestView report={report} />
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </SsoCard>

            {editing && <KnowledgeSourceDrawer source={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

            <DangerConfirmDialog
                isOpen={deleting !== null}
                title={`Delete ${deleting?.name ?? ''}`}
                subtitle="The assistant stops asking it. Its sign-in secrets are deleted with it."
                confirmPhrase={deleting?.name ?? ''}
                sections={[]}
                safeMessage="Nothing else depends on this source."
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    const gone = deleting!
                    await aiAdminService.deleteKnowledgeSource(gone.id)
                    notify('success', `Deleted ${gone.name}`)
                    void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.sources })
                }}
            />
        </div>
    )
}

function SourceTestView({ report }: { report: KnowledgeSourceTestReport }) {
    const detail = detailText(report.detail)
    return (
        <div
            role="status"
            aria-label="Test result"
            className={cn(
                'rounded-xl border p-3 space-y-2 text-xs',
                report.ok ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-rose-500/25 bg-rose-500/[0.05]',
            )}
        >
            <p className="font-semibold text-ink">
                {report.ok ? 'The source answered.' : 'The source could not answer.'}
                {report.latencyMs != null && <span className="ml-2 font-normal tabular-nums text-ink-muted">{report.latencyMs.toLocaleString()} ms</span>}
            </p>
            {detail && <p className={report.ok ? 'text-ink-muted' : 'text-rose-600 dark:text-rose-400'}>{detail}</p>}
            {report.checks && <CheckList checks={report.checks} />}
        </div>
    )
}
