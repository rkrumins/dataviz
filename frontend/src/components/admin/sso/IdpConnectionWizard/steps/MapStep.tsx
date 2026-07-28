/**
 * Map the claims — pre-answered, then checked.
 *
 * The mapping arrives already filled from the vendor preset, so the
 * common case is "look at it and continue" rather than "work out what
 * Entra calls a surname". The live preview runs against that vendor's
 * worked example, which means an operator sees names and an address
 * resolve *before* a single person has signed in.
 *
 * External ID and email carry a required marker because those are the two
 * the backend refuses to resolve without — everything else degrades to a
 * thinner profile rather than a failed login.
 */
import { Waypoints } from 'lucide-react'
import { StepColumn, StepHero, StepBlock } from '@/components/admin/InviteWizard/ui'
import { ClaimMappingEditor, type ClaimMapping } from '@/components/admin/ClaimMappingEditor'
import type { VendorPreset } from '../../vendorPresets'

export function MapStep({
    preset, claimMapping, onChange, providerId,
}: {
    preset: VendorPreset
    claimMapping: ClaimMapping
    onChange: (m: ClaimMapping) => void
    providerId?: string
}) {
    return (
        <StepColumn wide>
            <StepHero
                pill="Step 3 of 5"
                pillIcon={Waypoints}
                title="Map their fields to ours"
                subtitle={`Pre-filled with the claim names ${preset.name} sends. The preview below runs against a real ${preset.name} payload.`}
                tone="emerald"
            />
            <StepBlock>
                <ClaimMappingEditor
                    kind={preset.kind}
                    providerId={providerId}
                    value={claimMapping}
                    onChange={onChange}
                    initialSample={JSON.stringify(preset.sampleClaims, null, 2)}
                />
            </StepBlock>
        </StepColumn>
    )
}
