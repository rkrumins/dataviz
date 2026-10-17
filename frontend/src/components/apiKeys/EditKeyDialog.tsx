/**
 * Renaming a key, or saying what it is for. Only what changed is sent.
 *
 * What a key may do, where from and until when stay as they were made: a
 * change there is a different credential, so it is a rotation or a new key —
 * said here, where someone would come looking for it.
 */
import { useState } from 'react'
import { Info, Pencil, ShieldAlert } from 'lucide-react'

import { BigInput, BigTextarea, FieldLabel, Hint } from '@/components/admin/InviteWizard/ui'
import { Button } from '@/components/ui/Button'
import { ApiKeyError, apiKeyService, type ApiKey, type UpdateApiKeyBody } from '@/services/apiKeyService'
import { KeyDialog } from './KeyDialog'

export function EditKeyDialog({ apiKey, onClose, onSaved }: {
    apiKey: ApiKey
    onClose: () => void
    onSaved: (key: ApiKey) => void
}) {
    const [name, setName] = useState(apiKey.name)
    const [description, setDescription] = useState(apiKey.description ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const body: UpdateApiKeyBody = {}
    if (name.trim() !== apiKey.name) body.name = name.trim()
    if (description.trim() !== (apiKey.description ?? '')) body.description = description.trim() || null
    const changed = Object.keys(body).length > 0

    async function save() {
        setBusy(true)
        setError(null)
        try {
            onSaved(await apiKeyService.update(apiKey.id, body))
        } catch (err) {
            setError(err instanceof ApiKeyError && err.status === 409
                ? 'This key has been revoked, so it can no longer be changed.'
                : err instanceof Error ? err.message : 'The key could not be saved.')
            setBusy(false)
        }
    }

    return (
        <KeyDialog
            icon={Pencil}
            title={`Edit “${apiKey.name}”`}
            subtitle="Its name and what it is for."
            onClose={() => { if (!busy) onClose() }}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="primary" loading={busy} disabled={!changed || !name.trim()} onClick={() => void save()}>
                        Save
                    </Button>
                </>
            )}
        >
            <div className="space-y-5">
                <div>
                    <FieldLabel required>Name</FieldLabel>
                    <BigInput aria-label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                    <FieldLabel>Description</FieldLabel>
                    <BigTextarea
                        aria-label="Description"
                        rows={3}
                        maxLength={500}
                        value={description}
                        placeholder="What it does, where it runs, and who to ask about it"
                        onChange={(e) => setDescription(e.target.value)}
                        className="font-sans"
                    />
                    <Hint>{description.length} / 500</Hint>
                </div>
                <p className="flex items-start gap-2 p-3 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] text-xs text-ink-secondary leading-relaxed">
                    <Info className="w-4 h-4 mt-px shrink-0 text-ink-muted" aria-hidden />
                    What it may do, where from and until when can’t be changed. Rotate it, or make a new key.
                </p>
                {error && (
                    <p role="alert" className="flex items-start gap-2 p-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] text-sm text-rose-700 dark:text-rose-300">
                        <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
                        {error}
                    </p>
                )}
            </div>
        </KeyDialog>
    )
}
