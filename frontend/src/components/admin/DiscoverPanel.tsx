/**
 * "Set up from your IdP" — the first thing on a new provider form.
 *
 * Standing up an IdP used to mean hand-transcribing ~15 fields from one
 * admin console into another: issuer URLs, entity ids, a base64 signing
 * certificate. Every one is a chance to introduce a typo that surfaces days
 * later as an opaque login failure. Both protocols publish this
 * information; one paste reads it.
 *
 * Deliberately does not save. It fills the form and hands control back, so
 * the operator sees exactly what will be stored before storing it.
 */
import { useState } from 'react'
import { AlertTriangle, Check, Download } from 'lucide-react'

import { ssoAdminService, type IdpKind } from '@/services/ssoAdminService'
import { cn } from '@/lib/utils'

const inputCls =
    'mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs'

export function DiscoverPanel({
    kind, onDiscovered,
}: {
    kind: IdpKind
    /** Receives the derived settings to merge into the form. */
    onDiscovered: (settings: Record<string, unknown>) => void
}) {
    const [value, setValue] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [warnings, setWarnings] = useState<string[]>([])
    const [filled, setFilled] = useState<string[]>([])

    // Only OIDC and SAML publish their configuration. A custom_profile
    // provider is defined by your portal, not discoverable from it.
    if (kind !== 'oidc' && kind !== 'saml2') return null

    const isOidc = kind === 'oidc'
    // A SAML operator may have a URL or the XML itself; one textarea takes
    // either, distinguished by whether it starts with a tag.
    const looksLikeXml = value.trim().startsWith('<')

    async function run() {
        setBusy(true)
        setError(null)
        setWarnings([])
        setFilled([])
        try {
            const result = await ssoAdminService.discover(
                isOidc
                    ? { kind, issuer: value }
                    : looksLikeXml
                        ? { kind, metadataXml: value }
                        : { kind, metadataUrl: value },
            )
            if (!result.success) {
                setError(result.error || 'Could not read that provider.')
                return
            }
            setWarnings(result.warnings ?? [])
            setFilled(Object.keys(result.settings ?? {}))
            onDiscovered(result.settings ?? {})
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="p-3 rounded-lg border border-accent-lineage/25 bg-accent-lineage/[0.04] space-y-2">
            <div>
                <h4 className="text-xs font-semibold text-ink flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5 text-accent-lineage" />
                    Set up from your IdP
                </h4>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                    {isOidc
                        ? 'Paste the issuer URL and we will read its discovery document. You still supply the client ID and secret.'
                        : 'Paste your IdP metadata URL, or the metadata XML itself. Entity ID, sign-on URL and signing certificate are read from it.'}
                </p>
            </div>

            <div className="flex gap-2 items-start">
                {isOidc || !looksLikeXml ? (
                    <input
                        className={cn(inputCls, 'font-mono flex-1')}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={isOidc
                            ? 'https://login.microsoftonline.com/<tenant>/v2.0'
                            : 'https://idp.example.com/app/metadata  — or paste XML'}
                        aria-label={isOidc ? 'Issuer URL' : 'Metadata URL or XML'}
                    />
                ) : (
                    <textarea
                        rows={4}
                        className={cn(inputCls, 'font-mono flex-1')}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        aria-label="Metadata URL or XML"
                    />
                )}
                <button
                    type="button"
                    disabled={busy || !value.trim()}
                    onClick={() => { void run() }}
                    className={cn(
                        'mt-1 shrink-0 px-3 py-1.5 rounded text-xs font-medium',
                        busy || !value.trim()
                            ? 'border border-white/10 text-ink-muted opacity-60 cursor-not-allowed'
                            : 'bg-accent-lineage text-white hover:brightness-110',
                    )}
                >
                    {busy ? 'Reading…' : 'Read configuration'}
                </button>
            </div>

            {error && (
                <p className="text-[11px] text-red-400">{error}</p>
            )}

            {filled.length > 0 && (
                <p className="text-[11px] text-emerald-400 flex items-start gap-1">
                    <Check className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>
                        Filled in {filled.length} setting
                        {filled.length === 1 ? '' : 's'}:{' '}
                        <span className="font-mono">{filled.join(', ')}</span>.
                        Review below before saving.
                    </span>
                </p>
            )}

            {warnings.map((w) => (
                <p key={w} className="text-[11px] text-yellow-300 flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    {w}
                </p>
            ))}
        </div>
    )
}
