/**
 * Creating a service account for one of your integrations, where the policy
 * lets you: a name, what it is for, and who manages it — you, or a team
 * you're in, which keeps it managed as people come and go. It holds no
 * access until a workspace gives it some, which its page asks for next.
 */
import { useState } from 'react'
import { Bot, Plus } from 'lucide-react'

import { KeyDialog } from '@/components/apiKeys/KeyDialog'
import { Button } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { cn } from '@/lib/utils'
import {
    serviceAccountService, type MyCreation, type ServiceAccountDetail,
} from '@/services/serviceAccountService'

const FIELD = 'w-full rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

export function CreateServiceAccountDialog({ allowance, onClose, onCreated }: {
    allowance: MyCreation
    onClose: () => void
    onCreated: (account: ServiceAccountDetail) => void
}) {
    const { notify } = useAppNotifications()
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const teamOnly = allowance.requireTeamManager
    const [team, setTeam] = useState<string>(teamOnly ? allowance.teams[0]?.id ?? '' : '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const ready = name.trim() !== '' && (!teamOnly || team !== '')

    async function create() {
        setBusy(true)
        setError(null)
        try {
            const created = await serviceAccountService.createMine({
                name: name.trim(), description: description.trim() || undefined, team: team || undefined,
            })
            notify('success', `“${created.name}” created — now ask a workspace for its access`)
            onCreated(created)
        } catch (err) {
            setError(err instanceof Error && err.message ? err.message : 'The service account could not be created.')
            setBusy(false)
        }
    }

    return (
        <KeyDialog
            icon={Bot}
            title="Create a service account"
            subtitle="For one integration, so it keeps running whoever set it up."
            onClose={onClose}
            footer={(
                <>
                    <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" size="sm" leftIcon={Plus} disabled={!ready} loading={busy} onClick={() => void create()}>
                        Create
                    </Button>
                </>
            )}
        >
            <div className="space-y-4">
                <div>
                    <label htmlFor="mine-name" className="block text-xs font-semibold text-ink-secondary mb-1.5">Name</label>
                    <input
                        id="mine-name"
                        value={name}
                        maxLength={80}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Metadata sync"
                        className={cn(FIELD, 'h-9 px-3')}
                    />
                </div>
                <div>
                    <label htmlFor="mine-description" className="block text-xs font-semibold text-ink-secondary mb-1.5">What it is for</label>
                    <textarea
                        id="mine-description"
                        value={description}
                        maxLength={500}
                        rows={2}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Which integration runs as it, and where"
                        className={cn(FIELD, 'px-3 py-2 resize-none')}
                    />
                </div>
                <fieldset>
                    <legend className="text-xs font-semibold text-ink-secondary mb-1.5">Managed by</legend>
                    {teamOnly ? (
                        <p className="text-xs text-ink-muted mb-2">
                            A team you’re in manages each account you create, so it outlives any one person.
                        </p>
                    ) : (
                        <label className="flex items-center gap-2 text-sm text-ink mb-1.5">
                            <input type="radio" name="managed-by" checked={team === ''} onChange={() => setTeam('')} />
                            You
                        </label>
                    )}
                    {allowance.teams.length === 0 ? (
                        teamOnly && (
                            <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
                                You’re in no team. Ask to join one, or ask an administrator of service accounts to create it.
                            </p>
                        )
                    ) : (
                        <label className="flex items-center gap-2 text-sm text-ink">
                            {!teamOnly && (
                                <input
                                    type="radio"
                                    name="managed-by"
                                    checked={team !== ''}
                                    onChange={() => setTeam(allowance.teams[0].id)}
                                />
                            )}
                            <span className="shrink-0">A team you’re in</span>
                            <select
                                aria-label="Team"
                                value={team}
                                onChange={(e) => setTeam(e.target.value)}
                                disabled={!teamOnly && team === ''}
                                className={cn(FIELD, 'h-9 px-2.5 min-w-0 flex-1 disabled:opacity-50')}
                            >
                                {!teamOnly && team === '' && <option value="">Choose a team</option>}
                                {allowance.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </label>
                    )}
                    {team !== '' && (
                        <p className="mt-2 text-xs text-ink-muted">
                            Anyone in {allowance.teams.find((t) => t.id === team)?.name} can make keys that act as it.
                        </p>
                    )}
                </fieldset>
                <p className="text-xs text-ink-muted">
                    It reaches nothing until a workspace gives it a role: ask on its page, next.
                    {allowance.limited && <> You have created {allowance.created} of the {allowance.perPersonLimit} you may.</>}
                </p>
                {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
            </div>
        </KeyDialog>
    )
}
