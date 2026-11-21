/**
 * The business vocabulary people taught the assistant for a data source:
 * each term, the search it stands for, and whether it is one person's or
 * the whole workspace's. A personal meaning can be promoted to the
 * workspace's, and any can be deleted.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookA, Share2, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyState, IconButton, Skeleton } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'
import { Field, SelectField } from '@/components/admin/sso/settings/ui'
import { SsoCard } from '@/components/admin/sso/ui/SsoCard'
import { ErrorBanner } from '@/components/admin/sso/tabs/ErrorBanner'
import { useWorkspacesStore } from '@/store/workspaces'
import { stringifyPredicate } from '@/components/canvas/search/panel/predicateDsl'
import { aiAdminService, AI_ADMIN_KEYS, type ConceptMapping } from '@/services/aiAdminService'
import { conceptName } from '@/features/ai-assistant/lib/conceptName'

/** A mapping's search as the Advanced Search text a person would type. */
function predicateText(p: ConceptMapping['predicate']): string {
    try {
        return stringifyPredicate(p) || '—'
    } catch {
        return JSON.stringify(p)
    }
}

export function VocabularyTab() {
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore(s => s.activeDataSourceId)
    const [wsId, setWsId] = useState<string | null>(null)
    const [dsId, setDsId] = useState<string | null>(null)

    // Until a choice is made, the workspace and data source open in the app.
    const ws = workspaces.find(w => w.id === (wsId ?? activeWorkspaceId)) ?? workspaces[0]
    const sources = ws?.dataSources ?? []
    const ds = sources.find(d => d.id === (dsId ?? activeDataSourceId))
        ?? sources.find(d => d.isPrimary) ?? sources[0]

    return (
        <div className="space-y-5">
            <SsoCard
                icon={BookA}
                title="Business vocabulary"
                blurb="When someone uses a word the data does not — “PII”, “gold tables”, “customer data” — the assistant asks what it means here and can remember the answer. A personal meaning applies only to the person who taught it; promote it to make it the workspace’s meaning for everyone."
            >
                <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
                    <Field label="Workspace">
                        <SelectField value={ws?.id ?? ''} onChange={e => { setWsId(e.target.value); setDsId(null) }}>
                            {workspaces.length === 0 && <option value="">No workspaces</option>}
                            {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </SelectField>
                    </Field>
                    <Field label="Data source">
                        <SelectField value={ds?.id ?? ''} onChange={e => setDsId(e.target.value)}>
                            {sources.length === 0 && <option value="">No data sources</option>}
                            {sources.map(d => <option key={d.id} value={d.id}>{d.label || d.graphName || d.id}</option>)}
                        </SelectField>
                    </Field>
                </div>
            </SsoCard>

            {ds
                ? <ConceptList dataSourceId={ds.id} workspaceName={ws?.name ?? 'the workspace'} />
                : <EmptyState icon={BookA} title="Choose a data source" description="Vocabulary is kept per data source, because a word can mean different things in each." />}
        </div>
    )
}

function ConceptList({ dataSourceId, workspaceName }: { dataSourceId: string; workspaceName: string }) {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const key = AI_ADMIN_KEYS.concepts(dataSourceId)
    const conceptsQ = useQuery({ queryKey: key, queryFn: () => aiAdminService.listConcepts(dataSourceId) })
    const [deleting, setDeleting] = useState<ConceptMapping | null>(null)

    const promote = useMutation({
        mutationFn: (c: ConceptMapping) => aiAdminService.promoteConcept(c.id),
        onSuccess: (_, c) => {
            notify('success', `“${conceptName(c.concept)}” now means the same for everyone in ${workspaceName}`)
            void qc.invalidateQueries({ queryKey: key })
        },
        onError: (err: Error) => notify('error', err.message || 'The meaning could not be shared.'),
    })

    if (conceptsQ.isLoading) return <Skeleton className="h-24 w-full" />
    if (conceptsQ.error) return <ErrorBanner message={(conceptsQ.error as Error).message} />
    const rows = conceptsQ.data ?? []
    if (rows.length === 0) {
        return (
            <div className="rounded-xl border border-glass-border bg-canvas-elevated">
                <EmptyState icon={BookA} title="No vocabulary yet for this data source"
                    description="Terms appear here when someone answers one of the assistant’s “which of these do you mean?” questions and asks it to remember." />
            </div>
        )
    }

    return (
        <>
            <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-x-auto">
                <table className="w-full text-xs" aria-label="Business vocabulary">
                    <thead>
                        <tr className="border-b border-glass-border text-left text-[11px] text-ink-muted">
                            <th scope="col" className="px-4 py-2.5 font-semibold">Term</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Means</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Applies to</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold text-right">Uses</th>
                            <th scope="col" className="px-3 py-2.5 font-semibold">Updated</th>
                            <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(c => (
                            <tr key={c.id} className="border-b border-glass-border last:border-b-0 align-top">
                                <td className="px-4 py-3">
                                    <span className="block font-semibold text-ink">{conceptName(c.concept)}</span>
                                    {c.label && c.label !== c.concept && <span className="block text-[10px] text-ink-muted">{c.label}</span>}
                                </td>
                                <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary break-words max-w-md">{predicateText(c.predicate)}</td>
                                <td className="px-3 py-3">
                                    {c.scope === 'workspace'
                                        ? <Badge tone="accent">Workspace</Badge>
                                        : <Badge tone="neutral">Personal</Badge>}
                                </td>
                                <td className="px-3 py-3 text-right tabular-nums">{c.uses.toLocaleString()}</td>
                                <td className="px-3 py-3"><DateTime at={c.updatedAt} /></td>
                                <td className="px-3 py-3">
                                    <span className="flex items-center justify-end gap-1">
                                        {c.scope === 'personal' && (
                                            <Button size="sm" variant="secondary" leftIcon={Share2}
                                                loading={promote.isPending && promote.variables?.id === c.id}
                                                onClick={() => promote.mutate(c)}>
                                                Share with workspace
                                            </Button>
                                        )}
                                        <IconButton icon={Trash2} size="sm" variant="danger" label={`Delete ${conceptName(c.concept)}`} onClick={() => setDeleting(c)} />
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <DangerConfirmDialog
                isOpen={deleting !== null}
                title={`Delete “${deleting ? conceptName(deleting.concept) : ''}”`}
                confirmPhrase=""
                sections={[]}
                safeMessage={deleting?.scope === 'workspace'
                    ? `Nobody in ${workspaceName} keeps this meaning.`
                    : 'Only the person who taught it loses this meaning.'}
                caveat="The assistant asks what the word means the next time someone uses it."
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    const gone = deleting!
                    await aiAdminService.deleteConcept(gone.id)
                    notify('success', `Deleted “${conceptName(gone.concept)}”`)
                    void qc.invalidateQueries({ queryKey: key })
                }}
            />
        </>
    )
}
