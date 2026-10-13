/**
 * An administrator ending a key — or every key one person holds — with a note
 * to its owner.
 *
 * The note is shown to the owner on the key and in the notification they get,
 * so "why" reaches the person who has to fix the script. Revoking everything
 * of someone's is the bigger hammer, used when an account is suspected rather
 * than one key: it asks for their address typed out, so it is never a slip
 * of the wrong button.
 */
import { useState } from 'react'
import { KeyRound, ShieldAlert, Trash2, Users } from 'lucide-react'

import { BigInput, BigTextarea, FieldLabel, Hint } from '@/components/admin/InviteWizard/ui'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { apiKeyService, type AdminApiKey } from '@/services/apiKeyService'
import { KeyDialog } from './KeyDialog'

const NOTE_MAX = 500

export function RevokeKeyDialog({ apiKey, initialScope = 'one', onClose, onRevoked }: {
    apiKey: AdminApiKey
    initialScope?: 'one' | 'all'
    onClose: () => void
    onRevoked: (result: { scope: 'one' | 'all'; revoked: number }) => void
}) {
    const ended = apiKey.status === 'revoked'
    const [scope, setScope] = useState<'one' | 'all'>(ended ? 'all' : initialScope)
    const [note, setNote] = useState('')
    const [typed, setTyped] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const owner = apiKey.owner
    const confirmed = scope === 'one' || typed.trim().toLowerCase() === owner.email.toLowerCase()

    async function revoke() {
        setBusy(true)
        setError(null)
        try {
            if (scope === 'one') {
                await apiKeyService.adminRevoke(apiKey.id, note)
                onRevoked({ scope, revoked: 1 })
            } else {
                const { revoked } = await apiKeyService.adminRevokeAll(owner.id, note)
                onRevoked({ scope, revoked })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Nothing was revoked.')
            setBusy(false)
        }
    }

    return (
        <KeyDialog
            icon={Trash2}
            tone="danger"
            title={scope === 'one' ? `Revoke “${apiKey.name}”?` : `Revoke all of ${owner.displayName}’s keys?`}
            subtitle="It stops working at once, and can’t be brought back."
            onClose={() => { if (!busy) onClose() }}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="danger" leftIcon={Trash2} loading={busy} disabled={!confirmed} onClick={() => void revoke()}>
                        {scope === 'one' ? 'Revoke key' : 'Revoke all their keys'}
                    </Button>
                </>
            )}
        >
            <div className="space-y-5">
                <div role="radiogroup" aria-label="What to revoke" className="grid gap-2 sm:grid-cols-2">
                    <ScopeCard
                        on={scope === 'one'}
                        disabled={ended}
                        icon={KeyRound}
                        title="Just this key"
                        sub={`${apiKey.name} · ${apiKey.prefix}…`}
                        onClick={() => setScope('one')}
                    />
                    <ScopeCard
                        on={scope === 'all'}
                        icon={Users}
                        title="Every key they hold"
                        sub={`${owner.displayName} · ${owner.email}`}
                        onClick={() => setScope('all')}
                    />
                </div>

                <div>
                    <FieldLabel hint="optional">Note to {owner.displayName}</FieldLabel>
                    <BigTextarea
                        aria-label="Note to the owner"
                        rows={3}
                        maxLength={NOTE_MAX}
                        value={note}
                        placeholder="Why — for example, “It was pasted in a public CI log. Make a new one limited to the build’s network.”"
                        onChange={(e) => setNote(e.target.value)}
                        className="font-sans"
                    />
                    <Hint>
                        They see it on the key and in the notification they get. {note.length} / {NOTE_MAX}
                    </Hint>
                </div>

                {scope === 'all' && (
                    <div className="p-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.05]">
                        <p className="text-xs text-ink-secondary leading-relaxed mb-3">
                            Every script and service that acts as {owner.displayName} stops at once. To confirm,
                            type <span className="font-mono font-semibold text-ink select-all">{owner.email}</span>.
                        </p>
                        <BigInput
                            aria-label="Their email address"
                            value={typed}
                            autoComplete="off"
                            state={confirmed ? 'valid' : typed.length >= owner.email.length ? 'invalid' : 'idle'}
                            onChange={(e) => setTyped(e.target.value)}
                        />
                    </div>
                )}

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

function ScopeCard({ on, disabled, icon: Icon, title, sub, onClick }: {
    on: boolean
    disabled?: boolean
    icon: typeof Users
    title: string
    sub: string
    onClick: () => void
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
                on ? 'border-rose-500 bg-rose-500/[0.06]' : 'border-black/[0.10] dark:border-white/[0.12] hover:border-rose-500/40',
            )}
        >
            <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', on ? 'text-rose-500' : 'text-ink-muted')} aria-hidden />
            <span className="min-w-0">
                <span className={cn('block text-sm font-semibold', on ? 'text-rose-700 dark:text-rose-300' : 'text-ink')}>{title}</span>
                {' '}
                <span className="block text-[11px] text-ink-muted truncate">{sub}</span>
            </span>
        </button>
    )
}
