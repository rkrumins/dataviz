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
import { Field, FieldGrid, TextAreaField, TextField } from './ui'

export type AmbientSource = 'cookie' | 'header'
export type SendAs = 'cookie' | 'header' | 'body'

export interface BackchannelSettings {
    token_source?: AmbientSource
    token_source_key?: string

    gateway_url?: string
    gateway_method?: 'POST' | 'GET'
    gateway_send_as?: SendAs
    gateway_token_header?: string
    gateway_token_prefix?: string
    gateway_body_field?: string
    gateway_cookie_name?: string
    gateway_headers?: Record<string, string>
    gateway_token_path?: string

    exchange_url?: string
    exchange_method?: 'POST' | 'GET'
    exchange_send_as?: 'body' | 'header'
    exchange_body_field?: string
    exchange_token_header?: string
    exchange_token_prefix?: string
    exchange_headers?: Record<string, string>
    exchange_claims_path?: string

    timeout_seconds?: number
    max_response_bytes?: number
    require_auth_time?: boolean
    liveness_on_refresh?: boolean
    liveness_grace_seconds?: number
    [k: string]: unknown
}

export const DEFAULT_BACKCHANNEL_SETTINGS: BackchannelSettings = {
    token_source: 'cookie',
    token_source_key: '',
    gateway_url: '',
    gateway_method: 'POST',
    gateway_send_as: 'cookie',
    gateway_token_header: '',
    gateway_token_prefix: '',
    gateway_body_field: '',
    gateway_headers: {},
    gateway_token_path: 'access_token',
    exchange_url: '',
    exchange_method: 'POST',
    exchange_send_as: 'body',
    exchange_body_field: 'token',
    exchange_token_header: 'Authorization',
    exchange_token_prefix: 'Bearer ',
    exchange_headers: {},
    exchange_claims_path: '',
    timeout_seconds: 5,
    max_response_bytes: 262144,
    require_auth_time: true,
    liveness_on_refresh: true,
    liveness_grace_seconds: 900,
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
 *  they are edited as JSON. Invalid JSON leaves the stored value alone
 *  rather than clearing it — a half-typed object is not an instruction
 *  to delete the headers. */
function HeaderMapField({
    label, hint, value, onChange,
}: {
    label: string
    hint?: React.ReactNode
    value: Record<string, string> | undefined
    onChange: (next: Record<string, string>) => void
}) {
    const text = JSON.stringify(value ?? {}, null, 2)
    return (
        <Field label={label} hint={hint}>
            <TextAreaField
                rows={4}
                defaultValue={text}
                onBlur={e => {
                    try {
                        const parsed = JSON.parse(e.target.value || '{}')
                        if (parsed && typeof parsed === 'object'
                            && !Array.isArray(parsed)) {
                            onChange(parsed as Record<string, string>)
                        }
                    } catch {
                        /* keep what is stored; see the note above */
                    }
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

export function BackchannelSettingsForm({
    value, onChange,
}: {
    value: BackchannelSettings
    onChange: (next: BackchannelSettings) => void
}) {
    const source = value.token_source ?? 'cookie'
    const gatewaySendAs = value.gateway_send_as ?? 'cookie'
    const exchangeSendAs = value.exchange_send_as ?? 'body'
    const hasExchange = Boolean((value.exchange_url ?? '').trim())
    const set = <K extends keyof BackchannelSettings>(
        k: K, v: BackchannelSettings[K],
    ) => onChange({ ...value, [k]: v })

    return (
        <div className="space-y-6">
            {/* ── the ambient token ── */}
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
                        required
                    >
                        <TextField
                            value={value.token_source_key ?? ''}
                            onChange={e => set('token_source_key', e.target.value)}
                            placeholder={source === 'header' ? 'X-Corp-Session' : 'CORPSESSION'}
                        />
                    </Field>
                </FieldGrid>
            </section>

            {/* ── leg 1 ── */}
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
                        onChange={e => set('gateway_url', e.target.value)}
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
                                onChange={e => set('gateway_token_header', e.target.value)}
                                placeholder="Authorization"
                            />
                        </Field>
                        <Field label={<>Value prefix <span className="font-normal text-ink-muted">(optional)</span></>}>
                            <TextField
                                value={value.gateway_token_prefix ?? ''}
                                onChange={e => set('gateway_token_prefix', e.target.value)}
                                placeholder="Bearer "
                            />
                        </Field>
                    </FieldGrid>
                )}
                {gatewaySendAs === 'body' && (
                    <Field label="Body field name" required>
                        <TextField
                            value={value.gateway_body_field ?? ''}
                            onChange={e => set('gateway_body_field', e.target.value)}
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
                            onChange={e => set('gateway_cookie_name', e.target.value)}
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
                            onChange={e => set('gateway_token_path', e.target.value)}
                            placeholder="access_token"
                        />
                    </Field>
                </FieldGrid>

                <HeaderMapField
                    label="Extra headers"
                    hint="Sent on every gateway call. Application id, secret, correlation headers. Redacted after saving."
                    value={value.gateway_headers}
                    onChange={v => set('gateway_headers', v)}
                />
            </section>

            {/* ── leg 2 ── */}
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
                        onChange={e => set('exchange_url', e.target.value)}
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
                                    onChange={e => set('exchange_body_field', e.target.value)}
                                    placeholder="token"
                                />
                            </Field>
                        ) : (
                            <FieldGrid>
                                <Field label="Header name" required>
                                    <TextField
                                        value={value.exchange_token_header ?? ''}
                                        onChange={e => set('exchange_token_header', e.target.value)}
                                        placeholder="Authorization"
                                    />
                                </Field>
                                <Field label={<>Value prefix <span className="font-normal text-ink-muted">(optional)</span></>}>
                                    <TextField
                                        value={value.exchange_token_prefix ?? ''}
                                        onChange={e => set('exchange_token_prefix', e.target.value)}
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
                        onChange={e => set('exchange_claims_path', e.target.value)}
                        placeholder="data.user"
                    />
                </Field>
            </section>

            {/* ── behaviour ── */}
            <section className="space-y-3">
                <h4 className="text-xs font-semibold text-ink">Behaviour</h4>
                <FieldGrid>
                    <Field label="Timeout (seconds)">
                        <TextField
                            type="number"
                            min={1}
                            mono={false}
                            value={String(value.timeout_seconds ?? 5)}
                            onChange={e => set('timeout_seconds', Number(e.target.value))}
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
                            value={String(value.max_response_bytes ?? 262144)}
                            onChange={e => set('max_response_bytes', Number(e.target.value))}
                        />
                    </Field>
                    <Field
                        label="Outage grace (seconds)"
                        hint="How long sign-ins survive a gateway that has stopped answering. Measured from the last successful check, not from the last attempt."
                    >
                        <TextField
                            type="number"
                            min={0}
                            mono={false}
                            value={String(value.liveness_grace_seconds ?? 900)}
                            onChange={e => set('liveness_grace_seconds', Number(e.target.value))}
                        />
                    </Field>
                </FieldGrid>

                <Toggle
                    label="Re-check with the provider on every session renewal"
                    hint="Ends the session here when the enterprise session ends there, instead of letting it run on for the rest of its own lifetime. Costs one call per signed-in person each time their session renews."
                    checked={value.liveness_on_refresh !== false}
                    onChange={v => set('liveness_on_refresh', v)}
                />
                <Toggle
                    label="Require an authentication time in the user details"
                    hint="Without one there is no way to tell how long ago someone actually signed in, and the daily re-authentication ceiling stops applying to them."
                    checked={value.require_auth_time !== false}
                    onChange={v => set('require_auth_time', v)}
                />
            </section>
        </div>
    )
}
