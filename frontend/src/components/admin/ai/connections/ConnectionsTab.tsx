/**
 * The model connections: where the assistant's questions can be sent, what
 * each endpoint was found able to do, and when it was last tested.
 */
import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, EmptyState, HoverTip, IconButton, Skeleton } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'
import { ErrorBanner } from '@/components/admin/sso/tabs/ErrorBanner'
import {
    aiAdminService, AI_ADMIN_KEYS,
    type AiSettings, type Connection, type TestReport,
} from '@/services/aiAdminService'
import { AUTH_TYPES } from '../auth/authFields'
import { ConnectionEditorDrawer } from './ConnectionEditorDrawer'
import { TestReportView } from './TestReportView'
import { capabilityBadges, hostOf } from './connectionFormat'

const ROLES: { key: 'chatConnectionId' | 'fastConnectionId' | 'embeddingConnectionId'; label: string }[] = [
    { key: 'chatConnectionId', label: 'Answering questions' },
    { key: 'fastConnectionId', label: 'Small jobs' },
    { key: 'embeddingConnectionId', label: 'Embeddings' },
]

export function ConnectionsTab({ adding, onAddingChange }: {
    /** The add drawer is open. Held by the page, whose header opens it too. */
    adding: boolean
    onAddingChange: (open: boolean) => void
}) {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const connectionsQ = useQuery({ queryKey: AI_ADMIN_KEYS.connections, queryFn: aiAdminService.listConnections })
    const settingsQ = useQuery({ queryKey: AI_ADMIN_KEYS.settings, queryFn: aiAdminService.getSettings })
    const [editing, setEditing] = useState<Connection | null>(null)
    const [deleting, setDeleting] = useState<Connection | null>(null)
    const [reports, setReports] = useState<Record<string, TestReport>>({})

    const test = useMutation({
        mutationFn: (id: string) => aiAdminService.testConnection(id),
        onSuccess: (report, id) => {
            setReports(r => ({ ...r, [id]: report }))
            void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.connections })
        },
        onError: (err: Error) => notify('error', err.message || 'The test could not be run.'),
    })

    const rolesOf = (c: Connection, s: AiSettings | undefined) => ROLES.filter(r => s?.[r.key] === c.id)

    if (connectionsQ.isLoading) {
        return (
            <div className="space-y-2" aria-label="Loading connections">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
            </div>
        )
    }
    if (connectionsQ.error) return <ErrorBanner message={(connectionsQ.error as Error).message} />
    const rows = connectionsQ.data ?? []

    return (
        <div className="space-y-4">
            {rows.length === 0 ? (
                <div className="rounded-xl border border-glass-border bg-canvas-elevated">
                    <EmptyState
                        icon={BrainCircuit}
                        title="No model is connected yet"
                        description="Connect an OpenAI-compatible endpoint — a hosted API, your own gateway or a model server on your network. Nothing is sent anywhere until you choose it under Assistant."
                        action={{ label: 'Add a connection', icon: Plus, onClick: () => onAddingChange(true) }}
                    />
                </div>
            ) : (
                <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-glass-border text-left text-[11px] text-ink-muted">
                                <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                                <th scope="col" className="px-3 py-2.5 font-semibold">Endpoint</th>
                                <th scope="col" className="px-3 py-2.5 font-semibold">Sign-in</th>
                                <th scope="col" className="px-3 py-2.5 font-semibold">Models</th>
                                <th scope="col" className="px-3 py-2.5 font-semibold">Can do</th>
                                <th scope="col" className="px-3 py-2.5 font-semibold">Last test</th>
                                <th scope="col" className="px-3 py-2.5 font-semibold">State</th>
                                <th scope="col" className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(c => {
                                const report = reports[c.id]
                                const roles = rolesOf(c, settingsQ.data)
                                const testing = test.isPending && test.variables === c.id
                                return (
                                    <Fragment key={c.id}>
                                        <tr className="border-b border-glass-border last:border-b-0 align-top">
                                            <td className="px-4 py-3">
                                                <button
                                                    type="button"
                                                    onClick={() => setEditing(c)}
                                                    className="font-semibold text-ink hover:underline text-left"
                                                >
                                                    {c.name}
                                                </button>
                                                <span className="block text-[10px] text-ink-muted">
                                                    {roles.length ? `Used for ${roles.map(r => r.label.toLowerCase()).join(', ')}` : 'Not used by the assistant'}
                                                </span>
                                            </td>
                                            <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary">{hostOf(c.baseUrl)}</td>
                                            <td className="px-3 py-3 text-ink-secondary">
                                                {AUTH_TYPES.find(t => t.value === c.authType)?.label ?? c.authType}
                                            </td>
                                            <td className="px-3 py-3 font-mono text-[11px] text-ink-secondary">
                                                <span className="block">{c.models.chat}</span>
                                                {c.models.fast && <span className="block text-ink-muted">fast: {c.models.fast}</span>}
                                                {c.models.embedding && <span className="block text-ink-muted">embed: {c.models.embedding}</span>}
                                            </td>
                                            <td className="px-3 py-3">
                                                <span className="flex flex-wrap gap-1">
                                                    {capabilityBadges(c.capabilities).map(b => (
                                                        <Badge key={b.label} tone={b.tone}>{b.label}</Badge>
                                                    ))}
                                                </span>
                                            </td>
                                            <td className="px-3 py-3">
                                                <LastTest connection={c} />
                                            </td>
                                            <td className="px-3 py-3">
                                                {c.enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
                                            </td>
                                            <td className="px-3 py-3">
                                                <span className="flex items-center justify-end gap-1">
                                                    <Button
                                                        size="sm"
                                                        variant="secondary"
                                                        leftIcon={FlaskConical}
                                                        loading={testing}
                                                        onClick={() => test.mutate(c.id)}
                                                    >
                                                        Test
                                                    </Button>
                                                    <IconButton icon={Pencil} size="sm" label={`Edit ${c.name}`} onClick={() => setEditing(c)} />
                                                    <IconButton icon={Trash2} size="sm" variant="danger" label={`Delete ${c.name}`} onClick={() => setDeleting(c)} />
                                                </span>
                                            </td>
                                        </tr>
                                        {report && (
                                            <tr className="border-b border-glass-border last:border-b-0">
                                                <td colSpan={8} className="px-4 pb-3">
                                                    <TestReportView report={report} />
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

            {(adding || editing) && (
                <ConnectionEditorDrawer
                    connection={adding ? null : editing}
                    onClose={() => { setEditing(null); onAddingChange(false) }}
                    onSaved={() => { void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.connections }) }}
                />
            )}

            <DangerConfirmDialog
                isOpen={deleting !== null}
                title={`Delete ${deleting?.name ?? ''}`}
                subtitle="Its sign-in secrets are deleted with it."
                confirmPhrase={deleting?.name ?? ''}
                loadingImpact={settingsQ.isLoading}
                impactUnknown={Boolean(settingsQ.error)}
                sections={deleting ? [{
                    label: 'Assistant roles',
                    consequence: 'left without a connection until you choose another',
                    count: rolesOf(deleting, settingsQ.data).length,
                    items: rolesOf(deleting, settingsQ.data).map(r => ({ id: r.key, name: r.label })),
                }] : []}
                safeMessage="The assistant does not use this connection for anything."
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    const gone = deleting!
                    await aiAdminService.deleteConnection(gone.id)
                    notify('success', `Deleted ${gone.name}`)
                    void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.connections })
                    void qc.invalidateQueries({ queryKey: AI_ADMIN_KEYS.settings })
                }}
            />
        </div>
    )
}

function LastTest({ connection: c }: { connection: Connection }) {
    if (!c.lastTest) return <Badge tone="neutral">Never tested</Badge>
    const ok = c.lastTest.status === 'ok'
    const badge = <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'Passed' : 'Failed'}</Badge>
    return (
        <span className="flex flex-col items-start gap-0.5">
            {c.lastTest.detail
                ? <HoverTip label={c.lastTest.detail}><span tabIndex={0}>{badge}</span></HoverTip>
                : badge}
            <DateTime at={c.lastTest.at} className="text-[10px] text-ink-muted" />
        </span>
    )
}
