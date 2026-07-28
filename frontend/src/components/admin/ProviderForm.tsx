/**
 * Create / edit form for one ``idp_providers`` row.
 *
 * Two shapes of settings editor:
 *
 *   * ``custom_profile`` gets real fields, because the settings are a
 *     small fixed set and two of them (unsigned payloads, proxy headers)
 *     are trust decisions that need a visible warning rather than a JSON
 *     key an operator can set without noticing.
 *   * ``oidc`` / ``saml2`` / ``custom`` keep the existing JSON textarea —
 *     their settings are large, per-IdP, and already documented.
 *
 * Both shapes share the visual claim-mapping editor.
 *
 * Secrets come back from the API redacted as ``'********'``. The PATCH
 * endpoint merges settings rather than replacing them, so any field
 * still holding the mask is stripped before submit — leaving a secret
 * untouched is the default, and rotating it means typing a new value.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import {
    ssoAdminService,
    type CustomProfileSettings,
    type CustomProfileSource,
    type IdpKind,
    type IdpProvider,
} from '@/services/ssoAdminService'
import { ClaimMappingEditor, type ClaimMapping } from './ClaimMappingEditor'
import { DiscoverPanel } from './DiscoverPanel'
import { cn } from '@/lib/utils'

type LinkingPolicy = 'strict' | 'allow_verified' | 'manual_only' | 'disabled'

const REDACTED = '********'

/** Comma/space separated -> the array the API takes. The server
 *  normalises case and a leading @, so this only has to split. */
function parseDomains(raw: string): string[] {
    return raw.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean)
}

const OIDC_SETTINGS_TEMPLATE =
    '{\n  "issuer": "",\n  "client_id": "",\n  "client_secret": "",\n  "redirect_uri": ""\n}'

const SOURCE_LABELS: Record<CustomProfileSource, string> = {
    cookie: 'Cookie (read server-side)',
    local_storage: 'Browser localStorage',
    session_storage: 'Browser sessionStorage',
    header: 'Request header (from a proxy)',
}

const SOURCE_KEY_PLACEHOLDER: Record<CustomProfileSource, string> = {
    cookie: 'corp_profile',
    local_storage: 'corp.user',
    session_storage: 'corp.user',
    header: 'X-Corp-Profile',
}

const BROWSER_SOURCES: CustomProfileSource[] = ['local_storage', 'session_storage']

const DEFAULT_CUSTOM_PROFILE_SETTINGS: CustomProfileSettings = {
    source: 'cookie',
    source_key: '',
    encoding: 'none',
    payload_format: 'jwt',
    signing_alg: 'HS256',
    shared_secret: '',
    public_key: '',
    issuer: '',
    audience: '',
    max_age_seconds: 300,
    trust_unsigned: false,
    trusted_proxy_acknowledged: false,
}

/** Drop redacted secrets so a PATCH never writes the mask over the real
 *  value, and drop empties so the merge doesn't store noise. */
function cleanSettings(s: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(s).filter(([, v]) => v !== REDACTED && v !== ''),
    )
}

const inputCls =
    'mt-1 w-full px-2 py-1.5 rounded bg-canvas border border-white/10 text-xs'
const monoCls = `${inputCls} font-mono`

// ── Danger toggle shared by the two degraded-trust settings ──────────

function DangerToggle({
    checked, onChange, title, children,
}: {
    checked: boolean
    onChange: (v: boolean) => void
    title: string
    children: React.ReactNode
}) {
    return (
        <div className={cn(
            'p-3 rounded-lg border',
            checked
                ? 'border-red-500/40 bg-red-500/10'
                : 'border-white/10 bg-white/[0.02]',
        )}>
            <label className="flex items-start gap-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked)}
                    className="mt-0.5"
                />
                <span>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                        <AlertTriangle className={cn(
                            'w-3.5 h-3.5',
                            checked ? 'text-red-400' : 'text-yellow-400',
                        )} />
                        {title}
                    </span>
                    <span className="mt-1 block text-[11px] text-ink-muted">
                        {children}
                    </span>
                </span>
            </label>
        </div>
    )
}

