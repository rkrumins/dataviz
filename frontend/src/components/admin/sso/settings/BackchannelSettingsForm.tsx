/**
 * Back-channel gateway settings — the two calls we make on the user's
 * behalf, and where the token goes on each.
 *
 * Every field here exists because no two bespoke gateways agree on the
 * shape. One wants the session in a cookie, the next in an
 * `Authorization` header, the third in a JSON body under a name it
 * chose. Modelling that as configuration is what lets a second
 * enterprise be onboarded with a form rather than a release, so the
 * form is wide on purpose.
 *
 * What is deliberately NOT here: the internal host allowlist. An entry
 * there lets this deployment make a request to an address on the
 * internal network, so it lives on its own screen behind its own
 * permission rather than inside a provider's settings — a per-provider
 * allowlist would be circular anyway ("the URL you typed is
 * permitted" is not a control).
 */
import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
    DangerToggle, Field, FieldGrid, SecretField, TextAreaField, TextField,
} from './ui'

export type AmbientSource = 'cookie' | 'header'
export type SendAs = 'cookie' | 'header' | 'body'

export interface BackchannelSettings {
    exchange_mode?: 'server' | 'browser'
    token_source?: AmbientSource
    token_source_key?: string | null

    // Browser mode: the translate call the sign-in page itself makes.
    // Published to the browser, like the trigger family.
    browser_exchange_url?: string | null
    browser_exchange_method?: 'GET' | 'POST'
    browser_exchange_headers?: Record<string, string>
    browser_exchange_token_path?: string | null
    browser_exchange_body_field?: string | null

    // The browser-side sign-in trigger. Published to the sign-in page —
    // unlike everything below, which stays on the server.
    authenticate_enabled?: boolean
    // Login-page silent attempt. Off is published to the browser as
    // autoSignIn: false; absence means on.
    auto_signin?: boolean
    authenticate_url?: string | null
    authenticate_method?: 'POST' | 'GET'
    authenticate_headers?: Record<string, string>
    authenticate_token_path?: string | null

    gateway_url?: string | null
    gateway_method?: 'POST' | 'GET'
    gateway_send_as?: SendAs
    gateway_token_header?: string | null
    gateway_token_prefix?: string | null
    gateway_body_field?: string | null
    gateway_cookie_name?: string | null
    gateway_send_ambient_cookie?: boolean
    gateway_headers?: Record<string, string>
    gateway_token_path?: string | null

    exchange_url?: string | null
    exchange_method?: 'POST' | 'GET'
    exchange_send_as?: 'body' | 'header'
    exchange_body_field?: string | null
    exchange_token_header?: string | null
    exchange_token_prefix?: string | null
    exchange_headers?: Record<string, string>
    exchange_claims_path?: string | null

    claims_format?: 'json' | 'jwt'
    // Verification material — at most one of the three. The secret is
    // redacted to '********' once saved; the PEM public key is not a
    // secret and round-trips readable. trust_unsigned is the browser-
    // mode opt-out that accepts BOTH reply shapes unverified, at the
    // Unverified rating.
    jwks_url?: string | null
    jwt_public_key?: string | null
    jwt_shared_secret?: string | null
    trust_unsigned?: boolean
    jwt_issuer?: string | null
    jwt_audience?: string | null

    timeout_seconds?: number | null
    max_response_bytes?: number | null
    tls_verify?: boolean
    require_auth_time?: boolean
    map_avatar?: boolean
    trust_gateway_email?: boolean
    liveness_on_refresh?: boolean
    liveness_grace_seconds?: number | null
    liveness_url?: string | null
    [k: string]: unknown
}

export const DEFAULT_BACKCHANNEL_SETTINGS: BackchannelSettings = {
    exchange_mode: 'server',
    token_source: 'cookie',
    token_source_key: '',
    browser_exchange_url: '',
    browser_exchange_method: 'GET',
    browser_exchange_headers: {},
    browser_exchange_token_path: '',
    browser_exchange_body_field: '',
    authenticate_enabled: true,
    auto_signin: true,
    authenticate_url: '',
    authenticate_method: 'POST',
    authenticate_headers: {},
    authenticate_token_path: '',
    gateway_url: '',
    gateway_method: 'POST',
    gateway_send_as: 'cookie',
    gateway_token_header: '',
    gateway_token_prefix: '',
    gateway_body_field: '',
    gateway_headers: {},
    gateway_token_path: 'access_token',
    gateway_send_ambient_cookie: false,
    exchange_url: '',
    exchange_method: 'POST',
    exchange_send_as: 'body',
    exchange_body_field: 'token',
    exchange_token_header: 'Authorization',
    exchange_token_prefix: 'Bearer ',
    exchange_headers: {},
    exchange_claims_path: '',
    claims_format: 'json',
    jwks_url: '',
    jwt_public_key: '',
    jwt_shared_secret: '',
    trust_unsigned: false,
    jwt_issuer: '',
    jwt_audience: '',
    timeout_seconds: 5,
    max_response_bytes: 262144,
    tls_verify: true,
    require_auth_time: true,
    map_avatar: false,
    trust_gateway_email: true,
    liveness_on_refresh: true,
    liveness_grace_seconds: 900,
    liveness_url: '',
}

