/**
 * How we reach the IdP, and what proves its word.
 *
 * The typed fields replace a raw JSON textarea. Discovery still runs — it
 * now fills those fields directly instead of merging into a blob the
 * operator then has to read.
 */
import type { IdpKind, IdpProvider } from '@/services/ssoAdminService'
import { DiscoverPanel } from '@/components/admin/DiscoverPanel'
import { SettingsEditor } from '../../settings'
import { SectionHeader } from './SectionHeader'
import type { ProviderEditor } from '../ProviderEditorDrawer'

export function ConnectionSection({
    provider, ed,
}: {
    provider: IdpProvider
    ed: ProviderEditor
}) {
    const kind = provider.kind as IdpKind
    const redirectUri =
        `${window.location.origin}/api/v1/auth/${encodeURIComponent(provider.slug)}/callback`

    return (
        <div className="space-y-5 max-w-3xl">
            <SectionHeader title="Connection">
                Where this provider lives and what verifies its assertions.
                Half of this job happens in your IdP's console — the values
                marked as ours are the ones to paste over there.
            </SectionHeader>

            <DiscoverPanel
                kind={kind}
                // Discovery supplies what the IdP publishes; the operator
                // supplies the credentials. Merging rather than replacing is
                // what keeps a half-typed client_id from being wiped.
                onDiscovered={found => ed.set('settings', { ...ed.draft.settings, ...found })}
            />

            <SettingsEditor
                kind={kind}
                value={ed.draft.settings}
                onChange={next => ed.set('settings', next)}
                redirectUriHint={kind === 'oidc' ? redirectUri : undefined}
            />
        </div>
    )
}
