/**
 * Workspace-level node-identity defaults.
 *
 * Sits above the source grid because that is exactly what it governs: every
 * source in this workspace that does not set its own mapping, and whose
 * provider does not set one either. A provider default outranks this one — the
 * provider describes what the graphs on that connection actually look like,
 * while a workspace only states a team preference.
 */
import { useEffect, useState } from 'react'
import { Loader2, Save, RotateCcw } from 'lucide-react'
import { NodeIdentityField, normalizeIdentity, normalizeName } from '@/components/dataSource/NodeIdentity'
import { workspaceService } from '@/services/workspaceService'
import { useToast } from '@/components/ui/toast'

interface Props {
    wsId: string
    /** The workspace's OWN stored values (null/absent = it sets none). */
    identityProperty?: string | null
    nameProperty?: string | null
    canEdit: boolean
    onSaved: () => void | Promise<void>
}

export function WorkspaceNodeIdentityDefaults({
    wsId, identityProperty, nameProperty, canEdit, onSaved,
}: Props) {
    const { showToast } = useToast()
    // '' means "this workspace sets no default" — distinct from 'urn', which
    // would pin its sources to the platform default and stop them inheriting.
    const [identity, setIdentity] = useState(identityProperty ?? '')
    const [name, setName] = useState(nameProperty ?? '')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        setIdentity(identityProperty ?? '')
        setName(nameProperty ?? '')
    }, [identityProperty, nameProperty, wsId])

    const dirty = identity.trim() !== (identityProperty ?? '')
        || name.trim() !== (nameProperty ?? '')

    const handleSave = async () => {
        setSaving(true)
        try {
            // Sent even when blank: '' is how the workspace default is CLEARED,
            // which the API stores as NULL so sources fall through again.
            await workspaceService.update(wsId, {
                identityProperty: identity.trim(),
                nameProperty: name.trim(),
            })
            await onSaved()
            showToast('success', 'Workspace defaults saved')
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : 'Could not save defaults')
        } finally {
            setSaving(false)
        }
    }

    const handleDiscard = () => {
        setIdentity(identityProperty ?? '')
        setName(nameProperty ?? '')
    }

    return (
        <div className="mb-4">
            <NodeIdentityField
                scope="workspace"
                canEdit={canEdit}
                value={identity}
                onChange={setIdentity}
                nameValue={name}
                onNameChange={setName}
                defaultOpen={
                    normalizeIdentity(identityProperty) !== 'urn'
                    || normalizeName(nameProperty) !== 'name'
                }
            />
            {dirty && canEdit && (
                <div className="flex items-center justify-end gap-2 mt-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20">
                    <button
                        onClick={handleDiscard}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        <RotateCcw className="w-3 h-3" /> Discard
                    </button>
                    <button
                        onClick={() => void handleSave()}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
                    >
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                        {saving ? 'Saving…' : 'Save Defaults'}
                    </button>
                </div>
            )}
        </div>
    )
}
