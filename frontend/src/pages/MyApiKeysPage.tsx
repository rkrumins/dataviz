/**
 * MyApiKeysPage — keys that let scripts and services act as you.
 *
 * Each key does what you could do yourself, limited further to what you chose
 * when you made it: some workspaces, views or data sources, and read or write.
 * The page answers the questions a person has about a key they may have
 * forgotten: what it can reach, when it was last used and from where, when it
 * stops working — and lets them end it at once.
 *
 * It leads with what needs doing: keys paused until you sign in again, an
 * expired key something still calls, a key about to expire. Someone with no
 * keys yet gets what a key is, in three promises, instead of an empty list.
 *
 * Revoking is always available, even with API keys switched off for the
 * deployment: closing a credential must never depend on being allowed to
 * open one.
 */
import { useCallback, useEffect, useState } from 'react'
import {
    AlertCircle, BookOpen, Clock, Code2, Eye, History, KeySquare, LogIn, PauseCircle, Pencil,
    Plus, RefreshCw, RotateCw, ShieldAlert, ShieldCheck, Sparkles, Trash2, TriangleAlert,
} from 'lucide-react'

import { AccountCard, AccountShell, useAccountIdentity } from '@/components/account/AccountShell'
import { EditKeyDialog } from '@/components/apiKeys/EditKeyDialog'
import { KeyCard, PastKeyRow } from '@/components/apiKeys/KeyCard'
import { KeyDetailDrawer } from '@/components/apiKeys/KeyDetailDrawer'
import { RotateKeyDialog } from '@/components/apiKeys/RotateKeyDialog'
import { STEP_UP_UNAVAILABLE } from '@/components/apiKeys/StepUpField'
import { clearDraft, peekDraft, type ApiKeyDraft } from '@/components/apiKeys/apiKeyDraft'
import { expiryCountdown, isLive, isRenewable, stillCalled } from '@/components/apiKeys/apiKeyFormat'
import { ApiKeyWizard } from '@/components/apiKeys/wizard/ApiKeyWizard'
import { Button, IconButton } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { cn } from '@/lib/utils'
import { apiKeyService, type ApiKey, type ApiKeyOptions, type KeyRef } from '@/services/apiKeyService'
import { useFeature } from '@/store/features'

export function MyApiKeysPage() {
    useDocumentTitle('API keys')
    return (
        <AccountShell
            title="API keys"
            blurb="Keys that let scripts and services act as you, limited to what you choose."
        >
            <ApiKeysContent />
        </AccountShell>
    )
}

