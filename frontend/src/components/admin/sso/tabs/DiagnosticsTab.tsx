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
 * The activity log needs ``system:audit:read`` on top of the page's own
 * ``system:admin``. Without it the section is simply absent — a locked
 * panel advertises a capability the operator cannot use and cannot grant
 * themselves.
 */
import { useState } from 'react'
import { Search } from 'lucide-react'

import { ssoAdminService, type UserSummary } from '@/services/ssoAdminService'
import { usePermission } from '@/store/auth'
import { SsoActivityTab } from '../../SsoActivityTab'
import { ErrorBanner } from './ErrorBanner'

function LookupSection() {
    const [query, setQuery] = useState('')
    const [structuredMode, setStructuredMode] = useState<
        'email' | 'attribute' | null
    >(null)
    const [attrKey, setAttrKey] = useState('staff_id')
    const [attrValue, setAttrValue] = useState('')
    const [results, setResults] = useState<UserSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    async function runSearch(e: React.FormEvent) {
        e.preventDefault()
        setError(null)
        setBusy(true)
        try {
            if (structuredMode === 'email') {
                const r = await ssoAdminService.lookupUserByEmail(query)
                setResults([r])
            } else if (structuredMode === 'attribute') {
                const r = await ssoAdminService.lookupUserByAttribute(
                    attrKey, attrValue,
                )
                setResults([r])
            } else {
                setResults(await ssoAdminService.searchUsers(query))
            }
        } catch (err) {
            setResults([])
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="space-y-4">
            <h2 className="text-base font-semibold">Find a user</h2>
            <p className="text-xs text-ink-muted">
                Free-text fan-out across email, names, identities, and indexed claim attributes. Use the structured modes for exact matches.
            </p>
            <form onSubmit={runSearch} className="space-y-3">
                <div className="flex gap-2">
                    <input
                        className="flex-1 px-3 py-2 rounded border border-white/10 bg-canvas text-sm"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={
                            structuredMode === 'email'
                                ? 'alice@corp.com'
                                : 'name, email, external_id, or attribute value…'
                        }
                    />
                    <button
                        type="submit"
                        disabled={busy}
                        className="px-4 py-2 rounded bg-accent-lineage text-white text-sm disabled:opacity-50"
                    >
                        <Search className="inline w-4 h-4 mr-1" />
                        Search
                    </button>
                </div>
                <details className="text-xs">
                    <summary className="cursor-pointer text-ink-muted">▸ Find by claim attribute (staff_id, employee_id, …)</summary>
                    <div className="mt-2 p-3 rounded-lg border border-white/10 bg-white/5 grid grid-cols-2 gap-3">
                        <label>
                            Key
                            <input
                                className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono"
                                value={attrKey}
                                onChange={(e) => setAttrKey(e.target.value)}
                            />
                        </label>
                        <label>
                            Value
                            <input
                                className="mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono"
                                value={attrValue}
                                onChange={(e) => setAttrValue(e.target.value)}
                            />
                        </label>
                        <div className="col-span-2 flex gap-2">
                            <button
                                type="button"
                                onClick={(e) => {
                                    setStructuredMode('attribute')
                                    runSearch(e as unknown as React.FormEvent)
                                }}
                                className="px-3 py-1.5 rounded border border-white/20 text-xs"
                            >
                                Run attribute lookup
                            </button>
                            <button
                                type="button"
                                onClick={() => setStructuredMode(null)}
                                className="text-xs text-ink-muted"
                            >
                                Back to free-text
                            </button>
                        </div>
                    </div>
                </details>
            </form>

            {error && <ErrorBanner message={error} />}

            {results.length > 0 && (
                <ul className="space-y-2">
                    {results.map((u) => (
                        <li
                            key={u.id}
                            className="p-4 rounded-xl border border-white/10 bg-white/5 text-sm space-y-2"
                        >
                            <div className="flex items-start justify-between">
                                <div>
                                    <div className="font-medium">
                                        {u.firstName} {u.lastName}{' '}
                                        <span className="text-ink-muted">
                                            ({u.email})
                                        </span>
                                    </div>
                                    <div className="text-xs text-ink-muted mt-0.5 font-mono">
                                        {u.id} · {u.status}
                                    </div>
                                </div>
                                <span
                                    className={
                                        'px-2 py-0.5 rounded-full text-xs ' + ({
                                            'local_signup': 'bg-blue-500/20 text-blue-300',
                                            'sso_jit': 'bg-violet-500/20 text-violet-300',
                                            'invite': 'bg-amber-500/20 text-amber-300',
                                            'admin_created': 'bg-zinc-500/20 text-zinc-300',
                                            'admin_linked': 'bg-teal-500/20 text-teal-300',
                                        }[u.signupSource] ?? 'bg-ink-muted/20')
                                    }
                                    title={
                                        u.signupProvider
                                            ? `via ${u.signupProvider.displayName}`
                                            : undefined
                                    }
                                >
                                    {u.signupSource}
                                    {u.signupProvider && (
                                        <>
                                            {' '}
                                            <span className="opacity-70">
                                                · {u.signupProvider.slug}
                                            </span>
                                        </>
                                    )}
                                </span>
                            </div>
                            {u.matchedOn && u.matchedOn.length > 0 && (
                                <div className="text-xs text-ink-muted">
                                    matched on: {u.matchedOn.join(', ')}
                                </div>
                            )}
                            {u.identities.length > 0 && (
                                <div>
                                    <div className="text-[11px] uppercase tracking-wider text-ink-muted mt-2">
                                        Linked identities
                                    </div>
                                    <ul className="mt-1 space-y-1 text-xs">
                                        {u.identities.map((i) => (
                                            <li key={i.id} className="font-mono">
                                                {i.provider.slug} · {i.externalId}
                                                {i.lastLoginAt && (
                                                    <span className="ml-2 text-ink-muted">
                                                        last login {new Date(i.lastLoginAt).toLocaleString()}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {u.attributes.length > 0 && (
                                <div>
                                    <div className="text-[11px] uppercase tracking-wider text-ink-muted mt-2">
                                        Claim attributes
                                    </div>
                                    <ul className="mt-1 space-y-1 text-xs font-mono">
                                        {u.attributes.map((a) => (
                                            <li key={a.key}>
                                                {a.key} = {a.value}
                                                {a.sourceProvider && (
                                                    <span className="ml-2 text-ink-muted">
                                                        (from {a.sourceProvider.slug})
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}


export function DiagnosticsTab() {
    const canReadAudit = usePermission('system:audit:read')
    return (
        <div className="space-y-8">
            <LookupSection />
            {canReadAudit && (
                <div className="pt-6 border-t border-white/10">
                    <SsoActivityTab />
                </div>
            )}
        </div>
    )
}
