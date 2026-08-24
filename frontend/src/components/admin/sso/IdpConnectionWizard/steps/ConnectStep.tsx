/**
 * Connect — and, at last, the other half of the job.
 *
 * Setting up SSO is two-sided: some values come from the IdP, and some
 * have to be pasted *into* it. The old form only ever acknowledged the
 * first half, so an operator had to already know that a redirect URI
 * existed, what ours was, and that Entra rejects the sign-in when it does
 * not match to the character.
 *
 * So this step is a pair. Left: paste the issuer or metadata and let
 * discovery fill in what the IdP publishes. Right: the values to copy
 * into their console, live-updating as they name the connection, because
 * the slug is part of the redirect URI.
 */
import { useState } from 'react'
import {
    Plug, Loader2, Check, AlertTriangle, Copy, ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    StepColumn, StepHero, StepBlock, FieldLabel, BigInput, Hint,
} from '@/components/admin/InviteWizard/ui'
import { consoleValues, type VendorPreset } from '../../vendorPresets'
import type { DiscoverResult } from '@/services/ssoAdminService'

function CopyRow({ label, value }: { label: string; value: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wider text-ink-muted">
                    {label}
                </div>
                <div className="font-mono text-[11px] text-ink truncate" title={value}>
                    {value}
                </div>
            </div>
            <button
                type="button"
                aria-label={`Copy ${label}`}
                onClick={() => {
                    void navigator.clipboard?.writeText(value)
                        .then(() => {
                            setCopied(true)
                            setTimeout(() => setCopied(false), 1600)
                        })
                        .catch(() => { /* insecure context — text is selectable */ })
                }}
                className="shrink-0 p-1.5 rounded-lg border border-white/10 hover:bg-white/5 text-ink-muted hover:text-ink"
            >
                {copied
                    ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                    : <Copy className="w-3.5 h-3.5" />}
            </button>
        </div>
    )
}

export function ConnectStep({
    preset, displayName, onDisplayName, slug,
    connectInput, onConnectInput, onDiscover, discovering, discovery,
}: {
    preset: VendorPreset
    displayName: string
    onDisplayName: (v: string) => void
    slug: string
    connectInput: string
    onConnectInput: (v: string) => void
    onDiscover: () => void
    discovering: boolean
    discovery: DiscoverResult | null
}) {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const values = consoleValues(slug, origin)
    const isSaml = preset.kind === 'saml2'
    // Which kinds have something to fetch. Previously written as "not a
    // portal", which happened to be right while OIDC and SAML were the
    // only other kinds — ``POST /discover`` supports those two and 404s
    // for anything else, so any new kind inherited a Fetch button that
    // could only ever fail.
    const hasDiscovery = preset.kind === 'oidc' || isSaml

    return (
        <StepColumn wide>
            <StepHero
                pill="Step 2 of 5"
                pillIcon={Plug}
                title={`Connect to ${preset.name}`}
                subtitle="Name it, then let us read its configuration. You'll also need to paste a few of our values into its console."
            />

            <StepBlock>
                <FieldLabel>Connection name</FieldLabel>
                <BigInput
                    value={displayName}
                    onChange={(e) => onDisplayName(e.target.value)}
                    placeholder={preset.name}
                    autoFocus
                />
                {slug && (
                    <p className="mt-1.5 text-[11px] text-ink-muted">
                        URLs will use <code className="font-mono text-ink">{slug}</code>
                    </p>
                )}
            </StepBlock>

            {hasDiscovery && (
                <StepBlock>
                    <FieldLabel>{preset.connectLabel ?? 'Issuer URL'}</FieldLabel>
                    <div className="flex gap-2">
                        <BigInput
                            value={connectInput}
                            onChange={(e) => onConnectInput(e.target.value)}
                            placeholder={preset.connectHint}
                        />
                        <button
                            type="button"
                            onClick={onDiscover}
                            disabled={discovering || !connectInput.trim()}
                            className="shrink-0 px-4 rounded-xl bg-accent-lineage text-white text-sm font-semibold disabled:opacity-40"
                        >
                            {discovering
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : 'Fetch'}
                        </button>
                    </div>
                    {isSaml && (
                        <p className="mt-1.5 text-[11px] text-ink-muted">
                            A metadata URL, or paste the XML itself.
                        </p>
                    )}

                    {discovery?.success && (
                        <div className="mt-3 p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5">
                            <div className="flex items-center gap-2 text-sm text-emerald-300">
                                <Check className="w-4 h-4" />
                                Read {Object.keys(discovery.settings).length} settings
                                from {preset.name}
                            </div>
                            <ul className="mt-2 space-y-0.5">
                                {Object.keys(discovery.settings).slice(0, 6).map(k => (
                                    <li key={k} className="font-mono text-[11px] text-ink-muted">
                                        {k}
                                    </li>
                                ))}
                            </ul>
                            {discovery.warnings?.map(w => (
                                <Hint key={w} tone="warn">{w}</Hint>
                            ))}
                        </div>
                    )}
                    {discovery && !discovery.success && (
                        <div className="mt-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
                            <div className="flex items-start gap-2 text-sm text-amber-300">
                                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                <div>
                                    <p>Couldn't read that.</p>
                                    <p className="mt-1 text-[11px] text-ink-muted">
                                        {discovery.error}
                                    </p>
                                    <p className="mt-1 text-[11px] text-ink-muted">
                                        You can still continue and enter the values by hand.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </StepBlock>
            )}

            {/* The other side of the job. */}
            <StepBlock>
                <FieldLabel>Set this up in {preset.name}</FieldLabel>
                <ol className="mt-2 space-y-3">
                    {preset.consoleSteps.map((s, i) => (
                        <li key={s.title} className="flex gap-3">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-white/10 text-[10px] flex items-center justify-center text-ink-muted">
                                {i + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-ink">{s.title}</div>
                                {s.detail && (
                                    <div className="mt-0.5 text-[11px] text-ink-muted">
                                        {s.detail}
                                    </div>
                                )}
                                {s.copyValue && (
                                    <div className={cn(
                                        'mt-2 p-2 rounded-lg border border-white/10 bg-black/20',
                                    )}>
                                        <CopyRow
                                            label={s.copyValue}
                                            value={values[s.copyValue]}
                                        />
                                    </div>
                                )}
                            </div>
                        </li>
                    ))}
                </ol>
                {preset.docsUrl && (
                    <a
                        href={preset.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 text-xs text-accent-lineage hover:underline"
                    >
                        {preset.name} documentation
                        <ExternalLink className="w-3 h-3" />
                    </a>
                )}
            </StepBlock>
        </StepColumn>
    )
}