function ApiKeysContent() {
    const { notify } = useAppNotifications()
    const keysEnabled = useFeature('apiKeysEnabled')
    // Paused keys resume through the provider the owner signs in with — by
    // name, when there is only the one.
    const { identities } = useAccountIdentity()
    const provider = identities.length === 1 ? identities[0].provider.displayName : 'your identity provider'
    const [keys, setKeys] = useState<ApiKey[] | null>(null)
    const [options, setOptions] = useState<ApiKeyOptions | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [olderHistory, setOlderHistory] = useState(false)
    const [version, setVersion] = useState(0)
    const reload = useCallback(() => setVersion((v) => v + 1), [])

    // Back from confirming with an identity provider: what was chosen before
    // leaving, read once at mount and cleared at once — it is used once.
    const [parked] = useState(() => peekDraft())
    useEffect(() => { if (parked) clearDraft() }, [parked])

    // A fresh wizard per opening (`seq` is its key), so it starts from what it is opened with.
    const [wizard, setWizard] = useState<{ seq: number; resumed: ApiKeyDraft | null } | null>(
        () => (parked?.mode === 'create' ? { seq: 0, resumed: parked } : null),
    )
    const [rotating, setRotating] = useState<{ keyId: string; resumed: ApiKeyDraft | null } | null>(
        () => (parked && parked.mode !== 'create' && parked.keyId ? { keyId: parked.keyId, resumed: parked } : null),
    )
    const [editing, setEditing] = useState<ApiKey | null>(null)
    const [drawerKey, setDrawerKey] = useState<ApiKey | null>(null)
    const closeDrawer = useCallback(() => setDrawerKey(null), [])

    useEffect(() => {
        let live = true
        Promise.all([apiKeyService.list(olderHistory ? 'all' : undefined), apiKeyService.options()])
            .then(([list, opts]) => {
                if (!live) return
                setKeys(list)
                setOptions(opts)
                setError(null)
            })
            .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'Your keys could not be loaded.') })
        return () => { live = false }
    }, [version, olderHistory])

    const liveKeys = keys?.filter(isLive) ?? []
    const past = keys?.filter((k) => !isLive(k)) ?? []
    // Minting needs keys switched on, by the flag the shell reads and by the
    // server's own answer, and a sign-in that can confirm it is you. A
    // rotation replaces a key, so it does not count against the limit.
    const mintable = keysEnabled && (options?.policy.enabled ?? false) && (options?.stepUpAvailable ?? false)
    const max = options?.policy.maxActiveKeys ?? Infinity
    const canCreate = mintable && liveKeys.length < max

    const now = new Date()
    const paused = liveKeys.filter((k) => k.status === 'paused')
    const expiringSoon = liveKeys
        .filter((k) => k.status === 'active' && ['soon', 'urgent'].includes(expiryCountdown(k.expiresAt, now).tone))
        .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))
    const calledAfterExpiry = past.filter((k) => stillCalled(k) > 0)
    const requestsToday = (keys ?? []).reduce((n, k) => n + (k.usage.daily14[k.usage.daily14.length - 1] ?? 0), 0)
    const rotateKey = rotating ? keys?.find((k) => k.id === rotating.keyId) : undefined

    const openRotate = (key: ApiKey) => setRotating({ keyId: key.id, resumed: null })

    // What needs doing, most pressing first: keys that do not work until you
    // sign in, an expired key whose callers are failing now, then a key about
    // to stop.
    const attention: { id: string; icon: typeof Clock; tone: string; title: string; body: string; action?: React.ReactNode }[] = [
        ...(paused.length > 0 ? [{
            id: 'paused',
            icon: PauseCircle,
            tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
            title: paused.length === 1 ? `“${paused[0].name}” is paused` : `${paused.length} of your keys are paused`,
            body: `Paused until you sign in through ${provider} again — nothing was revoked. Keys that act as you pause after ${options?.policy.ssoSignInWindowDays ? `${options.policy.ssoSignInWindowDays} days` : 'a while'} without a sign-in there.`,
            action: options?.ssoSignInUrl ? (
                <a href={options.ssoSignInUrl} className={ACTION}>
                    <LogIn className="w-3.5 h-3.5" aria-hidden /> Sign in to resume
                </a>
            ) : undefined,
        }] : []),
        ...calledAfterExpiry.map((k) => ({
            id: `called-${k.id}`,
            icon: TriangleAlert,
            tone: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
            title: `“${k.name}” expired, but something still calls it`,
            body: `${stillCalled(k).toLocaleString()} requests in the last 7 days were refused. Renew it to give whatever calls it a working key.`,
            action: mintable ? (
                <button type="button" onClick={() => openRotate(k)} className={ACTION}>
                    <RotateCw className="w-3.5 h-3.5" aria-hidden /> Renew
                </button>
            ) : undefined,
        })),
        ...(expiringSoon.length > 0 ? [{
            id: 'expiring',
            icon: Clock,
            tone: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
            title: expiringSoon.length === 1
                ? `“${expiringSoon[0].name}” ${expiryCountdown(expiringSoon[0].expiresAt, now).label.toLowerCase()}`
                : `${expiringSoon.length} keys expire within 7 days`,
            body: expiringSoon.length === 1
                ? 'Rotate it and swap the new key in — the old one can keep working for up to a week while you do.'
                : 'Rotate each and swap the new keys in — the old ones can keep working for up to a week while you do.',
            action: mintable ? (
                <button type="button" onClick={() => openRotate(expiringSoon[0])} className={ACTION}>
                    <RotateCw className="w-3.5 h-3.5" aria-hidden /> Rotate{expiringSoon.length > 1 ? ` “${expiringSoon[0].name}”` : ''}
                </button>
            ) : undefined,
        }] : []),
    ]

    async function revoke(key: ApiKey) {
        try {
            await apiKeyService.revoke(key.id)
            notify('success', `“${key.name}” revoked — it stopped working just now`)
            if (drawerKey?.id === key.id) setDrawerKey(null)
            reload()
        } catch (err) {
            notify('error', (err as Error).message)
        }
    }

    const openKey = useCallback((ref: KeyRef) => {
        const known = keys?.find((k) => k.id === ref.id)
        if (known) setDrawerKey(known)
        else apiKeyService.get(ref.id).then(setDrawerKey).catch(() => notify('error', 'That key could not be loaded.'))
    }, [keys, notify])

    const firstRun = keys !== null && keys.length === 0 && !olderHistory

    return (
        <>
            {error && (
                <Banner tone="danger" icon={AlertCircle} title="Your keys could not be loaded">{error}</Banner>
            )}
            {options && !options.policy.enabled && (
                <Banner tone="warn" icon={AlertCircle} title="API keys are switched off">
                    API keys are turned off for this deployment: none of them work, and new ones
                    cannot be made. You can still revoke yours.
                </Banner>
            )}
            {options?.policy.enabled && !options.stepUpAvailable && (
                <Banner tone="warn" icon={ShieldAlert} title="This sign-in can’t confirm it’s you">
                    {STEP_UP_UNAVAILABLE}
                </Banner>
            )}

            {firstRun ? (
                <FirstRun canCreate={canCreate} onCreate={() => setWizard({ seq: Date.now(), resumed: null })} />
            ) : (
                <>
                    {keys !== null && options && (
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            <Stat label="Keys in use" value={`${liveKeys.length}`} suffix={`/ ${options.policy.maxActiveKeys}`}>
                                <ProgressBar value={(liveKeys.length / options.policy.maxActiveKeys) * 100} className="mt-2.5" label="Keys in use" />
                            </Stat>
                            <Stat label="Expiring within 7 days" value={`${expiringSoon.length}`} tone={expiringSoon.length > 0 ? 'warn' : undefined} />
                            <Stat label="Paused" value={`${paused.length}`} tone={paused.length > 0 ? 'warn' : undefined} />
                            <Stat label="Requests today" value={requestsToday.toLocaleString()} />
                        </div>
                    )}

                    {attention.length > 0 && (
                        <section aria-label="Needs your attention" className="rounded-2xl border border-amber-500/25 bg-canvas-elevated overflow-hidden">
                            <header className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-amber-500/20 bg-amber-500/[0.06]">
                                <TriangleAlert className="w-4 h-4 text-amber-500" aria-hidden />
                                <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-200">Needs your attention</h2>
                                <span className="ml-auto px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                    {attention.length}
                                </span>
                            </header>
                            <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.07]">
                                {attention.map((a) => (
                                    <li key={a.id} className="flex flex-wrap sm:flex-nowrap items-start gap-3 px-4 sm:px-5 py-3.5">
                                        <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', a.tone)}>
                                            <a.icon className="w-4 h-4" aria-hidden />
                                        </span>
                                        <div className="min-w-0 flex-1 basis-[13rem]">
                                            <p className="text-sm font-semibold text-ink">{a.title}</p>
                                            <p className="mt-0.5 text-xs text-ink-secondary leading-relaxed">{a.body}</p>
                                        </div>
                                        {a.action && <div className="shrink-0 self-center ml-11 sm:ml-0">{a.action}</div>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    <AccountCard
                        icon={KeySquare}
                        title="Your keys"
                        blurb="Send one as a bearer token in the Authorization header. It acts as you, never more."
                    >
                        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                            <code className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] text-[11px] font-mono text-ink-secondary">
                                <Code2 className="w-3.5 h-3.5 text-ink-muted" aria-hidden />
                                Authorization: Bearer nxpat_…
                            </code>
                            <div className="flex items-center gap-2 ml-auto">
                                <IconButton icon={RefreshCw} label="Refresh" detail="Read your keys again" onClick={reload} />
                                <HoverTip
                                    label={canCreate ? 'Make a key for a script or service' : 'You can’t make a key right now'}
                                    detail={!canCreate && mintable ? `You have ${liveKeys.length} of the ${options?.policy.maxActiveKeys} keys allowed. Revoke one first.` : undefined}
                                >
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        leftIcon={Plus}
                                        disabled={!canCreate}
                                        onClick={() => setWizard({ seq: Date.now(), resumed: null })}
                                    >
                                        Create key
                                    </Button>
                                </HoverTip>
                            </div>
                        </div>

                        {keys === null ? (
                            <div className="space-y-3" aria-busy="true">
                                {[0, 1].map((i) => (
                                    <div key={i} className="h-40 rounded-2xl bg-black/[0.04] dark:bg-white/[0.05] animate-pulse motion-reduce:animate-none" />
                                ))}
                            </div>
                        ) : liveKeys.length === 0 ? (
                            <div className="flex flex-col items-center text-center py-8 px-4">
                                <span className="w-11 h-11 rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center mb-3">
                                    <KeySquare className="w-5 h-5 text-ink-muted" aria-hidden />
                                </span>
                                <p className="text-sm font-semibold text-ink">No live keys</p>
                                <p className="mt-1 text-xs text-ink-muted max-w-sm">
                                    Create one for a script or service that needs to read or change views and data as you.
                                </p>
                            </div>
                        ) : (
                            <ul className="space-y-3">
                                {liveKeys.map((key) => (
                                    <KeyCard
                                        key={key.id}
                                        apiKey={key}
                                        resume={{ url: options?.ssoSignInUrl ?? null, provider }}
                                        onOpen={() => setDrawerKey(key)}
                                        onRotate={mintable ? () => openRotate(key) : undefined}
                                        onEdit={() => setEditing(key)}
                                        onRevoke={() => void revoke(key)}
                                    />
                                ))}
                            </ul>
                        )}
                    </AccountCard>

                    {past.length > 0 && (
                        <AccountCard
                            icon={History}
                            title="Expired and revoked"
                            blurb={`${past.length} key${past.length === 1 ? '' : 's'} · ${olderHistory ? 'Every key that has ended.' : 'Kept here for 90 days after they end.'} None of these work any more.`}
                        >
                            <ul className="space-y-2">
                                {past.map((key) => (
                                    <PastKeyRow
                                        key={key.id}
                                        apiKey={key}
                                        onOpen={() => setDrawerKey(key)}
                                        onRenew={mintable && isRenewable(key) ? () => openRotate(key) : undefined}
                                    />
                                ))}
                            </ul>
                            {!olderHistory && (
                                <div className="mt-3 flex justify-center">
                                    <Button variant="ghost" size="sm" leftIcon={History} onClick={() => setOlderHistory(true)}>
                                        Show older history
                                    </Button>
                                </div>
                            )}
                        </AccountCard>
                    )}
                </>
            )}

            <div className="flex flex-col items-start gap-2 px-1">
                <p className="flex items-start gap-2 text-xs text-ink-muted max-w-2xl">
                    <ShieldCheck className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                    <span>
                        Signing out everywhere or changing your password does not stop your keys. If one may
                        have leaked, revoke it here.
                    </span>
                </p>
                {keys !== null && past.length === 0 && !olderHistory && (
                    <Button variant="ghost" size="sm" leftIcon={History} onClick={() => setOlderHistory(true)}>
                        Show older history
                    </Button>
                )}
            </div>

            {wizard && options && (
                <ApiKeyWizard
                    key={wizard.seq}
                    options={options}
                    resumed={wizard.resumed}
                    onClose={() => setWizard(null)}
                    onCreated={reload}
                />
            )}
            {rotateKey && options && (
                <RotateKeyDialog
                    apiKey={rotateKey}
                    options={options}
                    resumed={rotating?.resumed}
                    onClose={() => setRotating(null)}
                    onDone={reload}
                />
            )}
            {editing && (
                <EditKeyDialog
                    apiKey={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(saved) => {
                        setKeys((ks) => ks?.map((k) => (k.id === saved.id ? saved : k)) ?? ks)
                        setDrawerKey((d) => (d?.id === saved.id ? saved : d))
                        setEditing(null)
                        notify('success', `“${saved.name}” saved`)
                    }}
                />
            )}
            <KeyDetailDrawer
                apiKey={drawerKey}
                variant="owner"
                load={apiKeyService.get}
                layered={editing !== null || rotateKey !== undefined}
                onClose={closeDrawer}
                onOpenKey={openKey}
                actions={drawerKey && (
                    <DrawerActions
                        key={drawerKey.id}
                        apiKey={drawerKey}
                        resumeUrl={drawerKey.status === 'paused' ? options?.ssoSignInUrl ?? null : null}
                        onRotate={mintable && (isLive(drawerKey) || isRenewable(drawerKey)) ? () => openRotate(drawerKey) : undefined}
                        onEdit={drawerKey.status !== 'revoked' ? () => setEditing(drawerKey) : undefined}
                        onRevoke={isLive(drawerKey) ? () => void revoke(drawerKey) : undefined}
                    />
                )}
            />
        </>
    )
}

const ACTION = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-canvas-elevated text-ink border border-black/[0.08] dark:border-white/[0.10] hover:bg-black/[0.03] dark:hover:bg-white/[0.06] shadow-sm transition-colors whitespace-nowrap'

const BANNER_TONE = {
    danger: { box: 'border-rose-500/25 bg-rose-500/[0.06]', icon: 'bg-rose-500/15 text-rose-600 dark:text-rose-400', title: 'text-rose-700 dark:text-rose-300' },
    warn: { box: 'border-amber-500/30 bg-amber-500/[0.07]', icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', title: 'text-amber-800 dark:text-amber-200' },
}

/** Something about the deployment, or this page, that holds for every key. */
function Banner({ tone, icon: Icon, title, children }: {
    tone: keyof typeof BANNER_TONE
    icon: typeof Clock
    title: string
    children: React.ReactNode
}) {
    const t = BANNER_TONE[tone]
    return (
        <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-3 p-4 rounded-2xl border', t.box)}>
            <span className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', t.icon)}>
                <Icon className="w-[18px] h-[18px]" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-semibold', t.title)}>{title}</p>
                <p className="mt-0.5 text-xs text-ink-secondary leading-relaxed">{children}</p>
            </div>
        </div>
    )
}

function Stat({ label, value, suffix, tone, children }: {
    label: string
    value: string
    suffix?: string
    tone?: 'warn'
    children?: React.ReactNode
}) {
    return (
        <div className={cn(
            'rounded-2xl border p-4',
            tone === 'warn' ? 'border-amber-500/25 bg-amber-500/[0.05]' : 'border-glass-border bg-canvas-elevated',
        )}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
            <p className={cn('mt-1.5 text-2xl font-bold tabular-nums', tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-ink')}>
                {value}
                {suffix && <span className="ml-1 text-sm font-semibold text-ink-muted">{suffix}</span>}
            </p>
            {children}
        </div>
    )
}

/** What a key is, before there is one. */
function FirstRun({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
    const promises = [
        { icon: Eye, title: 'Only what you choose', body: 'Pick views, data sources or workspaces, and read or write. A key never reaches past what you can do.' },
        { icon: Sparkles, title: 'Shown once, kept safe', body: 'You copy it into your secrets manager when it is made. We keep only a fingerprint, so nobody can read it back.' },
        { icon: ShieldCheck, title: 'Yours to stop', body: 'See when and where each key is used, rotate it without downtime, and revoke it in one click.' },
    ]
    return (
        <section aria-label="Your keys" className="relative overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
            <div aria-hidden className="absolute inset-0 bg-gradient-to-br from-indigo-500/[0.08] via-violet-500/[0.04] to-transparent pointer-events-none" />
            <div className="relative px-6 py-10 sm:px-10 sm:py-12">
                <div className="max-w-xl">
                    <span className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25">
                        <KeySquare className="w-7 h-7" aria-hidden />
                    </span>
                    <h2 className="mt-5 text-2xl font-bold text-ink">Let scripts and services work as you</h2>
                    <p className="mt-2 text-sm text-ink-secondary leading-relaxed">
                        An API key lets a pipeline, a notebook or a CI job call the platform without your password —
                        limited to exactly what that job needs.
                    </p>
                </div>
                <ul className="mt-8 grid gap-4 sm:grid-cols-3">
                    {promises.map(({ icon: Icon, title, body }) => (
                        <li key={title} className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] bg-canvas-elevated p-4">
                            <span className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                                <Icon className="w-4 h-4" aria-hidden />
                            </span>
                            <p className="mt-3 text-sm font-semibold text-ink">{title}</p>
                            <p className="mt-1 text-xs text-ink-muted leading-relaxed">{body}</p>
                        </li>
                    ))}
                </ul>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        onClick={onCreate}
                        disabled={!canCreate}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 shadow-md shadow-indigo-500/25 hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Plus className="w-4 h-4" aria-hidden />
                        Create your first key
                    </button>
                    <a href="/guide/api-keys" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                        <BookOpen className="w-4 h-4" aria-hidden /> How keys work
                    </a>
                    <a href="/docs/api-guide" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                        <Code2 className="w-4 h-4" aria-hidden /> Calling the API
                    </a>
                </div>
            </div>
        </section>
    )
}

/** The drawer's footer: the same choices as the card, revoking asked once in place. */
function DrawerActions({ apiKey, resumeUrl, onRotate, onEdit, onRevoke }: {
    apiKey: ApiKey
    /** A paused key's way back: signing in again. */
    resumeUrl: string | null
    onRotate?: () => void
    onEdit?: () => void
    onRevoke?: () => void
}) {
    const [confirming, setConfirming] = useState(false)
    if (confirming) {
        return (
            <>
                <span className="text-xs font-medium text-ink-secondary mr-auto">Stop “{apiKey.name}” now?</span>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
                <Button variant="danger" size="sm" onClick={() => { setConfirming(false); onRevoke?.() }}>Revoke</Button>
            </>
        )
    }
    return (
        <>
            {onRevoke && (
                <Button variant="ghost" size="sm" leftIcon={Trash2} onClick={() => setConfirming(true)} className="mr-auto hover:text-rose-600 dark:hover:text-rose-400">
                    Revoke
                </Button>
            )}
            {onEdit && (
                <Button variant="secondary" size="sm" leftIcon={Pencil} onClick={onEdit} className="border-black/[0.10] dark:border-white/[0.12] shadow-sm">
                    Edit
                </Button>
            )}
            {onRotate && (
                <Button
                    variant={resumeUrl ? 'secondary' : 'primary'}
                    size="sm"
                    leftIcon={RotateCw}
                    onClick={onRotate}
                    className={resumeUrl ? 'border-black/[0.10] dark:border-white/[0.12] shadow-sm' : undefined}
                >
                    {isRenewable(apiKey) ? 'Renew' : 'Rotate'}
                </Button>
            )}
            {resumeUrl && (
                <a
                    href={resumeUrl}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold text-white bg-accent-lineage shadow-sm shadow-accent-lineage/25 hover:brightness-110 transition whitespace-nowrap"
                >
                    <LogIn className="w-3.5 h-3.5" aria-hidden />
                    Sign in to resume
                </a>
            )}
        </>
    )
}
