/**
 * SAML 2.0 credentials, as fields.
 *
 * Split into the two halves an operator experiences: what their IdP told
 * *us*, most of which metadata import fills in, and what we have to tell
 * *them*. The old JSON blob mixed the two, so it never made clear which
 * values were to be copied out and which pasted in.
 *
 * Keys match `saml2.settings_from_snapshot`.
 */
import { Field, FieldGrid, SecretField, TextAreaField, TextField } from './ui'

export interface SamlSettings {
    idp_entity_id?: string
    idp_sso_url?: string
    idp_slo_url?: string
    idp_x509_cert?: string
    sp_entity_id?: string
    sp_acs_url?: string
    sp_slo_url?: string
    sp_private_key?: string
    name_id_format?: string
    default_next?: string
    [k: string]: unknown
}

const NAME_ID_FORMATS = [
    ['urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', 'Email address'],
    ['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', 'Persistent'],
    ['urn:oasis:names:tc:SAML:2.0:nameid-format:transient', 'Transient'],
    ['urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', 'Unspecified'],
]

export function SamlSettingsForm({
    value, onChange,
}: {
    value: SamlSettings
    onChange: (next: SamlSettings) => void
}) {
    const set = (k: keyof SamlSettings, v: unknown) => onChange({ ...value, [k]: v })

    return (
        <div className="space-y-5">
            <section className="space-y-3">
                <h5 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                    From your IdP
                </h5>

                <FieldGrid>
                    <Field label="IdP entity ID" required>
                        <TextField
                            value={value.idp_entity_id ?? ''}
                            onChange={e => set('idp_entity_id', e.target.value)}
                            placeholder="https://idp.corp.example/metadata"
                        />
                    </Field>
                    <Field label="Sign-on URL" required>
                        <TextField
                            value={value.idp_sso_url ?? ''}
                            onChange={e => set('idp_sso_url', e.target.value)}
                            placeholder="https://idp.corp.example/sso"
                        />
                    </Field>
                </FieldGrid>

                <Field
                    label="Single logout URL"
                    hint="Optional. Without it, signing out here leaves the IdP session intact."
                >
                    <TextField
                        value={value.idp_slo_url ?? ''}
                        onChange={e => set('idp_slo_url', e.target.value)}
                        placeholder="https://idp.corp.example/slo"
                    />
                </Field>

                <SecretField
                    label="Signing certificate (X.509)"
                    required
                    value={value.idp_x509_cert ?? ''}
                    onChange={v => set('idp_x509_cert', v)}
                    placeholder="MIIC…"
                    hint="What every assertion is verified against. When this expires, every sign-in stops at once — the connection card counts down the days."
                />
            </section>

            <section className="space-y-3">
                <h5 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                    What your IdP needs from us
                </h5>

                <FieldGrid>
                    <Field label="SP entity ID" required hint="Our audience, in their app config.">
                        <TextField
                            value={value.sp_entity_id ?? ''}
                            onChange={e => set('sp_entity_id', e.target.value)}
                            placeholder="https://app.example.com"
                        />
                    </Field>
                    <Field label="ACS URL" required hint="Where they post the assertion.">
                        <TextField
                            value={value.sp_acs_url ?? ''}
                            onChange={e => set('sp_acs_url', e.target.value)}
                            placeholder="https://app.example.com/api/v1/auth/…/acs"
                        />
                    </Field>
                </FieldGrid>

                <SecretField
                    label="SP private key (PEM)"
                    value={value.sp_private_key ?? ''}
                    onChange={v => set('sp_private_key', v)}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    hint="Only needed when your IdP requires signed requests or encrypted assertions."
                />
            </section>

            <FieldGrid>
                <Field label="NameID format">
                    <select
                        value={value.name_id_format ?? NAME_ID_FORMATS[0][0]}
                        onChange={e => set('name_id_format', e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated text-ink outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                    >
                        {NAME_ID_FORMATS.map(([v, label]) => (
                            <option key={v} value={v}>{label}</option>
                        ))}
                    </select>
                </Field>
                <Field label="Landing path">
                    <TextField
                        value={value.default_next ?? ''}
                        onChange={e => set('default_next', e.target.value)}
                        placeholder="/"
                    />
                </Field>
            </FieldGrid>
        </div>
    )
}

export { TextAreaField }
