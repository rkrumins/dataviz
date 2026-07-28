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
 * The activity log needs ``system:audit:read`` on top of the page's own
 * ``system:admin``. Without it the section is simply absent — a locked
 * panel advertises a capability the operator can neither use nor grant
 * themselves.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { AtSign, Hash, Loader2, Search, Tag, UserSearch } from 'lucide-react'

import { ssoAdminService, type UserSummary } from '@/services/ssoAdminService'
import { usePermission } from '@/store/auth'
import { cn } from '@/lib/utils'
import { SsoActivityTab } from '../../SsoActivityTab'
import { ErrorBanner } from './ErrorBanner'
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

function LookupSection() {
    const [mode, setMode] = useState<Mode>('anything')
    const [query, setQuery] = useState('')
    const [attrKey, setAttrKey] = useState('staff_id')
    const [results, setResults] = useState<UserSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const active = MODES.find(m => m.id === mode)!

    async function runSearch(e: React.FormEvent) {
        e.preventDefault()
        if (!query.trim()) return
        setError(null)
        setBusy(true)
        try {
            if (mode === 'email') {
                setResults([await ssoAdminService.lookupUserByEmail(query.trim())])
            } else if (mode === 'attribute') {
                setResults([await ssoAdminService.lookupUserByAttribute(
                    attrKey.trim(), query.trim(),
                )])
            } else {
                setResults(await ssoAdminService.searchUsers(query.trim()))
            }
        } catch (err) {
            setResults([])
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-sm font-bold text-ink flex items-center gap-2">
                    <UserSearch className="w-4 h-4 text-ink-muted" />
                    Find a person
                </h2>
                <p className="mt-1 text-xs text-ink-muted max-w-2xl leading-relaxed">
                    Whichever handle you were given. This is the only search in the
                    product that resolves someone by a claim your IdP sends rather
                    than by their name or email.
                </p>
            </div>

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
                            className="w-40 px-3 py-2.5 rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated font-mono text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
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
                        className="flex-1 min-w-[14rem] px-3 py-2.5 rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated text-sm outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                    />
                    <button
                        type="submit"
                        disabled={busy || !query.trim()}
                        className={cn(
                            'inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150',
                            query.trim() && !busy
                                ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
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

            {error && <ErrorBanner message={error} />}

            {results !== null && results.length === 0 && !error && (
                <p className="text-xs text-ink-muted">
                    Nobody matched. If they have never signed in successfully,
                    there is no account yet — the activity log below will still
                    show the attempt.
                </p>
            )}

            {results !== null && results.length > 0 && (
                <ul className="space-y-3">
                    {results.map((u, i) => (
                        <UserResultCard key={u.id} user={u} index={i} />
                    ))}
                </ul>
            )}
        </section>
    )
}

export function DiagnosticsTab() {
    const canReadAudit = usePermission('system:audit:read')
    return (
        <div className="space-y-8 max-w-3xl">
            {canReadAudit && (
                // Deliberately first. A person who could not sign in was shown
                // a reference and told to quote it, so pasting it is the
                // operator's opening move — and it used to be below the fold.
                <motion.section
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16 }}
                    className="rounded-2xl border-2 border-black/[0.08] dark:border-white/[0.10] p-4 flex items-start gap-3"
                >
                    <div className="shrink-0 w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                        <Hash className="w-4 h-4 text-indigo-500" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-sm font-bold text-ink">
                            Given a reference?
                        </h2>
                        <p className="mt-1 text-xs text-ink-secondary leading-relaxed">
                            Someone who could not sign in saw a short code like{' '}
                            <code className="font-mono text-ink">a1b2c3d4</code>.
                            Paste it into the activity search below — the real
                            reason is recorded there, and deliberately not shown to
                            them, because it would describe your configuration to
                            anyone who can reach the sign-in page.
                        </p>
                    </div>
                </motion.section>
            )}

            <LookupSection />

            {canReadAudit && (
                <div className="pt-6 border-t border-black/[0.08] dark:border-white/[0.10]">
                    <SsoActivityTab />
                </div>
            )}
        </div>
    )
}