const selectCls =
    'w-full px-3 py-2 text-sm rounded-xl border-2 border-black/[0.10] ' +
    'dark:border-white/[0.12] bg-canvas-elevated text-ink outline-none ' +
    'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

const SOURCE_LABELS: Record<AmbientSource, string> = {
    cookie: 'Cookie on a shared parent domain',
    header: 'Request header (from a proxy)',
}

const SEND_AS_LABELS: Record<SendAs, string> = {
    cookie: 'As a cookie',
    header: 'In a header',
    body: 'In the JSON body',
}

/** Headers are arbitrary key/value pairs we cannot model as fields, so
 *  they are edited as JSON. Invalid JSON reverts to the stored value
 *  rather than clearing it — a half-typed object is not an instruction
 *  to delete the headers.
 *
 *  Controlled: an outside change to the settings (the Advanced JSON
 *  editor, a reset) shows up here, instead of the textarea keeping
 *  whatever it rendered first. A draft the operator is mid-typing wins
 *  until blur.
 *
 *  A redacted value — the API replaces a saved secret dict with a
 *  masked string — renders as a "Configured" panel with an explicit
 *  Replace affordance. It used to render the mask itself inside the
 *  textarea, which read as data loss and invited saving it back. */
function HeaderMapField({
    label, hint, value, onChange,
}: {
    label: string
    hint?: React.ReactNode
    value: Record<string, string> | string | undefined
    onChange: (next: Record<string, string>) => void
}) {
    const [draft, setDraft] = useState<string | null>(null)
    const [replacing, setReplacing] = useState(false)
    const redacted = typeof value === 'string'
    const canonical = JSON.stringify(redacted ? {} : (value ?? {}), null, 2)

    if (redacted && !replacing) {
        return (
            <Field label={label} hint={hint}>
                <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated">
                    <span className="text-sm text-ink-muted">
                        Configured — hidden after saving.
                    </span>
                    <button
                        type="button"
                        onClick={() => { setReplacing(true); setDraft('{\n  \n}') }}
                        className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                    >
                        Replace
                    </button>
                </div>
            </Field>
        )
    }

    return (
        <Field label={label} hint={hint}>
            <TextAreaField
                rows={4}
                value={draft ?? canonical}
                onChange={e => setDraft(e.target.value)}
                onBlur={e => {
                    try {
                        const parsed = JSON.parse(e.target.value || '{}')
                        if (parsed && typeof parsed === 'object'
                            && !Array.isArray(parsed)) {
                            onChange(parsed as Record<string, string>)
                        }
                    } catch {
                        /* revert to what is stored; see the note above */
                    }
                    setDraft(null)
                }}
                placeholder={'{\n  "X-App-Id": "your-app-id"\n}'}
            />
        </Field>
    )
}

function Toggle({
    label, hint, checked, onChange,
}: {
    label: string
    hint: React.ReactNode
    checked: boolean
    onChange: (next: boolean) => void
}) {
    return (
        <label className="flex gap-3 items-start cursor-pointer">
            <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-indigo-500"
                checked={checked}
                onChange={e => onChange(e.target.checked)}
            />
            <span>
                <span className="text-sm text-ink">{label}</span>
                <span className="block text-[11px] text-ink-muted leading-relaxed">
                    {hint}
                </span>
            </span>
        </label>
    )
}

type VerifyChoice =
    | 'none' | 'jwks' | 'public_key' | 'shared_secret' | 'unsigned'

/** Which verification material is populated on the row. Populated
 *  fields always win over a not-yet-typed local choice, so the chooser
 *  can never disagree with what the server will actually use. A saved
 *  secret arrives as the redaction mask, which counts as populated. */
function populatedVerifyChoice(value: BackchannelSettings): VerifyChoice | null {
    if (value.trust_unsigned) return 'unsigned'
    if ((value.jwt_shared_secret ?? '') !== '') return 'shared_secret'
    if ((value.jwt_public_key ?? '').trim()) return 'public_key'
    if ((value.jwks_url ?? '').trim()) return 'jwks'
    return null
}

/** One way to judge the token, chosen from what the gateway can offer:
 *  their published keys, a pasted public key when they sign but publish
 *  none, or a shared secret for symmetric gateways. Server mode may
 *  also choose none — the TLS call it made is its own authentication —
 *  which browser mode must not, because the token arrives from the
 *  user's browser there. */
