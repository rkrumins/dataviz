/**
 * Corporate-portal settings — where an already-authenticated profile is
 * handed to us, and how much that hand-over is worth.
 *
 * Moved intact from `ProviderForm`, restyled onto the shared field chrome.
 * It was already the one kind with real inputs rather than a JSON blob,
 * and the reason is the two toggles at the bottom: unsigned payloads and
 * proxy headers are trust decisions, and a trust decision that can be made
 * by typing a key into a JSON textarea will eventually be made by accident.
 */
import {
    DangerToggle, Field, FieldGrid, SecretField, TextAreaField, TextField,
} from './ui'

export type CustomProfileSource =
    'cookie' | 'local_storage' | 'session_storage' | 'header'

export interface CustomProfileSettings {
    source?: CustomProfileSource
    source_key?: string
    encoding?: 'none' | 'base64url' | 'url'
    payload_format?: 'jwt' | 'json'
    signing_alg?: 'HS256' | 'RS256'
    shared_secret?: string
    public_key?: string
    issuer?: string
    audience?: string
    max_age_seconds?: number
    trust_unsigned?: boolean
    trusted_proxy_acknowledged?: boolean
    [k: string]: unknown
}

export const DEFAULT_CUSTOM_PROFILE_SETTINGS: CustomProfileSettings = {
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

export const BROWSER_SOURCES: CustomProfileSource[] = [
    'local_storage', 'session_storage',
]

const selectCls =
    'w-full px-3 py-2 text-sm rounded-xl border-2 border-black/[0.10] ' +
    'dark:border-white/[0.12] bg-canvas-elevated text-ink outline-none ' +
    'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

export function CustomProfileSettingsForm({
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
        <div className="space-y-4">
            <p className="text-[11px] text-ink-muted leading-relaxed">
                Where the already-authenticated profile is handed to us.
                Cookies and headers are read on the server, so those sign in
                with a plain redirect; browser storage needs the page to read
                the key and post it back.
            </p>

            <FieldGrid>
                <Field label="Source">
                    <select
                        className={selectCls}
                        value={source}
                        onChange={e => set('source', e.target.value as CustomProfileSource)}
                    >
                        {(Object.keys(SOURCE_LABELS) as CustomProfileSource[]).map(s => (
                            <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                        ))}
                    </select>
                </Field>
                <Field
                    label={source === 'header' ? 'Header name'
                        : source === 'cookie' ? 'Cookie name' : 'Storage key'}
                    required
                >
                    <TextField
                        value={value.source_key ?? ''}
                        onChange={e => set('source_key', e.target.value)}
                        placeholder={SOURCE_KEY_PLACEHOLDER[source]}
                    />
                </Field>
                <Field label="Payload format">
                    <select
                        className={selectCls}
                        value={format}
                        onChange={e => set('payload_format', e.target.value as 'jwt' | 'json')}
                    >
                        <option value="jwt">Signed JWT (recommended)</option>
                        <option value="json">Plain JSON (unverifiable)</option>
                    </select>
                </Field>
                <Field label="Transport encoding">
                    <select
                        className={selectCls}
                        value={value.encoding ?? 'none'}
                        onChange={e => set('encoding', e.target.value as 'none' | 'base64url' | 'url')}
                    >
                        <option value="none">None</option>
                        <option value="base64url">base64url</option>
                        <option value="url">URL-encoded</option>
                    </select>
                </Field>
            </FieldGrid>

            {format === 'jwt' && (
                <div className="space-y-3">
                    <FieldGrid>
                        <Field label="Signing algorithm">
                            <select
                                className={selectCls}
                                value={alg}
                                onChange={e => set('signing_alg', e.target.value as 'HS256' | 'RS256')}
                            >
                                <option value="HS256">HS256 (shared secret)</option>
                                <option value="RS256">RS256 (public key)</option>
                            </select>
                        </Field>
                        <Field
                            label="Max age (seconds)"
                            hint={<>Rejects a payload whose <code>iat</code> is older than this, however long its <code>exp</code> is. 0 disables.</>}
                        >
                            <TextField
                                type="number"
                                min={0}
                                mono={false}
                                value={String(value.max_age_seconds ?? 300)}
                                onChange={e => set('max_age_seconds', Number(e.target.value))}
                            />
                        </Field>
                    </FieldGrid>

                    {alg === 'HS256' ? (
                        <SecretField
                            label="Shared secret"
                            required
                            value={value.shared_secret ?? ''}
                            onChange={v => set('shared_secret', v)}
                            placeholder="the secret the portal signs with"
                        />
                    ) : (
                        <Field label="Public key (PEM)" required>
                            <TextAreaField
                                rows={4}
                                value={value.public_key ?? ''}
                                onChange={e => set('public_key', e.target.value)}
                                placeholder="-----BEGIN PUBLIC KEY-----"
                            />
                        </Field>
                    )}

                    <FieldGrid>
                        <Field label={<>Expected issuer <span className="font-normal text-ink-muted">(optional)</span></>}>
                            <TextField
                                value={value.issuer ?? ''}
                                onChange={e => set('issuer', e.target.value)}
                                placeholder="https://portal.corp.example"
                            />
                        </Field>
                        <Field label={<>Expected audience <span className="font-normal text-ink-muted">(optional)</span></>}>
                            <TextField
                                value={value.audience ?? ''}
                                onChange={e => set('audience', e.target.value)}
                                placeholder="dataviz"
                            />
                        </Field>
                    </FieldGrid>
                </div>
            )}

            {format === 'json' && (
                <DangerToggle
                    title="Trust unsigned payloads"
                    checked={Boolean(value.trust_unsigned)}
                    onChange={v => set('trust_unsigned', v)}
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
                    onChange={v => set('trusted_proxy_acknowledged', v)}
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
