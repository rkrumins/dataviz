/**
 * The one time a key can be seen.
 *
 * The token exists nowhere else, so this screen is built around not losing
 * it: hidden until asked (screens get shared), one button to copy it, a first
 * call to paste beside it, and Done only once you say it is stored — the
 * dialog around it asks before closing until then.
 *
 * "Waiting for the first call…" watches the key's own record (every 3 s, for
 * two minutes) and lights up when something has used it, with where from.
 * It never calls the API with the token: the browser is exactly where a key
 * should not be used from.
 */
import { useEffect, useState } from 'react'
import { Check, CheckCircle2, Copy, Eye, EyeOff, ShieldCheck } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { cn } from '@/lib/utils'
import type { CreatedApiKey } from '@/services/apiKeyService'
import { clientName, describePermissions, describeResources, expiryCountdown } from './apiKeyFormat'
import { useKeyClient } from './keyClient'
import { SNIPPETS, snippet } from './snippets'

const POLL_MS = 3000
const POLL_FOR_MS = 2 * 60 * 1000

type FirstCall =
    | { state: 'waiting' }
    | { state: 'seen'; ip: string | null; client: string | null }
    | { state: 'quiet' }

export function RevealPanel({ created, acknowledged, onAcknowledge }: {
    created: CreatedApiKey
    acknowledged: boolean
    onAcknowledge: (acknowledged: boolean) => void
}) {
    const [shown, setShown] = useState(false)
    const firstCall = useFirstCall(created.key.id)
    const { token, key } = created
    const origin = window.location.origin
    const masked = `${key.prefix}${'•'.repeat(Math.max(8, token.length - key.prefix.length))}`

    return (
        <div className="mx-auto max-w-2xl space-y-6">
            <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.08] via-emerald-500/[0.03] to-transparent p-5">
                <div className="flex items-start gap-3">
                    <span className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-5 h-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                        <p className="text-base font-bold text-ink">“{key.name}” is ready</p>
                        <p className="text-xs text-ink-secondary mt-0.5">
                            Copy it now and keep it in a secrets manager. It is not stored anywhere you
                            can see it again — if it is lost, rotate the key.
                        </p>
                    </div>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-xl border-2 border-emerald-500/30 bg-canvas-elevated p-1.5 pl-3">
                    <input
                        readOnly
                        value={shown ? token : masked}
                        onFocus={(e) => e.currentTarget.select()}
                        aria-label="Your new API key"
                        className="flex-1 min-w-0 bg-transparent font-mono text-sm text-ink outline-none truncate"
                    />
                    <button
                        type="button"
                        onClick={() => setShown(!shown)}
                        aria-label={shown ? 'Hide the key' : 'Show the key'}
                        className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                    >
                        {shown ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <CopyAction
                        text={token}
                        label="Copy the key"
                        className="h-9 px-3.5 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 hover:text-white"
                    >
                        Copy
                    </CopyAction>
                </div>
                <p className="mt-3 text-[11px] text-ink-muted">
                    {describePermissions(key.permissions)} on {describeResources(key.resources).toLowerCase()}
                    {' · '}{expiryCountdown(key.expiresAt).label.toLowerCase()}
                </p>
            </div>

            <div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 mb-2">
                    <p className="text-sm font-semibold text-ink whitespace-nowrap">Make a first call</p>
                    <FirstCallStatus call={firstCall} />
                </div>
                <Tabs defaultValue="curl">
                    <TabsList look="underline" className="overflow-x-auto">
                        {SNIPPETS.map((s) => (
                            <TabsTrigger key={s.id} value={s.id} className="shrink-0">{s.label}</TabsTrigger>
                        ))}
                    </TabsList>
                    {SNIPPETS.map((s) => {
                        const code = snippet(s.id, token, origin)
                        return (
                            <TabsContent key={s.id} value={s.id} className="mt-3">
                                <div className="rounded-xl bg-slate-950 border border-white/[0.08] overflow-hidden">
                                    <div className="flex items-center justify-between gap-3 pl-4 pr-2 py-1.5 border-b border-white/[0.08]">
                                        <span className="text-[11px] font-medium text-slate-400">
                                            {s.id === 'env' ? 'Keep this file out of version control' : 'Reads the key from API_KEY'}
                                        </span>
                                        <CopyAction
                                            text={code}
                                            label={`Copy the ${s.label} example`}
                                            className="h-7 px-2.5 rounded-lg text-xs font-semibold text-slate-200 bg-white/10 hover:bg-white/20 hover:text-white"
                                        >
                                            Copy
                                        </CopyAction>
                                    </div>
                                    <pre className="overflow-x-auto p-4 text-[12px] leading-relaxed font-mono text-slate-100">
                                        <code>{code}</code>
                                    </pre>
                                </div>
                            </TabsContent>
                        )
                    })}
                </Tabs>
            </div>

            <label className={cn(
                'flex items-center gap-3 p-4 rounded-2xl border-2 cursor-pointer transition-colors',
                acknowledged
                    ? 'border-emerald-500/50 bg-emerald-500/[0.06]'
                    : 'border-black/[0.10] dark:border-white/[0.12] hover:border-emerald-500/40',
            )}>
                <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => onAcknowledge(e.target.checked)}
                    className="w-4 h-4 accent-emerald-600"
                />
                <ShieldCheck className={cn('w-4 h-4 shrink-0', acknowledged ? 'text-emerald-500' : 'text-ink-muted')} aria-hidden />
                <span className="text-sm font-medium text-ink">I’ve stored it somewhere safe</span>
            </label>
        </div>
    )
}

