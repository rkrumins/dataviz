/**
 * Step 4 — how long it lasts, and where it may be used from.
 *
 * The two settings that close a key when nobody is watching. Each expiry
 * choice reads as the day it ends; networks are chips, with the address this
 * browser is seen at one click away.
 */
import { CalendarClock, Clock, Network } from 'lucide-react'

import { FieldLabel, Hint, StepBlock, StepColumn, StepHero } from '@/components/admin/InviteWizard/ui'
import type { ApiKeyOptions } from '@/services/apiKeyService'
import { CidrChipInput } from '../../CidrChipInput'
import { ExpiryPicker } from '../../ExpiryPicker'
import type { ExpiryChoice } from '../../apiKeyFormat'
import type { ApiKeyWizardState } from '../useApiKeyWizard'

export function SafetyStep({ w, options }: { w: ApiKeyWizardState; options: ApiKeyOptions }) {
    return (
        <StepColumn wide>
            <StepHero
                pill="Safety"
                pillIcon={Clock}
                title="How long, and from where?"
                subtitle="An end date and a network limit are what close a key when nobody is watching."
            />

            <StepBlock delay={0.04}>
                <FieldLabel>
                    <CalendarClock className="w-4 h-4 inline-block mr-1.5 -mt-0.5 text-indigo-500" aria-hidden />
                    Expires
                </FieldLabel>
                <ExpiryPicker
                    value={w.draft.expiry}
                    customDate={w.draft.customDate}
                    onChange={(expiry) => w.update({ expiry: expiry as ExpiryChoice })}
                    onCustomDate={(customDate) => w.update({ customDate })}
                    maxLifetimeDays={options.policy.maxLifetimeDays}
                    dateProblem={w.dateProblem}
                />
            </StepBlock>

            <StepBlock delay={0.08}>
                <FieldLabel hint="optional">
                    <Network className="w-4 h-4 inline-block mr-1.5 -mt-0.5 text-indigo-500" aria-hidden />
                    Only from these networks
                </FieldLabel>
                <CidrChipInput
                    value={w.draft.cidrs}
                    onChange={(cidrs) => w.update({ cidrs })}
                    clientIp={options.clientIp}
                />
                <Hint>
                    Leave it empty to allow any network. A limit is only as strong as the proxies in front of
                    this server are trusted to name the real address — ask an administrator if you rely on it.
                </Hint>
            </StepBlock>
        </StepColumn>
    )
}
