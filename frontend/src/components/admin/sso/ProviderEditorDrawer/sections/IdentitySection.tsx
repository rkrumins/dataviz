/**
 * Who this connection is.
 *
 * Slug and kind are immutable after create, and the old form rendered them
 * as two greyed-out inputs with the reason living in a code comment — so
 * the operator saw a locked field and no explanation. Both now state why,
 * in place. "You cannot change this" is a much easier instruction to
 * accept than a disabled box.
 */
import { Lock } from 'lucide-react'
import type { IdpProvider } from '@/services/ssoAdminService'
import { Field, TextField } from '../../settings/ui'
import { SectionHeader } from './SectionHeader'
import type { ProviderEditor } from '../ProviderEditorDrawer'
import type { LinkingPolicy } from '../useProviderEditor'

const KIND_LABELS: Record<string, string> = {
    oidc: 'OpenID Connect',
    saml2: 'SAML 2.0',
    custom_profile: 'Corporate portal (cookie / browser storage / header)',
    custom: 'Custom (dev)',
}

const LINKING: { value: LinkingPolicy; label: string; blurb: string }[] = [
    { value: 'strict', label: 'Strict',
      blurb: 'Link to an existing account only when the IdP says the email is verified.' },
    { value: 'allow_verified', label: 'Allow verified',
      blurb: 'Link on a matching email even without a verified flag.' },
    { value: 'manual_only', label: 'Manual only',
      blurb: 'Never link automatically — a person links their own account from /me/identities.' },
    { value: 'disabled', label: 'Disabled',
      blurb: 'No linking at all. A collision is a failed sign-in.' },
]

export function IdentitySection({
    provider, ed,
}: {
    provider: IdpProvider
    ed: ProviderEditor
}) {
    return (
        <div className="space-y-5 max-w-2xl">
            <SectionHeader title="Identity">
                What this connection is called, and how it decides whether an
                arriving person is someone we already know.
            </SectionHeader>

            <Field
                label="Display name"
                required
                hint="Shown on the connection card and, unless overridden, on the sign-in button."
            >
                <TextField
                    mono={false}
                    value={ed.draft.displayName}
                    onChange={e => ed.set('displayName', e.target.value)}
                    invalid={Boolean(ed.errors.displayName)}
                    placeholder="Corporate Entra ID"
                />
                {ed.errors.displayName && (
                    <span className="mt-1 block text-[11px] text-red-500">
                        {ed.errors.displayName}
                    </span>
                )}
            </Field>

            <Immutable
                label="Slug"
                value={provider.slug}
                why="Baked into every URL this connection uses — including the redirect URI you registered at the IdP. Changing it would break the registration."
            />

            <Immutable
                label="Protocol"
                value={KIND_LABELS[provider.kind] ?? provider.kind}
                why="Every setting below is protocol-specific, and the linked identities are keyed to it. Changing it would orphan everyone who has signed in."
            />

            <fieldset>
                <legend className="text-xs font-semibold text-ink mb-2">
                    Account linking
                </legend>
                <div className="space-y-2">
                    {LINKING.map(o => (
                        <label
                            key={o.value}
                            className="flex items-start gap-2.5 p-2.5 rounded-xl border-2 border-black/[0.08] dark:border-white/[0.10] cursor-pointer hover:border-indigo-500/40 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-500/[0.06]"
                        >
                            <input
                                type="radio"
                                name="linking-policy"
                                className="mt-0.5"
                                checked={ed.draft.linkingPolicy === o.value}
                                onChange={() => ed.set('linkingPolicy', o.value)}
                            />
                            <span>
                                <span className="block text-xs font-semibold text-ink">
                                    {o.label}
                                </span>
                                <span className="block text-[11px] text-ink-muted">
                                    {o.blurb}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>
        </div>
    )
}

function Immutable({
    label, value, why,
}: {
    label: string
    value: string
    why: string
}) {
    return (
        <div>
            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink mb-1.5">
                {label}
                <Lock aria-hidden="true" className="w-3 h-3 text-ink-muted" />
                <span className="font-normal text-ink-muted">— set at creation</span>
            </span>
            <div className="px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] font-mono text-xs text-ink">
                {value}
            </div>
            <span className="mt-1 block text-[10px] text-ink-muted leading-relaxed">
                {why}
            </span>
        </div>
    )
}
