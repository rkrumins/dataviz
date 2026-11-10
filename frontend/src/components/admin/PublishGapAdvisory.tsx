/**
 * Roles that change data but don't publish it — and a way to add publish.
 *
 * Publishing a versioned data source (a draft, a review's merge, a snapshot
 * sync, an import that publishes itself, a write to the published version)
 * needs `workspace:datasource:publish`. It arrived after `manage`, and the
 * migration that added it gave it to no custom role and not to Workspace
 * member, on purpose: publishing is a governance act. So a role made to "run
 * the data" before then edits drafts but can't publish them, and the people,
 * service accounts and API keys on it meet `403 publish_required`.
 *
 * This lists those roles. Nothing changes until an admin asks for it, one role
 * at a time, through the same impact preview the role editor uses.
 */
import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Plus } from 'lucide-react'

import { useAppNotifications } from '@/components/ui/notifications'
import { ROLE_VISUAL } from '@/lib/roleVisual'
import { cn } from '@/lib/utils'
import {
    permissionsService,
    type ImpactPreviewResponse,
    type RoleDefinitionResponse,
} from '@/services/permissionsService'
import { ImpactPreviewModal } from './ImpactPreviewModal'

const PUBLISH_DATA = 'workspace:datasource:publish'
const MANAGE_DATA = 'workspace:datasource:manage'

/** Roles that change data and don't publish it. A role with
 *  `workspace:admin` publishes through it, so it is never one. */
export function publishGapRoles(roles: RoleDefinitionResponse[]): RoleDefinitionResponse[] {
    return roles.filter((r) => r.permissions.includes(MANAGE_DATA)
        && !r.permissions.includes(PUBLISH_DATA)
        && !r.permissions.includes('workspace:admin'))
}

function labelOf(role: RoleDefinitionResponse): string {
    return role.isSystem ? (ROLE_VISUAL[role.name]?.label ?? role.name) : role.name
}

interface Pending {
    role: RoleDefinitionResponse
    loading: boolean
    preview: ImpactPreviewResponse | null
    error: string | null
}

export function PublishGapAdvisory({ roles, onChanged }: {
    roles: RoleDefinitionResponse[]
    onChanged: () => Promise<void> | void
}) {
    const gaps = publishGapRoles(roles)
    const [open, setOpen] = useState(true)
    const [pending, setPending] = useState<Pending | null>(null)
    const [saving, setSaving] = useState(false)
    const { notify } = useAppNotifications()
    if (gaps.length === 0) return null

    const ask = async (role: RoleDefinitionResponse) => {
        setPending({ role, loading: true, preview: null, error: null })
        try {
            const preview = await permissionsService.previewRoleUpdate(role.name, [...role.permissions, PUBLISH_DATA])
            setPending((p) => p?.role.name === role.name ? { ...p, loading: false, preview } : p)
        } catch (err) {
            const error = err instanceof Error ? err.message : 'Preview failed'
            setPending((p) => p?.role.name === role.name ? { ...p, loading: false, error } : p)
        }
    }

    const confirm = async () => {
        if (!pending) return
        const { role } = pending
        setSaving(true)
        try {
            await permissionsService.updateRole(role.name, {
                description: role.description,
                permissions: [...role.permissions, PUBLISH_DATA],
            })
            notify('success', `“${labelOf(role)}” publishes data now`)
            setPending(null)
            await onChanged()
        } catch (err) {
            notify('error', err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <section
            aria-label="Roles that change data but don't publish it"
            className="border border-amber-500/25 rounded-xl bg-amber-500/[0.05] overflow-hidden"
        >
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-start gap-3 p-4 text-left"
            >
                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" aria-hidden />
                <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-ink">
                        {gaps.length === 1 ? '1 role changes' : `${gaps.length} roles change`} data but can’t publish it
                    </span>
                    <span className="block text-xs text-ink-secondary leading-relaxed mt-0.5">
                        Publishing a draft, merging a review, syncing a snapshot and imports that publish themselves need
                        Publish data sources. People, service accounts and API keys on these roles import into drafts but
                        get <code className="text-[11px]">403 publish_required</code> when they publish.
                    </span>
                </span>
                {open
                    ? <ChevronDown className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" aria-hidden />
                    : <ChevronRight className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" aria-hidden />}
            </button>
            {open && (
                <ul className="border-t border-amber-500/20 divide-y divide-amber-500/15">
                    {gaps.map((role) => (
                        <li key={role.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-ink truncate">{labelOf(role)}</span>
                                <span className="block text-xs text-ink-muted">
                                    {role.bindingCount} binding{role.bindingCount === 1 ? '' : 's'}
                                    {role.name === 'workspace_member' && (
                                        <> · Every member would gain publish. Prefer giving Workspace publisher to the
                                            people and service accounts that publish.</>
                                    )}
                                </span>
                            </span>
                            <button
                                type="button"
                                onClick={() => void ask(role)}
                                aria-label={`Add publish to ${labelOf(role)}`}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border',
                                    'border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10',
                                )}
                            >
                                <Plus className="w-3.5 h-3.5" aria-hidden /> Add publish
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <ImpactPreviewModal
                open={pending !== null}
                title={pending ? `Let “${labelOf(pending.role)}” publish data?` : ''}
                intent="caution"
                confirmLabel="Add publish"
                preview={pending?.preview ?? null}
                loading={pending?.loading ?? false}
                error={pending?.error ?? null}
                confirming={saving}
                onCancel={() => setPending(null)}
                onConfirm={() => void confirm()}
            />
        </section>
    )
}
