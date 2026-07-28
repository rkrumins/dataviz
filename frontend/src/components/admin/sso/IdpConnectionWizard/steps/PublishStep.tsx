/**
 * Publish — the receipt, then the switch.
 *
 * Everything up to here has been invisible to everyone but this operator.
 * This is the one irreversible-feeling moment in the flow, so it states
 * plainly what is about to become true for every user, and it says so
 * before the button rather than after it.
 */
import { Rocket, Check, Users } from 'lucide-react'
import { StepColumn, StepHero, StepBlock } from '@/components/admin/InviteWizard/ui'
import type { VendorPreset } from '../../vendorPresets'
import { logoFor } from '../../IdpLogos'
import type { IdpProvider } from '@/services/ssoAdminService'

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-baseline justify-between gap-4 py-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-muted">
                {label}
            </span>
            <span className="text-sm text-ink text-right truncate">{value}</span>
        </div>
    )
}

export function PublishStep({
    preset, displayName, slug, provider, published,
}: {
    preset: VendorPreset
    displayName: string
    slug: string
    provider: IdpProvider | null
    published: boolean
}) {
    const Logo = logoFor(preset.id, preset.kind)

    if (published) {
        return (
            <StepColumn>
                <StepHero
                    pill="Live"
                    pillIcon={Check}
                    title={`${displayName} is live`}
                    subtitle="It's on the sign-in page now. You can turn it off at any time without losing the configuration."
                    tone="emerald"
                />
            </StepColumn>
        )
    }

    return (
        <StepColumn>
            <StepHero
                pill="Step 5 of 5"
                pillIcon={Rocket}
                title="Ready to go live?"
                subtitle="Publishing puts this on the sign-in page for everyone."
            />

            <StepBlock>
                <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                    <div className="flex items-center gap-3 pb-3 mb-2 border-b border-white/10">
                        <Logo className="w-8 h-8 text-ink" />
                        <div className="min-w-0">
                            <div className="text-sm font-semibold text-ink truncate">
                                {displayName}
                            </div>
                            <div className="font-mono text-[11px] text-ink-muted">
                                {slug}
                            </div>
                        </div>
                    </div>
                    <Row label="Provider" value={preset.name} />
                    <Row label="Protocol" value={preset.kind} />
                    <Row
                        label="Rehearsed"
                        value={provider ? 'Yes — nothing was written' : 'No'}
                    />
                </div>

                <div className="mt-3 flex items-start gap-2 p-3 rounded-xl border border-amber-500/25 bg-amber-500/5">
                    <Users className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                    <p className="text-[12px] text-ink-muted">
                        After publishing, anyone who can reach the sign-in page
                        will see this option. New people signing in through it
                        get an account automatically unless you've turned off
                        just-in-time provisioning in Settings.
                    </p>
                </div>
            </StepBlock>
        </StepColumn>
    )
}
