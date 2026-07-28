/**
 * OIDC credentials, as fields.
 *
 * These were a raw JSON textarea, so rotating a client secret meant
 * hand-editing JSON and hoping the quotes survived. The keys are exactly
 * the ones `oidc.settings_from_snapshot` reads — nothing here is invented,
 * and anything outside this set still round-trips through the Advanced
 * editor the drawer folds underneath.
 */
import { Field, FieldGrid, SecretField, TextField } from './ui'

export interface OidcSettings {
    issuer?: string
    client_id?: string
    client_secret?: string
    redirect_uri?: string
    scopes?: string
    default_next?: string
    [k: string]: unknown
}

export function OidcSettingsForm({
    value, onChange, redirectUriHint,
}: {
    value: OidcSettings
    onChange: (next: OidcSettings) => void
    /** The callback URL this deployment will actually use, so the operator
     *  can see what has to be registered at the IdP. */
    redirectUriHint?: string
}) {
    const set = (k: keyof OidcSettings, v: unknown) => onChange({ ...value, [k]: v })

    return (
        <div className="space-y-3">
            <Field
                label="Issuer URL"
                required
                hint="The discovery base. Entra: https://login.microsoftonline.com/{tenant}/v2.0"
            >
                <TextField
                    value={value.issuer ?? ''}
                    onChange={e => set('issuer', e.target.value)}
                    placeholder="https://login.microsoftonline.com/…/v2.0"
                />
            </Field>

            <FieldGrid>
                <Field label="Client ID" required>
                    <TextField
                        value={value.client_id ?? ''}
                        onChange={e => set('client_id', e.target.value)}
                        placeholder="00000000-0000-0000-0000-000000000000"
                    />
                </Field>
                <SecretField
                    label="Client secret"
                    value={value.client_secret ?? ''}
                    onChange={v => set('client_secret', v)}
                    placeholder="the secret from the IdP console"
                />
            </FieldGrid>

            <Field
                label="Redirect URI"
                required
                hint={redirectUriHint
                    ? <>Must match what you registered at the IdP, to the character. This deployment uses <code className="font-mono">{redirectUriHint}</code>.</>
                    : 'Must match what you registered at the IdP, to the character.'}
            >
                <TextField
                    value={value.redirect_uri ?? ''}
                    onChange={e => set('redirect_uri', e.target.value)}
                    placeholder={redirectUriHint ?? 'https://app.example.com/api/v1/auth/…/callback'}
                />
            </Field>

            <FieldGrid>
                <Field
                    label="Scopes"
                    hint="Space-separated. openid is required; email and profile fill the mapping."
                >
                    <TextField
                        value={value.scopes ?? ''}
                        onChange={e => set('scopes', e.target.value)}
                        placeholder="openid email profile"
                    />
                </Field>
                <Field
                    label="Landing path"
                    hint="Where a successful sign-in arrives when nothing else was requested."
                >
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
