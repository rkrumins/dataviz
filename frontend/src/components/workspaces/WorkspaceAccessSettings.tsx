/**
 * How people get into this workspace — the three settings its admins
 * choose, on the Members tab:
 *
 * - **Listed in Find a workspace.** Everyone who can sign in sees its name,
 *   description and who answers requests — once an administrator turns
 *   Find a workspace on. Hidden, only its members see it there.
 * - **Who decides.** Approvers here (admins and stewards answer requests),
 *   or the identity provider's groups — then an approver points people to
 *   the group that grants it, and anything granted here is an exception.
 * - **A note for people asking.** "Say which team you're on."
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, ShieldCheck, SlidersHorizontal } from 'lucide-react'

import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { useAppNotifications } from '@/components/ui/notifications'
import { WORKSPACE_ACCESS_KEY, WORKSPACE_DIRECTORY_FEATURE } from '@/hooks/useWorkspaceAccess'
import type { WorkspaceAccessMode } from '@/services/accessRequestsService'
import { workspaceService } from '@/services/workspaceService'
import { useFeature } from '@/store/features'
import { cn } from '@/lib/utils'

const MODES: { value: WorkspaceAccessMode; title: string; body: string; icon: typeof ShieldCheck }[] = [
    {
        value: 'app',
        title: 'Approved in the app',
        body: 'Its admins and stewards answer requests and add people here.',
        icon: ShieldCheck,
    },
    {
        value: 'idp',
        title: 'Through your identity provider',
        body: 'Membership follows identity-provider groups. Approvers point people to the group that grants it; anything granted here is marked as an exception.',
        icon: KeyRound,
    },
]

export function WorkspaceAccessSettings({ workspaceId }: { workspaceId: string }) {
    const { notify } = useAppNotifications()
    const queryClient = useQueryClient()
    const directoryOn = useFeature(WORKSPACE_DIRECTORY_FEATURE)
    const { data: ws } = useQuery({
        queryKey: [...WORKSPACE_ACCESS_KEY, 'settings', workspaceId],
        queryFn: () => workspaceService.get(workspaceId),
    })
    // Edits sit over the saved values until they are saved.
    const [draft, setDraft] = useState<{ listed?: boolean; mode?: WorkspaceAccessMode; note?: string }>({})
    const [saving, setSaving] = useState(false)
    const savedListed = ws?.directoryListed !== false
    const savedMode = ws?.accessMode ?? 'app'
    const savedNote = ws?.accessNote ?? ''
    const listed = draft.listed ?? savedListed
    const mode = draft.mode ?? savedMode
    const note = draft.note ?? savedNote
    const setListed = (value: boolean) => setDraft(d => ({ ...d, listed: value }))
    const setMode = (value: WorkspaceAccessMode) => setDraft(d => ({ ...d, mode: value }))
    const setNote = (value: string) => setDraft(d => ({ ...d, note: value }))

    const dirty = !!ws && (listed !== savedListed || mode !== savedMode || note.trim() !== savedNote)

    const save = async () => {
        setSaving(true)
        try {
            await workspaceService.update(workspaceId, { directoryListed: listed, accessMode: mode, accessNote: note.trim() })
            await queryClient.invalidateQueries({ queryKey: WORKSPACE_ACCESS_KEY })
            setDraft({})
            notify('success', 'Access settings saved.')
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 space-y-4" aria-labelledby="access-settings-title">
            <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-indigo-500" aria-hidden />
                <h3 id="access-settings-title" className="text-sm font-bold text-ink">How people get in</h3>
            </div>

            <div className="flex items-start justify-between gap-4">
                <label htmlFor="ws-directory-listed" className="min-w-0 cursor-pointer">
                    <span className="block text-sm font-semibold text-ink">Listed in Find a workspace</span>
                    <span className="block text-xs text-ink-muted mt-0.5">
                        {directoryOn
                            ? 'Everyone who can sign in sees its name, description and who answers requests.'
                            : 'Find a workspace is switched off for this deployment; this applies once an administrator turns it on.'}
                    </span>
                </label>
                <ToggleSwitch id="ws-directory-listed" size="sm" checked={listed} onChange={setListed} disabled={!ws} />
            </div>

            <fieldset>
                <legend className="text-sm font-semibold text-ink mb-2">Who decides who is in</legend>
                <div role="radiogroup" className="grid gap-2 md:grid-cols-2">
                    {MODES.map(m => {
                        const selected = mode === m.value
                        const Icon = m.icon
                        return (
                            <button
                                key={m.value}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={!ws}
                                onClick={() => setMode(m.value)}
                                className={cn(
                                    'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                                    selected
                                        ? 'border-indigo-500/50 bg-indigo-500/[0.06] ring-1 ring-indigo-500/30'
                                        : 'border-glass-border hover:border-indigo-500/30',
                                )}
                            >
                                <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', selected ? 'text-indigo-500' : 'text-ink-muted')} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold text-ink">{m.title}</span>
                                    <span className="block text-xs text-ink-muted mt-0.5">{m.body}</span>
                                </span>
                            </button>
                        )
                    })}
                </div>
            </fieldset>

            <label className="block">
                <span className="text-sm font-semibold text-ink">A note for people asking</span>
                <textarea
                    value={note}
                    maxLength={500}
                    rows={2}
                    disabled={!ws}
                    onChange={e => setNote(e.target.value)}
                    placeholder="Say which team you’re on and what you need it for"
                    className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none text-sm"
                />
            </label>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent-lineage hover:brightness-110 disabled:opacity-50"
                >
                    {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                    Save
                </button>
            </div>
        </section>
    )
}
