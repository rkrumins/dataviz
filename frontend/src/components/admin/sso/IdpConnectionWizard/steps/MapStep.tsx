/**
 * Map the claims — pre-answered, then checked.
 *
 * The mapping arrives already filled from the vendor preset, so the
 * common case is "look at it and continue" rather than "work out what
 * Entra calls a surname". The preview runs against that vendor's worked
 * example, which means an operator sees names and an address resolve
 * *before* a single person has signed in.
 *
 * That last part only became true with `previewMapping`: this step runs
 * before the draft row exists, and the old editor's preview required a
 * saved provider, so the promise in this subtitle was not kept.
 *
 * External ID and email carry a required marker because those are the two
 * the backend refuses to resolve without — everything else degrades to a
 * thinner profile rather than a failed login.
 */
import { Waypoints } from 'lucide-react'
import { StepColumn, StepHero, StepBlock } from '@/components/admin/InviteWizard/ui'
import { ClaimMappingStudio, type ClaimMapping } from '../../ClaimMappingStudio'
import type { VendorPreset } from '../../vendorPresets'

export function MapStep({
    preset, claimMapping, onChange, providerId, slug,
}: {
    preset: VendorPreset
    claimMapping: ClaimMapping
    onChange: (m: ClaimMapping) => void
    providerId?: string
    slug?: string
}) {
    return (
        <StepColumn wide>
            <StepHero
                pill="Step 3 of 5"
                pillIcon={Waypoints}
                title="Map their fields to ours"
                subtitle={`Pre-filled with the claim names ${preset.name} sends, and resolved live against a real ${preset.name} payload.`}
                tone="emerald"
            />
            <StepBlock>
                <ClaimMappingStudio
                    kind={preset.kind}
                    providerId={providerId}
                    slug={slug}
                    value={claimMapping}
                    onChange={onChange}
                    initialSample={JSON.stringify(preset.sampleClaims, null, 2)}
                    initialSampleSource="example"
                />
            </StepBlock>
        </StepColumn>
    )
}