// ── custom_profile settings ──────────────────────────────────────────

function CustomProfileSettingsForm({
    value, onChange,
}: {
    value: CustomProfileSettings
    onChange: (next: CustomProfileSettings) => void
}) {
    const source = value.source ?? 'cookie'
    const format = value.payload_format ?? 'jwt'
    const alg = value.signing_alg ?? 'HS256'
    const set = <K extends keyof CustomProfileSettings>(
        k: K, v: CustomProfileSettings[K],
    ) => onChange({ ...value, [k]: v })

    return (
        <div className="space-y-3 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
            <p className="text-[11px] text-ink-muted">
                Where the already-authenticated profile is handed to us.
                Cookies and headers are read on the server, so those sign in
                with a plain redirect; browser storage needs the page to read
                the key and post it back.
            </p>

            <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                    Source
                    <select
                        className={inputCls}
                        value={source}
                        onChange={(e) => set('source', e.target.value as CustomProfileSource)}
                    >
                        {(Object.keys(SOURCE_LABELS) as CustomProfileSource[]).map((s) => (
                            <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                        ))}
                    </select>
                </label>
                <label className="text-xs">
                    {source === 'header' ? 'Header name'
                        : source === 'cookie' ? 'Cookie name' : 'Storage key'}
                    <input
                        className={monoCls}
                        value={value.source_key ?? ''}
                        onChange={(e) => set('source_key', e.target.value)}
                        placeholder={SOURCE_KEY_PLACEHOLDER[source]}
                        required
                    />
                </label>
                <label className="text-xs">
                    Payload format
                    <select
                        className={inputCls}
                        value={format}
                        onChange={(e) => set('payload_format', e.target.value as 'jwt' | 'json')}
                    >
                        <option value="jwt">Signed JWT (recommended)</option>
                        <option value="json">Plain JSON (unverifiable)</option>
                    </select>
                </label>
                <label className="text-xs">
                    Transport encoding
                    <select
                        className={inputCls}
                        value={value.encoding ?? 'none'}
                        onChange={(e) => set('encoding', e.target.value as 'none' | 'base64url' | 'url')}
                    >
                        <option value="none">None</option>
                        <option value="base64url">base64url</option>
                        <option value="url">URL-encoded</option>
                    </select>
                </label>
            </div>

            {format === 'jwt' && (
                <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs">
                        Signing algorithm
                        <select
                            className={inputCls}
                            value={alg}
                            onChange={(e) => set('signing_alg', e.target.value as 'HS256' | 'RS256')}
                        >
                            <option value="HS256">HS256 (shared secret)</option>
                            <option value="RS256">RS256 (public key)</option>
                        </select>
                    </label>
                    <label className="text-xs">
                        Max age (seconds)
                        <input
                            type="number"
                            min={0}
                            className={inputCls}
                            value={value.max_age_seconds ?? 300}
                            onChange={(e) => set('max_age_seconds', Number(e.target.value))}
                        />
                        <span className="mt-0.5 block text-[10px] text-ink-muted">
                            Rejects a payload whose <code>iat</code> is older than
                            this, however long its <code>exp</code> is. 0 disables.
                        </span>
                    </label>
                    {alg === 'HS256' ? (
                        <label className="text-xs col-span-2">
                            Shared secret
                            <input
                                type="password"
                                className={monoCls}
                                value={value.shared_secret ?? ''}
                                onChange={(e) => set('shared_secret', e.target.value)}
                                placeholder="the secret the portal signs with"
                                autoComplete="new-password"
                            />
                            {value.shared_secret === REDACTED && (
                                <span className="mt-0.5 block text-[10px] text-ink-muted">
                                    A secret is configured. Leave this as-is to keep
                                    it; type a new value to rotate.
                                </span>
                            )}
                        </label>
                    ) : (
                        <label className="text-xs col-span-2">
                            Public key (PEM)
                            <textarea
                                rows={4}
                                className={monoCls}
                                value={value.public_key ?? ''}
                                onChange={(e) => set('public_key', e.target.value)}
                                placeholder="-----BEGIN PUBLIC KEY-----"
                            />
                        </label>
                    )}
                    <label className="text-xs">
                        Expected issuer <span className="text-ink-muted">(optional)</span>
                        <input
                            className={monoCls}
                            value={value.issuer ?? ''}
                            onChange={(e) => set('issuer', e.target.value)}
                            placeholder="https://portal.corp.example"
                        />
                    </label>
                    <label className="text-xs">
                        Expected audience <span className="text-ink-muted">(optional)</span>
                        <input
                            className={monoCls}
                            value={value.audience ?? ''}
                            onChange={(e) => set('audience', e.target.value)}
                            placeholder="dataviz"
                        />
                    </label>
                </div>
            )}

            {format === 'json' && (
                <DangerToggle
                    title="Trust unsigned payloads"
                    checked={Boolean(value.trust_unsigned)}
                    onChange={(v) => set('trust_unsigned', v)}
                >
                    A plain JSON profile carries no signature, so we cannot tell
                    a real one from a forged one.{' '}
                    {BROWSER_SOURCES.includes(source) ? (
                        <>Anyone who can open the browser console can write this
                        storage key and sign in as any user, including an
                        administrator.</>
                    ) : (
                        <>Anyone who can set this cookie can sign in as any user,
                        including an administrator.</>
                    )}{' '}
                    Prefer a signed JWT unless you have no way to add one.
                    Every login through this path is recorded as{' '}
                    <code>user.sso_unsigned_accepted</code>, and the provider
                    becomes ineligible to grant platform admin roles through
                    IdP group mappings.
                </DangerToggle>
            )}

            {source === 'header' && (
                <DangerToggle
                    title="Trust proxy headers"
                    checked={Boolean(value.trusted_proxy_acknowledged)}
                    onChange={(v) => set('trusted_proxy_acknowledged', v)}
                >
                    Headers are forgeable by any client unless your proxy strips
                    this header from inbound requests before setting its own.
                    Confirm that it does — otherwise a request can name any user
                    it likes. Every login through this path is recorded as{' '}
                    <code>user.sso_header_accepted</code>, and the provider
                    becomes ineligible to grant platform admin roles through
                    IdP group mappings.
                </DangerToggle>
            )}
        </div>
    )
}