function VerifyMaterialChooser({
    value, set, onChange, allowNone,
}: {
    value: BackchannelSettings
    set: <K extends keyof BackchannelSettings>(
        k: K, v: BackchannelSettings[K],
    ) => void
    onChange: (next: BackchannelSettings) => void
    allowNone: boolean
}) {
    const populated = populatedVerifyChoice(value)
    const [chosen, setChosen] = useState<VerifyChoice>(
        populated ?? (allowNone ? 'none' : 'jwks'),
    )
    const choice = populated ?? chosen

    const switchTo = (next: VerifyChoice) => {
        setChosen(next)
        // Null out the other materials in one update: the server merge
        // deletes null keys, so abandoned material cannot linger and
        // win the populated-field derivation on the next open. The
        // danger bit clears the same way when leaving unsigned; it is
        // never SET here — only the toggle below may do that.
        const cleared: BackchannelSettings = { ...value }
        if (next !== 'jwks') cleared.jwks_url = null
        if (next !== 'public_key') cleared.jwt_public_key = null
        if (next !== 'shared_secret') cleared.jwt_shared_secret = null
        if (next !== 'unsigned') cleared.trust_unsigned = null as never
        if (next === 'unsigned') {
            // Pins would pin nothing without a verified signature.
            cleared.jwt_issuer = null
            cleared.jwt_audience = null
        }
        onChange(cleared)
    }

    return (
        <>
            <Field
                label={allowNone ? 'Signature check' : 'Verify the token with'}
                required={!allowNone}
                hint={allowNone
                    ? 'None accepts the token on the strength of the TLS call that fetched it, exactly like the JSON shape.'
                    : 'A token the browser delivers is only as good as its signature, so one of these is required.'}
            >
                <select
                    className={selectCls}
                    value={choice}
                    onChange={e => switchTo(e.target.value as VerifyChoice)}
                >
                    {allowNone && (
                        <option value="none">None — trust the TLS answer</option>
                    )}
                    <option value="jwks">Their published keys (JWKS URL)</option>
                    <option value="public_key">A pasted public key (PEM)</option>
                    <option value="shared_secret">A shared secret (HS256)</option>
                    {!allowNone && (
                        <option value="unsigned">
                            Nothing — trust it unverified
                        </option>
                    )}
                </select>
            </Field>
            {!allowNone && (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                    Their published keys, a pasted key and a shared secret
                    all keep this connection rated <strong>Verified</strong>.
                    Trusting unverified replies rates it{' '}
                    <strong>Unverified</strong>, and it can no longer grant
                    platform admin roles.
                </p>
            )}

            {choice === 'jwks' && (
                <Field
                    label="JWKS URL"
                    required
                    hint="Their published signing keys. Internal hosts need an allowlist entry."
                >
                    <TextField
                        value={value.jwks_url ?? ''}
                        onChange={e => set(
                            'jwks_url',
                            (e.target.value === '' ? null : e.target.value) as never,
                        )}
                        placeholder="https://sso.corporate.com/.well-known/jwks.json"
                    />
                </Field>
            )}
            {choice === 'public_key' && (
                <Field
                    label="Public key (PEM)"
                    required
                    hint="For a gateway that signs its tokens but publishes no key set — paste the PEM public key their team hands you. Same trust as a JWKS; asymmetric algorithms only."
                >
                    <TextAreaField
                        rows={4}
                        value={value.jwt_public_key ?? ''}
                        onChange={e => set(
                            'jwt_public_key',
                            (e.target.value === '' ? null : e.target.value) as never,
                        )}
                        placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'}
                    />
                </Field>
            )}
            {choice === 'shared_secret' && (
                <SecretField
                    label="Shared secret"
                    required
                    hint="The gateway signs with this same secret — HS256, pinned to exactly that algorithm. Stored encrypted and never shown again once saved."
                    value={value.jwt_shared_secret ?? ''}
                    onChange={v => set('jwt_shared_secret', v as never)}
                    placeholder="the signing secret their team hands you"
                />
            )}
            {choice === 'unsigned' && (
                <DangerToggle
                    title="Trust unverified sign-ins"
                    checked={Boolean(value.trust_unsigned)}
                    onChange={v => set('trust_unsigned', v as never)}
                >
                    The reply is accepted with <strong>no verification at
                    all</strong> — a signed token&rsquo;s signature is not
                    even checked, and a bare JSON object is accepted the
                    same way. Anyone who can reach the sign-in page and
                    post a reply can sign in as <strong>any user,
                    including an administrator&rsquo;s account</strong>.
                    Every such login is recorded as{' '}
                    <code>user.sso_unsigned_accepted</code>, the connection
                    is rated <strong>Unverified</strong>, and it becomes
                    ineligible to grant platform admin roles through IdP
                    group mappings. Prefer a signed token — this posture
                    exists for gateways whose reply shape varies by
                    environment, and it is the one row that accepts both
                    shapes.
                </DangerToggle>
            )}

            {choice !== 'none' && choice !== 'unsigned' && (
                <FieldGrid>
                    <Field
                        label={<>Issuer pin <span className="font-normal text-ink-muted">(optional)</span></>}
                        hint={<>Refuse tokens whose <code>iss</code> differs.</>}
                    >
                        <TextField
                            value={value.jwt_issuer ?? ''}
                            onChange={e => set(
                                'jwt_issuer',
                                (e.target.value === '' ? null : e.target.value) as never,
                            )}
                            placeholder="https://sso.corporate.com"
                        />
                    </Field>
                    <Field
                        label={<>Audience pin <span className="font-normal text-ink-muted">(optional)</span></>}
                        hint={<>Refuse tokens whose <code>aud</code> differs.</>}
                    >
                        <TextField
                            value={value.jwt_audience ?? ''}
                            onChange={e => set(
                                'jwt_audience',
                                (e.target.value === '' ? null : e.target.value) as never,
                            )}
                            placeholder="dataviz"
                        />
                    </Field>
                </FieldGrid>
            )}
        </>
    )
}

