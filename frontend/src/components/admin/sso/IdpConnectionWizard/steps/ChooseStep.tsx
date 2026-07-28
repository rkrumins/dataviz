/**
 * Which identity provider — asked in the operator's vocabulary.
 *
 * The form this replaces offered a `<select>` of `oidc | saml2 |
 * custom_profile | custom`. Those are our internal kinds. An operator
 * knows they run Entra ID; whether that speaks OIDC is our problem, and
 * picking the tile answers it for them.
 *
 * Choosing here is not cosmetic — it seeds the claim mapping, the worked
 * example the preview runs on, the connect field's label and placeholder,
 * and the console instructions for the other side of the job.
 */
import { motion } from 'framer-motion'
import { Fingerprint, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StepColumn, StepHero, StepBlock } from '@/components/admin/InviteWizard/ui'
import { VENDOR_PRESETS } from '../../vendorPresets'
import { logoFor } from '../../IdpLogos'

export function ChooseStep({
    presetId, onChoose,
}: {
    presetId: string | null
    onChoose: (id: string) => void
}) {
    return (
        <StepColumn wide>
            <StepHero
                pill="Step 1 of 5"
                pillIcon={Fingerprint}
                title="Which identity provider?"
                subtitle="Pick your product and we'll fill in the claim names it uses, an example of what it sends, and what to set up on its side."
            />
            <StepBlock>
                <div
                    role="radiogroup"
                    aria-label="Identity provider"
                    className="grid grid-cols-2 sm:grid-cols-3 gap-3"
                >
                    {VENDOR_PRESETS.map((p, i) => {
                        const Logo = logoFor(p.id, p.kind)
                        const selected = presetId === p.id
                        return (
                            <motion.button
                                key={p.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.025 }}
                                onClick={() => onChoose(p.id)}
                                className={cn(
                                    'relative text-left p-4 rounded-xl border-2 transition-all',
                                    'hover:border-accent-lineage/50 hover:bg-white/5',
                                    selected
                                        ? 'border-accent-lineage bg-accent-lineage/5'
                                        : 'border-white/10',
                                )}
                            >
                                {selected && (
                                    <span className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent-lineage flex items-center justify-center">
                                        <Check className="w-3 h-3 text-white" />
                                    </span>
                                )}
                                <Logo className="w-7 h-7 mb-2.5 text-ink" />
                                <div className="text-sm font-semibold text-ink">
                                    {p.name}
                                </div>
                                <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">
                                    {p.blurb}
                                </div>
                            </motion.button>
                        )
                    })}
                </div>
            </StepBlock>
        </StepColumn>
    )
}