function FirstCallStatus({ call }: { call: FirstCall }) {
    if (call.state === 'seen') {
        return (
            <span role="status" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />
                First call{call.ip ? ` from ${call.ip}` : ''}{call.client ? ` · ${call.client}` : ''}
            </span>
        )
    }
    if (call.state === 'quiet') {
        return (
            <span role="status" className="text-[11px] text-ink-muted text-right">
                No call yet — it will show as Last used when it happens.
            </span>
        )
    }
    return (
        <span role="status" className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
            <span className="relative flex w-2 h-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75 animate-ping motion-reduce:animate-none" />
                <span className="relative inline-flex w-2 h-2 rounded-full bg-indigo-500" />
            </span>
            Waiting for the first call…
        </span>
    )
}

/** Watches the key's record until something uses it, for two minutes at most. */
function useFirstCall(keyId: string): FirstCall {
    const client = useKeyClient()
    const [call, setCall] = useState<FirstCall>({ state: 'waiting' })
    useEffect(() => {
        const started = Date.now()
        const abort = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        const next = () => {
            if (Date.now() - started >= POLL_FOR_MS) setCall({ state: 'quiet' })
            else timer = setTimeout(poll, POLL_MS)
        }
        const poll = () => {
            client.lastUse(keyId, abort.signal).then((use) => {
                if (abort.signal.aborted) return
                if (use.lastUsedAt) {
                    setCall({ state: 'seen', ip: use.lastUsedIp, client: clientName(use.lastUsedUserAgent) })
                } else {
                    next()
                }
            }).catch(() => {
                if (!abort.signal.aborted) next()
            })
        }
        timer = setTimeout(poll, POLL_MS)
        return () => {
            abort.abort()
            clearTimeout(timer)
        }
    }, [keyId, client])
    return call
}

/** A copy button with words on it, for the two things this screen exists
 *  to hand over: the key and a first call. */
function CopyAction({ text, label, className, children }: {
    text: string
    /** What is copied, for the tooltip and screen readers: "Copy the key". */
    label: string
    className?: string
    /** The words on the button. */
    children: React.ReactNode
}) {
    const [copied, setCopied] = useState(false)
    const copy = (e: React.MouseEvent) => {
        e.stopPropagation()
        // Best effort: a refused clipboard leaves the text selectable.
        navigator.clipboard?.writeText(text).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
            () => {},
        )
    }
    const Icon = copied ? Check : Copy
    return (
        <HoverTip label={copied ? 'Copied' : label}>
            <button
                type="button"
                onClick={copy}
                aria-label={label}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-md text-ink-muted hover:text-ink transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    className,
                )}
            >
                <Icon className={cn('w-3.5 h-3.5 shrink-0', copied && 'text-emerald-500')} aria-hidden />
                {children}
            </button>
        </HoverTip>
    )
}