export function BackchannelSettingsForm({
    value, onChange,
}: {
    value: BackchannelSettings
    onChange: (next: BackchannelSettings) => void
}) {
    const source = value.token_source ?? 'cookie'
    const mode = value.exchange_mode ?? 'server'
    const gatewaySendAs = value.gateway_send_as ?? 'cookie'
    const exchangeSendAs = value.exchange_send_as ?? 'body'
    const hasExchange = Boolean((value.exchange_url ?? '').trim())
    const hasTrigger = Boolean((value.authenticate_url ?? '').trim())
    const set = <K extends keyof BackchannelSettings>(
        k: K, v: BackchannelSettings[K],
    ) => onChange({ ...value, [k]: v })
    // '' -> null. The save path drops empty strings as "unchanged" (so a
    // redaction mask can never be written back), which made clearing a
    // field a silent no-op — the old value survived every save. null
    // survives to the server, which reads it as "remove the key", and
    // the default comes back.
    const clearable = (e: React.ChangeEvent<HTMLInputElement>) =>
        (e.target.value === '' ? null : e.target.value) as never
    // Same for the numeric fields, which also used to save NaN when the
    // box was cleared.
    const numeric = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.value === '') return null as never
        const n = Number(e.target.value)
        return (Number.isFinite(n) ? n : null) as never
    }

    return (
        <div className="space-y-6">
            {/* ── where the exchange runs ── */}
            <section className="space-y-3">
                <Field
                    label="Who redeems the corporate session"
                    hint="Our server can only redeem a cookie the browser sends us — one set on a parent domain this app shares. If the cookie is scoped to the SSO host alone, only the user's browser can present it, so the browser makes the translate call and hands us the signed result."
                >
                    <select
                        className={selectCls}
                        value={mode}
                        onChange={e => set('exchange_mode', e.target.value as 'server' | 'browser')}
                    >
                        <option value="server">
                            Our server — the cookie is on a shared domain
                        </option>
                        <option value="browser">
                            The browser — the cookie never reaches us
                        </option>
                    </select>
                </Field>
            </section>

            {/* ── the ambient token ── */}
            {mode === 'server' && (
            <section className="space-y-3">
                <p className="text-[11px] text-ink-muted leading-relaxed">
                    The token the enterprise portal has already left on the
                    browser. It is the only thing the browser contributes:
                    we never read what is inside it, we hand it straight
                    back to the provider that issued it.
                </p>
                <FieldGrid>
                    <Field label="Ambient token lives in">
                        <select
                            className={selectCls}
                            value={source}
                            onChange={e => set('token_source', e.target.value as AmbientSource)}
                        >
                            {(Object.keys(SOURCE_LABELS) as AmbientSource[]).map(s => (
                                <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                            ))}
                        </select>
                    </Field>
                    <Field
                        label={source === 'header' ? 'Header name' : 'Cookie name'}
                        required={!value.authenticate_token_path}
                    >
                        <TextField
                            value={value.token_source_key ?? ''}
                            onChange={e => set('token_source_key', clearable(e))}
                            placeholder={source === 'header' ? 'X-Corp-Session' : 'CORPSESSION'}
                        />
                    </Field>
                </FieldGrid>
            </section>
            )}

            {/* ── the browser-side trigger ── */}
            <section className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">
                    Sign-in trigger <span className="font-normal text-ink-muted">(optional)</span>
                </h4>
                <p className="text-[11px] text-ink-muted leading-relaxed">
                    Leave blank if people already have a session with your
                    provider by the time they reach us. Fill it in when
                    something has to ask for one first — Kerberos being the
                    usual case, where the provider challenges the browser
                    and the browser answers from the workstation&rsquo;s own
                    login. <strong>That call is made by the browser, not by
                    us</strong>, because only the browser can reach the
                    machine&rsquo;s credentials.
                </p>
                <Field
                    label={<>Authenticate URL <span className="font-normal text-ink-muted">(optional)</span></>}
                >
                    <TextField
                        value={value.authenticate_url ?? ''}
                        onChange={e => set('authenticate_url', clearable(e))}
                        placeholder="https://sso.corp.example/authenticate"
                    />
                </Field>
                {hasTrigger && (
                    <>
                        <Toggle
                            label="Run this call when people sign in"
                            hint="Turn it off to stop the call without losing what you have configured here — during an incident, or to check that the ordinary sign-in form still works. While it is off, nothing about this section reaches anyone's browser."
                            checked={value.authenticate_enabled !== false}
                            onChange={v => set('authenticate_enabled', v)}
                        />
                        <FieldGrid>
                            <Field label="Method">
                                <select
                                    className={selectCls}
                                    value={value.authenticate_method ?? 'POST'}
                                    onChange={e => set('authenticate_method', e.target.value as 'POST' | 'GET')}
                                >
                                    <option value="POST">POST</option>
                                    <option value="GET">GET</option>
                                </select>
                            </Field>
                            <Field
                                label={<>Token is at <span className="font-normal text-ink-muted">(optional)</span></>}
                                hint={mode === 'browser'
                                    ? 'Where the token sits in this call’s reply — it is forwarded to the translate call when a body field is named below.'
                                    : 'Only if this call answers with the session token itself. Leave blank when it works by setting a cookie.'}
                            >
                                <TextField
                                    value={value.authenticate_token_path ?? ''}
                                    onChange={e => set('authenticate_token_path', clearable(e))}
                                    placeholder="token"
                                />
                            </Field>
                        </FieldGrid>

                        <div className={cn(
                            "p-3 rounded-xl border border-amber-500/30 bg-amber-500/5",
                            value.authenticate_enabled === false && "opacity-50",
                        )}>
                            <p className="text-[11px] text-amber-300 leading-relaxed">
                                <strong>These headers are sent from the
                                user&rsquo;s browser and are readable by
                                anyone who opens the sign-in page.</strong>{' '}
                                They are not the same as the two header
                                fields below, which stay on our server and
                                are hidden once saved. Put an application
                                identifier here; never a credential you
                                would mind publishing.
                            </p>
                            <div className="mt-2">
                                <HeaderMapField
                                    label="Headers"
                                    value={value.authenticate_headers}
                                    onChange={v => set('authenticate_headers', v)}
                                />
                            </div>
                        </div>
                    </>
                )}
            </section>

            {/* ── leg 1 ── */}
            {mode === 'server' && (
            <section className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">
                    Step 1 — redeem the ambient token
                </h4>
                <Field
                    label="Gateway URL"
                    required
                    hint={<>An internal address is unreachable until its host is on the allowlist &mdash; <strong>Settings &rarr; Internal gateways SSO may call</strong>. That list is managed under its own permission, so you may need someone else to add it.</>}
                >
                    <TextField
                        value={value.gateway_url ?? ''}
                        onChange={e => set('gateway_url', clearable(e))}
                        placeholder="https://sso-gateway.corp.internal/token"
                    />
                </Field>
                <FieldGrid>
                    <Field label="Method">
                        <select
                            className={selectCls}
                            value={value.gateway_method ?? 'POST'}
                            onChange={e => set('gateway_method', e.target.value as 'POST' | 'GET')}
                        >
                            <option value="POST">POST</option>
                            <option value="GET">GET</option>
                        </select>
                    </Field>
                    <Field label="Present the ambient token">
                        <select
                            className={selectCls}
                            value={gatewaySendAs}
                            onChange={e => set('gateway_send_as', e.target.value as SendAs)}
                        >
                            {(Object.keys(SEND_AS_LABELS) as SendAs[]).map(s => (
                                <option key={s} value={s}>{SEND_AS_LABELS[s]}</option>
                            ))}
                        </select>
                    </Field>
                </FieldGrid>

                {gatewaySendAs === 'header' && (
                    <FieldGrid>
                        <Field label="Header name" required>
                            <TextField
                                value={value.gateway_token_header ?? ''}
                                onChange={e => set('gateway_token_header', clearable(e))}
                                placeholder="Authorization"
                            />
                        </Field>
                        <Field label={<>Value prefix <span className="font-normal text-ink-muted">(optional)</span></>}>
                            <TextField
                                value={value.gateway_token_prefix ?? ''}
                                onChange={e => set('gateway_token_prefix', clearable(e))}
                                placeholder="Bearer "
                            />
                        </Field>
                    </FieldGrid>
                )}
                {gatewaySendAs === 'body' && (
                    <Field label="Body field name" required>
                        <TextField
                            value={value.gateway_body_field ?? ''}
                            onChange={e => set('gateway_body_field', clearable(e))}
                            placeholder="sessionId"
                        />
                    </Field>
                )}
                {gatewaySendAs === 'cookie' && (
                    <Field
                        label={<>Send it under a different cookie name <span className="font-normal text-ink-muted">(optional)</span></>}
                        hint={<>Leave blank and we send it as <code>{value.token_source_key || 'the name above'}</code>, the name we read it from. Fill this in only when the gateway expects a different one.</>}
                    >
                        <TextField
                            value={value.gateway_cookie_name ?? ''}
                            onChange={e => set('gateway_cookie_name', clearable(e))}
                            placeholder={value.token_source_key || 'CORPSESSION'}
                        />
                    </Field>
                )}

                <FieldGrid>
                    <Field
                        label="Token is at"
                        required
                        hint={<>Where the token sits in the response. Dotted paths work: <code>data.token</code>.</>}
                    >
                        <TextField
                            value={value.gateway_token_path ?? ''}
                            onChange={e => set('gateway_token_path', clearable(e))}
                            placeholder="access_token"
                        />
                    </Field>
                </FieldGrid>

                {gatewaySendAs !== 'cookie' && (
                    <Toggle
                        label="Also send the session as a cookie"
                        hint="For a gateway that authenticates the caller by cookie and still expects the token in the body or a header. The cookie says who is asking; the body says what is being redeemed, and they are not the same question."
                        checked={value.gateway_send_ambient_cookie === true}
                        onChange={v => set('gateway_send_ambient_cookie', v)}
                    />
                )}

                <HeaderMapField
                    label="Extra headers"
                    hint="Sent on every gateway call. Application id, secret, correlation headers. Redacted after saving."
                    value={value.gateway_headers}
                    onChange={v => set('gateway_headers', v)}
                />

            </section>
            )}

            {/* ── leg 2 ── */}
            {mode === 'server' && (
            <section className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">
                    Step 2 — exchange it for the user&rsquo;s details
                </h4>
                <Field
                    label={<>Exchange URL <span className="font-normal text-ink-muted">(optional)</span></>}
                    hint="Leave blank if the gateway already answers with the user's details — that skips a round trip."
                >
                    <TextField
                        value={value.exchange_url ?? ''}
                        onChange={e => set('exchange_url', clearable(e))}
                        placeholder="https://sso-gateway.corp.internal/userinfo"
                    />
                </Field>

                {hasExchange && (
                    <>
                        <FieldGrid>
                            <Field label="Method">
                                <select
                                    className={selectCls}
                                    value={value.exchange_method ?? 'POST'}
                                    onChange={e => set('exchange_method', e.target.value as 'POST' | 'GET')}
                                >
                                    <option value="POST">POST</option>
                                    <option value="GET">GET</option>
                                </select>
                            </Field>
                            <Field label="Present the token">
                                <select
                                    className={selectCls}
                                    value={exchangeSendAs}
                                    onChange={e => set('exchange_send_as', e.target.value as 'body' | 'header')}
                                >
                                    <option value="body">In the JSON body</option>
                                    <option value="header">In a header</option>
                                </select>
                            </Field>
                        </FieldGrid>
                        {exchangeSendAs === 'body' ? (
                            <Field label="Body field name" required>
                                <TextField
                                    value={value.exchange_body_field ?? ''}
                                    onChange={e => set('exchange_body_field', clearable(e))}
                                    placeholder="token"
                                />
                            </Field>
                        ) : (
                            <FieldGrid>
                                <Field label="Header name" required>
                                    <TextField
                                        value={value.exchange_token_header ?? ''}
                                        onChange={e => set('exchange_token_header', clearable(e))}
                                        placeholder="Authorization"
                                    />
                                </Field>
                                <Field label={<>Value prefix <span className="font-normal text-ink-muted">(optional)</span></>}>
                                    <TextField
                                        value={value.exchange_token_prefix ?? ''}
                                        onChange={e => set('exchange_token_prefix', clearable(e))}
                                        placeholder="Bearer "
                                    />
                                </Field>
                            </FieldGrid>
                        )}
                        <HeaderMapField
                            label="Extra headers"
                            hint="Sent on every exchange call. Redacted after saving."
                            value={value.exchange_headers}
                            onChange={v => set('exchange_headers', v)}
                        />
                    </>
                )}

                <Field
                    label={<>User details are at <span className="font-normal text-ink-muted">(optional)</span></>}
                    hint={<>Blank means the whole response body. Dotted paths work: <code>response.user</code>.</>}
                >
                    <TextField
                        value={value.exchange_claims_path ?? ''}
                        onChange={e => set('exchange_claims_path', clearable(e))}
                        placeholder="data.user"
                    />
                </Field>

                <Field
                    label="The details arrive as"
                    hint="Some gateways answer with a signed token (JWT) instead of a plain user object — the details are the token's payload. Applies to whichever call carries the details: the exchange, or the gateway itself when there is no exchange."
                >
                    <select
                        className={selectCls}
                        value={value.claims_format ?? 'json'}
                        onChange={e => set('claims_format', e.target.value as 'json' | 'jwt')}
                    >
                        <option value="json">A JSON user object</option>
                        <option value="jwt">A signed token (JWT) carrying the user object</option>
                    </select>
                </Field>

                {(value.claims_format ?? 'json') === 'jwt' && (
                    <VerifyMaterialChooser
                        value={value}
                        set={set}
                        onChange={onChange}
                        allowNone
                    />
                )}
            </section>
            )}

            {/* ── the browser-side exchange ── */}
            {mode === 'browser' && (
            <section className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">
                    The translate call the browser makes
                </h4>
                <p className="text-[11px] text-ink-muted leading-relaxed">
                    The corporate cookie only reaches its own host, so the
                    sign-in page calls the translate endpoint itself — the
                    browser&rsquo;s cookie jar does what ours cannot — and
                    hands us the reply. How much that reply is worth is
                    decided below: verified against a key, or — as an
                    explicit last resort — trusted as-is. Either way, each
                    reply signs in at most once.
                </p>
                <Field label="Translate URL" required>
                    <TextField
                        value={value.browser_exchange_url ?? ''}
                        onChange={e => set('browser_exchange_url', clearable(e))}
                        placeholder="https://sso.corporate.com/auth-service/translate"
                    />
                </Field>
                <FieldGrid>
                    <Field label="Method">
                        <select
                            className={selectCls}
                            value={value.browser_exchange_method ?? 'GET'}
                            onChange={e => set('browser_exchange_method', e.target.value as 'GET' | 'POST')}
                        >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                        </select>
                    </Field>
                    <Field
                        label={<>Token is at <span className="font-normal text-ink-muted">(optional)</span></>}
                        hint={<>Where the token sits in their JSON reply. Blank means the reply body <em>is</em> the token.</>}
                    >
                        <TextField
                            value={value.browser_exchange_token_path ?? ''}
                            onChange={e => set('browser_exchange_token_path', clearable(e))}
                            placeholder="token"
                        />
                    </Field>
                </FieldGrid>
                <Field
                    label={<>Send the sign-in call&rsquo;s token in the body <span className="font-normal text-ink-muted">(optional)</span></>}
                    hint={<>Some translate endpoints require the token the
                        sign-in call answered with, POSTed back as
                        JSON — <code>{'{"token": "…"}'}</code>. Name that
                        JSON field here; it needs the trigger&rsquo;s{' '}
                        <em>Token is at</em> path filled in and the method
                        above set to POST. Leave blank when the corporate
                        cookie alone is enough. Switching the trigger off
                        breaks sign-in for this shape.</>}
                >
                    <TextField
                        value={value.browser_exchange_body_field ?? ''}
                        onChange={e => set('browser_exchange_body_field', clearable(e))}
                        placeholder="token"
                    />
                </Field>
                <div className="rounded-xl border-2 border-amber-500/30 bg-amber-500/[0.06] p-3 space-y-3">
                    <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                        These headers are sent from the user&rsquo;s browser
                        and are readable by anyone who opens the sign-in
                        page. Put an application identifier here; never a
                        credential you would mind publishing.
                    </p>
                    <HeaderMapField
                        label="Headers"
                        hint="Sent on the browser's translate call."
                        value={value.browser_exchange_headers}
                        onChange={v => set('browser_exchange_headers', v)}
                    />
                </div>

                <h4 className="text-xs font-semibold text-ink">
                    Verifying what comes back
                </h4>
                <VerifyMaterialChooser
                    value={value}
                    set={set}
                    onChange={onChange}
                    allowNone={false}
                />
            </section>
            )}

            {/* ── behaviour ── */}
            <section className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">Behaviour</h4>
                <FieldGrid>
                    <Field label="Timeout (seconds)">
                        <TextField
                            type="number"
                            min={1}
                            mono={false}
                            value={value.timeout_seconds == null ? '' : String(value.timeout_seconds)}
                            placeholder="5"
                            onChange={e => set('timeout_seconds', numeric(e))}
                        />
                    </Field>
                    <Field
                        label="Response size limit (bytes)"
                        hint="A cap on what either endpoint may return. A user record is small; this is here so a misbehaving gateway cannot exhaust the server."
                    >
                        <TextField
                            type="number"
                            min={1}
                            mono={false}
                            value={value.max_response_bytes == null ? '' : String(value.max_response_bytes)}
                            placeholder="262144"
                            onChange={e => set('max_response_bytes', numeric(e))}
                        />
                    </Field>
                    {mode === 'server' && (
                    <Field
                        label="Outage grace (seconds)"
                        hint="How long sign-ins survive a gateway that has stopped answering. Measured from the last successful check, not from the last attempt."
                    >
                        <TextField
                            type="number"
                            min={0}
                            mono={false}
                            value={value.liveness_grace_seconds == null ? '' : String(value.liveness_grace_seconds)}
                            placeholder="900"
                            onChange={e => set('liveness_grace_seconds', numeric(e))}
                        />
                    </Field>
                    )}
                </FieldGrid>

                <DangerToggle
                    title="Skip TLS verification for this connection"
                    checked={value.tls_verify === false}
                    onChange={v => set('tls_verify', (!v) as never)}
                >
                    Every server-side call this connection makes — the
                    gateway, the exchange, the session re-check, a JWKS
                    fetch — will accept <strong>any</strong> TLS answer.
                    Anyone between this server and your gateway can then
                    answer as the gateway and <strong>forge sign-ins as
                    any user</strong>. The connection is rated{' '}
                    <strong>Unverified</strong> unless its replies are
                    signed tokens checked against a pasted key or shared
                    secret, and an Unverified connection cannot grant
                    platform admin roles. If the gateway&rsquo;s TLS is
                    signed by your corporate CA, mount that CA bundle and
                    point <code>SSO_OUTBOUND_TLS_CA_CERTS</code> at it
                    instead — that is the supported path.
                </DangerToggle>

                {mode === 'server' ? (
                    <>
                        <Toggle
                            label="Re-check with the provider on every session renewal"
                            hint="Ends the session here when the enterprise session ends there, instead of letting it run on for the rest of its own lifetime. Costs one call per signed-in person each time their session renews."
                            checked={value.liveness_on_refresh !== false}
                            onChange={v => set('liveness_on_refresh', v)}
                        />
                        <Field
                            label={<>Re-check URL <span className="font-normal text-ink-muted">(optional)</span></>}
                            hint="A cheaper validate-only endpoint for that re-check, if their team provides one — same call, aimed here instead of the gateway, so renewals stop minting a token apiece. Blank re-checks against the Gateway URL."
                        >
                            <TextField
                                value={value.liveness_url ?? ''}
                                onChange={e => set('liveness_url', clearable(e))}
                                placeholder="https://sso-gateway.corp.internal/validate"
                            />
                        </Field>
                    </>
                ) : (
                    <p className="text-[11px] text-ink-muted leading-relaxed">
                        There is no re-check in this mode — the corporate
                        session never reaches our server. Sessions end when
                        the translate token they signed in with expires,
                        and the sign-in page silently repeats the exchange.
                    </p>
                )}
                <Toggle
                    label="Require an authentication time in the user details"
                    hint="Without one there is no way to tell how long ago someone actually signed in, and the daily re-authentication ceiling stops applying to them."
                    checked={value.require_auth_time !== false}
                    onChange={v => set('require_auth_time', v)}
                />
                <Toggle
                    label="Treat the gateway's email addresses as verified"
                    hint="Applies only when their reply carries no email_verified claim at all — corporate gateways rarely send one, and without this the linking policy refuses to attach the sign-in to an existing account with the same address. An explicit false from the gateway is always respected."
                    checked={value.trust_gateway_email !== false}
                    onChange={v => set('trust_gateway_email', v)}
                />
                <Toggle
                    label="Sign people in automatically"
                    hint="Applies to the sign-in page only: on, the page attempts this connection silently when it is the one that can; off, it waits for the button. Signing out always requires a fresh click in that tab either way, and mid-session renewals — the re-certification ceiling included — are unaffected."
                    checked={value.auto_signin !== false}
                    onChange={v => set('auto_signin', v)}
                />
                <Toggle
                    label="Map their avatar from the claims"
                    hint="Off by default. On, the server fetches the picture at the mapped avatar URL during sign-in and re-serves it from here — browsers never load it directly. The image host must be listed first: an external site under Settings → Avatar image hosts, a private one on the internal-hosts allowlist. While on, the avatar is a provider-managed profile field; turning it off stops asserting it, and any stored image remains until the identity is unlinked or the person picks their own."
                    checked={value.map_avatar === true}
                    onChange={v => set('map_avatar', v)}
                />
            </section>
        </div>
    )
}
