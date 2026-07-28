/**
 * The claim mapping, with the room it always needed.
 *
 * This is the section the drawer exists for: two panes do not fit under a
 * card in a list. Because the provider is saved, the preview runs against
 * its own row and "Use last real assertion" is available — mapping against
 * what the IdP genuinely sent beats mapping against anything typed.
 */
import { useMemo } from 'react'
import type { IdpKind, IdpProvider } from '@/services/ssoAdminService'
import { ClaimMappingStudio } from '../../ClaimMappingStudio'
import {
    BROWSER_SOURCES, type CustomProfileSource,
} from '../../settings'
import { SectionHeader } from './SectionHeader'
import type { ProviderEditor } from '../ProviderEditorDrawer'

export function MappingSection({
    provider, ed,
}: {
    provider: IdpProvider
    ed: ProviderEditor
}) {
    const kind = provider.kind as IdpKind

    /** Only meaningful for a storage-backed source — a cookie may well be
     *  HttpOnly, and a header never reaches the browser at all. */
    const readFromBrowser = useMemo(() => {
        if (kind !== 'custom_profile') return undefined
        const src = ed.draft.settings.source as CustomProfileSource | undefined
        const key = ed.draft.settings.source_key as string | undefined
        if (!src || !key || !BROWSER_SOURCES.includes(src)) return undefined
        return () => {
            try {
                const store = src === 'session_storage'
                    ? window.sessionStorage : window.localStorage
                return store.getItem(key)
            } catch {
                return null
            }
        }
    }, [kind, ed.draft.settings])

    return (
        <div className="space-y-5">
            <SectionHeader title="Claim mapping">
                Which key from {provider.displayName || provider.slug} fills
                each of our fields. Resolved live — the right-hand column is
                the profile a sign-in would actually produce.
            </SectionHeader>

            <ClaimMappingStudio
                kind={kind}
                providerId={provider.id}
                slug={provider.slug}
                value={ed.draft.claimMapping}
                onChange={next => ed.set('claimMapping', next)}
                onReadFromBrowser={readFromBrowser}
            />
        </div>
    )
}