// ── The form ─────────────────────────────────────────────────────────

export function ProviderForm({
    existing, onSaved, onError, onCancel,
}: {
    /** Omit to create a new provider. */
    existing?: IdpProvider
    onSaved: () => void
    onError: (e: string) => void
    onCancel?: () => void
}) {
    const editing = existing !== undefined

    const [slug, setSlug] = useState(existing?.slug ?? '')
    const [displayName, setDisplayName] = useState(existing?.displayName ?? '')
    const [kind, setKind] = useState<IdpKind>(existing?.kind ?? 'oidc')
    const [linkingPolicy, setLinkingPolicy] = useState<LinkingPolicy>(
        existing?.linkingPolicy ?? 'strict',
    )
    const [claimMapping, setClaimMapping] = useState<ClaimMapping>(
        existing?.claimMapping ?? {},
    )
    const [emailDomains, setEmailDomains] = useState(
        (existing?.emailDomains ?? []).join(', '),
    )
    const [buttonLabel, setButtonLabel] = useState(existing?.buttonLabel ?? '')
    const [buttonIcon, setButtonIcon] = useState(existing?.buttonIcon ?? '')
    const [priority, setPriority] = useState(existing?.priority ?? 100)
    // A new provider starts disabled: creating one used to publish it to
    // every user's login page immediately, before discovery had been
    // reviewed or a dry-run had proved it works.
    const [enabled, setEnabled] = useState(existing?.enabled ?? false)
    const [profileSettings, setProfileSettings] = useState<CustomProfileSettings>(
        existing?.kind === 'custom_profile'
            ? { ...DEFAULT_CUSTOM_PROFILE_SETTINGS, ...existing.settings }
            : DEFAULT_CUSTOM_PROFILE_SETTINGS,
    )
    const [settingsJson, setSettingsJson] = useState(
        existing && existing.kind !== 'custom_profile'
            ? JSON.stringify(existing.settings, null, 2)
            : OIDC_SETTINGS_TEMPLATE,
    )
    const [busy, setBusy] = useState(false)

    const isProfile = kind === 'custom_profile'

    /** Let the operator map against the object actually sitting in their
     *  own browser, rather than a hand-typed sample. Only meaningful for
     *  a storage-backed source — a cookie may well be HttpOnly. */
    const readFromBrowser = useMemo(() => {
        const src = profileSettings.source
        const key = profileSettings.source_key
        if (!isProfile || !key || !src || !BROWSER_SOURCES.includes(src)) {
            return undefined
        }
        return () => {
            try {
                const store = src === 'session_storage'
                    ? window.sessionStorage : window.localStorage
                return store.getItem(key)
            } catch {
                return null
            }
        }
    }, [isProfile, profileSettings.source, profileSettings.source_key])

    /** Merge discovered settings into the JSON editor without clobbering
     *  anything the operator already typed — discovery supplies the fields
     *  an IdP publishes, they supply the credentials. */
    function mergeDiscovered(discovered: Record<string, unknown>) {
        let current: Record<string, unknown> = {}
        try {
            current = JSON.parse(settingsJson)
        } catch {
            // Unparseable draft: discovery is still the better starting
            // point, so replace rather than refuse.
        }
        setSettingsJson(JSON.stringify({ ...current, ...discovered }, null, 2))
    }

    async function submit(e: React.FormEvent) {
        e.preventDefault()

        let settings: Record<string, unknown>
        if (isProfile) {
            settings = cleanSettings(profileSettings as Record<string, unknown>)
        } else {
            try {
                settings = cleanSettings(JSON.parse(settingsJson))
            } catch (err) {
                onError(`JSON parse error: ${(err as Error).message}`)
                return
            }
        }

        setBusy(true)
        try {
            if (editing) {
                await ssoAdminService.updateProvider(existing.id, {
                    displayName, settings, claimMapping, linkingPolicy,
                    emailDomains: parseDomains(emailDomains),
                    buttonLabel: buttonLabel || null,
                    buttonIcon: buttonIcon || null,
                    priority, enabled,
                })
            } else {
                await ssoAdminService.createProvider({
                    slug, displayName, kind, settings, claimMapping, linkingPolicy,
                    emailDomains: parseDomains(emailDomains),
                    buttonLabel: buttonLabel || undefined,
                    buttonIcon: buttonIcon || undefined,
                    priority, enabled,
                })
            }
            onSaved()
        } catch (err) {
            onError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <form
            onSubmit={submit}
            className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3"
        >
            <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                    Slug (URL-safe)
                    <input
                        className={monoCls}
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        placeholder="entra-staff"
                        // The slug is baked into /auth/{slug}/* and into every
                        // redirect URI registered at the IdP.
                        disabled={editing}
                        required
                    />
                </label>
                <label className="text-xs">
                    Display name
                    <input
                        className={inputCls}
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Corporate Entra ID"
                        required
                    />
                </label>
                <label className="text-xs">
                    Kind
                    <select
                        className={inputCls}
                        value={kind}
                        onChange={(e) => setKind(e.target.value as IdpKind)}
                        // Changing kind would invalidate every setting and
                        // orphan the linked identities.
                        disabled={editing}
                    >
                        <option value="oidc">OIDC</option>
                        <option value="saml2">SAML 2.0</option>
                        <option value="custom_profile">
                            Custom profile (cookie / browser storage / header)
                        </option>
                        <option value="custom">Custom (dev)</option>
                    </select>
                </label>
                <label className="text-xs">
                    Linking policy
                    <select
                        className={inputCls}
                        value={linkingPolicy}
                        onChange={(e) => setLinkingPolicy(e.target.value as LinkingPolicy)}
                    >
                        <option value="strict">Strict (default)</option>
                        <option value="allow_verified">Allow verified</option>
                        <option value="manual_only">Manual only</option>
                        <option value="disabled">Disabled (no linking)</option>
                    </select>
                </label>
            </div>

            {isProfile ? (
                <CustomProfileSettingsForm
                    value={profileSettings}
                    onChange={setProfileSettings}
                />
            ) : (
                <>
                    <DiscoverPanel kind={kind} onDiscovered={mergeDiscovered} />
                    <label className="block text-xs">
                        Settings (encrypted JSON)
                        <textarea
                            className={monoCls}
                            rows={8}
                            value={settingsJson}
                            onChange={(e) => setSettingsJson(e.target.value)}
                        />
                    </label>
                </>
            )}

            {/* Login-page presentation. These four have been on the API
                since the first version and had no inputs, so the only way
                to set them was a hand-rolled PATCH. */}
            <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                    Button label <span className="text-ink-muted">(optional)</span>
                    <input
                        className={inputCls}
                        value={buttonLabel}
                        onChange={(e) => setButtonLabel(e.target.value)}
                        placeholder={displayName || 'Sign in with…'}
                    />
                </label>
                <label className="text-xs">
                    Priority
                    <input
                        className={inputCls}
                        type="number"
                        min={0}
                        max={10000}
                        value={priority}
                        onChange={(e) => setPriority(Number(e.target.value))}
                    />
                    <span className="mt-0.5 block text-[10px] text-ink-muted">
                        Login-page order, lowest first.
                    </span>
                </label>
                <label className="text-xs col-span-2">
                    Button icon <span className="text-ink-muted">(optional)</span>
                    <input
                        className={monoCls}
                        value={buttonIcon}
                        onChange={(e) => setButtonIcon(e.target.value)}
                        placeholder="data:image/svg+xml;base64,… or /static/idp/entra.svg"
                    />
                    <span className="mt-0.5 block text-[10px] text-ink-muted">
                        A <code>data:</code> URI or a path on this server. Remote
                        URLs are blocked by the app's content-security policy and
                        would render as a broken image.
                    </span>
                </label>
                <label className="flex items-center gap-2 text-xs col-span-2">
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                    />
                    <span>
                        Enabled
                        <span className="ml-1 text-ink-muted">
                            — when on, this provider appears on the login page for
                            everyone. Leave off until you've rehearsed a sign-in.
                        </span>
                    </span>
                </label>
            </div>

            <label className="block text-xs">
                Email domains <span className="text-ink-muted">(optional)</span>
                <input
                    className={monoCls}
                    value={emailDomains}
                    onChange={(e) => setEmailDomains(e.target.value)}
                    placeholder="corp.example.com, subsidiary.example"
                />
                <span className="mt-0.5 block text-[10px] text-ink-muted">
                    Routes these domains straight to this provider when
                    email-first sign-in is on (Settings tab). Ignored otherwise.
                </span>
            </label>

            <ClaimMappingEditor
                kind={kind}
                providerId={existing?.id}
                value={claimMapping}
                onChange={setClaimMapping}
                onReadFromBrowser={readFromBrowser}
            />

            <div className="flex gap-2">
                <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm disabled:opacity-50"
                >
                    {editing ? 'Save changes' : 'Create provider'}
                </button>
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-4 py-2 rounded-lg border border-white/10 text-sm text-ink-muted hover:bg-white/5"
                    >
                        Cancel
                    </button>
                )}
            </div>
        </form>
    )
}
