/**
 * Deleting a connection.
 *
 * Deliberately not reusing `DeleteProviderDialog` — that one is typed to
 * `ProviderResponse` from `providerService`, which is a *data source*, not
 * an IdP. Same word, different concept.
 *
 * Type-to-confirm rather than the `confirm()` the list used: a browser
 * confirm is one keystroke away from destroying a connection that hundreds
 * of people sign in through, and it renders behind the drawer besides.
 *
 * The server refuses while identities are still linked, so the honest
 * framing is "this may well be refused" rather than a warning implying it
 * will silently cascade.
 */
import { useState } from 'react'
import { AlertCircle, Loader2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ssoAdminService, type IdpProvider } from '@/services/ssoAdminService'
import { useAppNotifications } from '@/components/ui/notifications'
import { SectionHeader } from './SectionHeader'

export function DangerSection({
    provider, onDeleted,
}: {
    provider: IdpProvider
    onDeleted: () => void
}) {
    const [typed, setTyped] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { notify } = useAppNotifications()

    const armed = typed.trim() === provider.slug

    async function remove() {
        setBusy(true)
        setError(null)
        try {
            await ssoAdminService.deleteProvider(provider.id)
            notify('success', `Deleted ${provider.slug}`)
            onDeleted()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="space-y-5 max-w-2xl">
            <SectionHeader title="Danger zone">
                Removing this connection deletes its configuration, including
                any secrets it holds. It cannot be undone.
            </SectionHeader>

            <div className="rounded-xl border-2 border-red-500/40 bg-red-500/[0.05] p-4 space-y-3">
                <div>
                    <h4 className="text-sm font-semibold text-ink">
                        Delete this connection
                    </h4>
                    <p className="mt-1 text-xs text-ink-muted leading-relaxed">
                        Anyone who signs in through it loses that route
                        immediately. If people still have identities linked to
                        it, the delete is refused — they have to unlink first,
                        so nobody is stranded without an account.
                    </p>
                    {provider.lifecycle !== 'draft' && (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                            This connection is live. Consider switching it off
                            first and watching for fallout.
                        </p>
                    )}
                </div>

                <label className="block">
                    <span className="block text-xs font-semibold text-ink mb-1.5">
                        Type <code className="font-mono text-red-500">{provider.slug}</code> to confirm
                    </span>
                    <input
                        value={typed}
                        onChange={e => setTyped(e.target.value)}
                        aria-label="Type the slug to confirm deletion"
                        placeholder={provider.slug}
                        className="w-full px-3 py-2 text-xs font-mono rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated text-ink outline-none focus:border-red-500 focus:ring-4 focus:ring-red-500/10"
                    />
                </label>

                {error && (
                    <p className="flex items-start gap-1.5 text-xs text-red-500">
                        <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                        {error}
                    </p>
                )}

                <button
                    type="button"
                    disabled={!armed || busy}
                    onClick={() => { void remove() }}
                    className={cn(
                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors duration-150',
                        armed && !busy
                            ? 'bg-red-500 text-white hover:bg-red-600'
                            : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                    )}
                >
                    {busy
                        ? <><Loader2 className="w-4 h-4 animate-spin" />Deleting…</>
                        : <><Trash2 className="w-4 h-4" />Delete connection</>}
                </button>
            </div>
        </div>
    )
}
