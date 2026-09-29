/**
 * DiagnosticsTab — "why couldn't Alice sign in?"
 *
 * Two halves of one question, so they live together rather than as two
 * top-level tabs. Finding the person is not SSO *configuration*, which is
 * why it is no longer a peer of Providers and Settings — but it is not
 * covered by Admin → Users either: that page filters an already-loaded
 * list by name and email, and cannot resolve a claim attribute or an IdP
 * external id. Losing it would lose the lookup entirely.
 *
 * The page now opens the way the job actually starts. A person who failed
 * to sign in was shown a short reference like `a1b2c3d4` and told to quote
 * it; the operator's first act is to paste it. That was buried below a
 * free-text user search, so the screen's opening move and the operator's
 * were different things.
 *
 * The search modes were behind a `<details>` disclosure headed with a
 * unicode triangle. Finding someone by staff number is the one thing this
 * screen can do that nothing else in the product can — hiding it was
 * backwards.
 *
 * Above both sits the other way the job starts: nobody has quoted anything
 * yet, and the operator wants to know who is failing and why. That list
 * is per person, and opens a person straight into the lookup.
 *
 * The full activity log is its own tab; a quoted reference opens it with
 * the reference searched.
 *
 * The problem list and the reference lookup need ``system:audit:read`` on
 * top of the page's own ``system:admin``. Without it they are simply absent
 * — a locked panel advertises a capability the operator can neither use nor
 * grant themselves.
 */
import { useEffect, useRef, useState } from 'react'
import { AtSign, Hash, Loader2, Search, SearchX, Tag, UserSearch } from 'lucide-react'

import { ssoAdminService, type UserSummary } from '@/services/ssoAdminService'
import { usePermission } from '@/store/auth'
import { cn } from '@/lib/utils'
import { SsoCard, SsoEmpty } from '../ui/SsoCard'
import { ErrorBanner } from './ErrorBanner'
import { SignInProblems } from './diagnostics/SignInProblems'
import { UserResultCard } from './diagnostics/UserResultCard'

type Mode = 'anything' | 'email' | 'attribute'

const MODES: { id: Mode; label: string; icon: typeof Search; hint: string }[] = [
    {
        id: 'anything', label: 'Anything', icon: Search,
        hint: 'Fans out across names, emails, linked identities and indexed claim attributes.',
    },
    {
        id: 'email', label: 'Email', icon: AtSign,
        hint: 'Exact match on the address, including addresses only an IdP has asserted.',
    },
    {
        id: 'attribute', label: 'Claim attribute', icon: Tag,
        hint: 'Exact match on a value your IdP sends — staff number, employee id, cost centre.',
    },
]

function lookup(mode: Mode, attrKey: string, q: string): Promise<UserSummary[]> {
    if (mode === 'email') {
        return ssoAdminService.lookupUserByEmail(q).then(u => [u])
    }
    if (mode === 'attribute') {
        return ssoAdminService.lookupUserByAttribute(attrKey.trim(), q).then(u => [u])
    }
    return ssoAdminService.searchUsers(q)
}

/** ``email`` arrives when another section asks to open a person: the
 *  lookup starts in email mode and runs it straight away. */
function LookupSection({ email }: { email?: string }) {
    const [mode, setMode] = useState<Mode>(email ? 'email' : 'anything')
    const [query, setQuery] = useState(email ?? '')
    const [attrKey, setAttrKey] = useState('staff_id')
    const [results, setResults] = useState<UserSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(Boolean(email))
    const ref = useRef<HTMLElement>(null)

    const active = MODES.find(m => m.id === mode)!

    function settle(p: Promise<UserSummary[]>) {
        return p
            .then(r => { setResults(r); setError(null) })
            .catch((err: Error) => { setResults([]); setError(err.message) })
            .finally(() => setBusy(false))
    }

    useEffect(() => {
        if (!email) return
        ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        void settle(lookup('email', '', email))
    }, [email])

    async function runSearch(e: React.FormEvent) {
        e.preventDefault()
        if (!query.trim()) return
        setError(null)
        setBusy(true)
        await settle(lookup(mode, attrKey, query.trim()))
    }

    return (
        <section ref={ref} className="space-y-4 scroll-mt-6">
            <SsoCard
                icon={UserSearch}
                title="Find a person"
                blurb="Whichever handle you were given. This is the only search in the product that resolves someone by a claim your IdP sends rather than by their name or email."
            >
            <form onSubmit={runSearch} className="space-y-3">
                {/* Modes as peers, not one visible and two hidden behind a
                    disclosure triangle. */}
                <div
                    role="tablist"
                    aria-label="Search by"
                    className="inline-flex p-1 rounded-xl bg-black/[0.04] dark:bg-white/[0.06]"
                >
                    {MODES.map(m => (
                        <button
                            key={m.id}
                            type="button"
                            role="tab"
                            aria-selected={mode === m.id}
                            onClick={() => { setMode(m.id); setResults(null); setError(null) }}
                            className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150',
                                mode === m.id
                                    ? 'bg-canvas-elevated text-ink shadow-sm'
                                    : 'text-ink-muted hover:text-ink',
                            )}
                        >
                            <m.icon className="w-3.5 h-3.5" />
                            {m.label}
                        </button>
                    ))}
                </div>

                <div className="flex flex-wrap gap-2">
                    {mode === 'attribute' && (
                        <input
                            value={attrKey}
                            onChange={e => setAttrKey(e.target.value)}
                            aria-label="Attribute name"
                            placeholder="staff_id"
                            className="w-40 h-10 px-3 rounded-xl border border-glass-border bg-canvas font-mono text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                        />
                    )}
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        aria-label="Search"
                        placeholder={
                            mode === 'email' ? 'alice@corp.example'
                                : mode === 'attribute' ? '12345'
                                : 'name, email, external id, or an attribute value…'
                        }
                        className="flex-1 min-w-[12rem] h-10 px-3 rounded-xl border border-glass-border bg-canvas text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                    />
                    <button
                        type="submit"
                        disabled={busy || !query.trim()}
                        className={cn(
                            'inline-flex items-center gap-2 h-10 px-5 rounded-xl text-sm font-medium transition-colors duration-150',
                            query.trim() && !busy
                                ? 'bg-accent-lineage text-white hover:brightness-110 shadow-sm shadow-accent-lineage/20'
                                : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                        )}
                    >
                        {busy
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Search className="w-4 h-4" />}
                        Search
                    </button>
                </div>

                <p className="text-[11px] text-ink-muted">{active.hint}</p>
            </form>
            </SsoCard>

            {error && <ErrorBanner message={error} />}

            {/* The results area always occupies its place. Leaving it blank
                until a search runs made the tab open as a control at the top
                of an empty page, which reads as something failing to load. */}
            {results === null && !error && (
                <SsoCard>
                    <SsoEmpty icon={UserSearch}>
                        Search above to see someone’s accounts, how they can sign
                        in, and what their IdP has told us about them.
                    </SsoEmpty>
                </SsoCard>
            )}

            {results !== null && results.length === 0 && !error && (
                <SsoCard>
                    <SsoEmpty icon={SearchX}>
                        Nobody matched. If they have never signed in successfully
                        there is no account yet — the Activity tab still
                        shows the attempt.
                    </SsoEmpty>
                </SsoCard>
            )}

            {results !== null && results.length > 0 && (
                <>
                    <p className="text-[11px] text-ink-muted">
                        {results.length} {results.length === 1 ? 'person' : 'people'} found
                    </p>
                    <ul className="space-y-3">
                        {results.map((u, i) => (
                            <UserResultCard key={u.id} user={u} index={i} />
                        ))}
                    </ul>
                </>
            )}
        </section>
    )
}

/** Look a quoted reference up in the activity log. */
function ReferenceCard({ onOpen }: { onOpen: (ref: string) => void }) {
    const [ref, setRef] = useState('')
    return (
        <SsoCard
            icon={Hash}
            tone="info"
            title="Given a reference?"
            blurb={<>
                Someone who could not sign in saw a short code like{' '}
                <code className="font-mono text-ink">a1b2c3d4</code>. The real
                reason is recorded against it, and deliberately not shown to
                them — it would describe your configuration to anyone who can
                reach the sign-in page.
            </>}
        >
            <form
                onSubmit={e => { e.preventDefault(); if (ref.trim()) onOpen(ref.trim()) }}
                className="flex gap-2"
            >
                <input
                    value={ref}
                    onChange={e => setRef(e.target.value)}
                    aria-label="Reference"
                    placeholder="a1b2c3d4"
                    className="flex-1 min-w-0 h-9 px-3 rounded-lg border border-glass-border bg-canvas font-mono text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                />
                <button
                    type="submit"
                    disabled={!ref.trim()}
                    className="h-9 px-3 rounded-lg bg-accent-lineage text-white text-xs font-medium disabled:opacity-40"
                >
                    Look up
                </button>
            </form>
        </SsoCard>
    )
}

export function DiagnosticsTab({ onOpenActivity }: {
    /** Open the activity log with this search applied. */
    onOpenActivity?: (query: string) => void
}) {
    const canReadAudit = usePermission('system:audit:read')
    // Each "Open account" remounts the lookup with that person in it.
    const [inspect, setInspect] = useState<{ email: string; n: number } | null>(null)
    return (
        <div className="space-y-6">
            {canReadAudit && (
                <SignInProblems
                    onInspect={email => setInspect(prev => ({ email, n: (prev?.n ?? 0) + 1 }))}
                />
            )}

            <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start">
                <div className="min-w-0">
                    <LookupSection key={inspect?.n ?? 0} email={inspect?.email} />
                </div>

                <aside className="space-y-4 xl:sticky xl:top-6">
                    {canReadAudit && onOpenActivity && (
                        // The operator's opening move: a person who could not
                        // sign in is holding a code and was told to quote it.
                        <ReferenceCard onOpen={onOpenActivity} />
                    )}

                    <SsoCard icon={Search} title="Which search to use">
                        <dl className="space-y-2.5">
                            {MODES.map(m => (
                                <div key={m.id}>
                                    <dt className="flex items-center gap-1.5 text-[11px] font-semibold text-ink">
                                        <m.icon className="w-3 h-3 text-ink-muted" />
                                        {m.label}
                                    </dt>
                                    <dd className="mt-0.5 text-[11px] text-ink-muted leading-relaxed">
                                        {m.hint}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </SsoCard>
                </aside>
            </div>
        </div>
    )
}
