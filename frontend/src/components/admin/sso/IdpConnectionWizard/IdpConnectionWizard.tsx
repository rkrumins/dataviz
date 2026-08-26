/**
 * Connecting an identity provider, as a guided flow.
 *
 * Built on the shared ``WizardShell`` — the same chrome as ViewWizard and
 * AddDataSourceWizard, so this reads as part of the product rather than as
 * a form someone bolted onto an admin table.
 *
 * The order of the questions is the design, and it follows the shape of
 * the job rather than the shape of the database row:
 *
 *   1. Which provider — in the operator's vocabulary, not our `kind` enum.
 *      Seeds the claim names, the worked example, and the console steps.
 *   2. Connect      — read what the IdP publishes; show what to paste back
 *                     into it. The two-sided half nothing acknowledged.
 *   3. Map          — already filled in; check it against a real payload.
 *   4. Rehearse     — sign in yourself, against a draft nobody can see.
 *   5. Publish      — the one moment anything becomes visible to users.
 *
 * Steps 4 and 5 are the point. Everything before them is configuration
 * that used to go live the instant it was saved.
 */
import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Fingerprint, Plug, Waypoints, FlaskConical, Rocket,
} from 'lucide-react'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import type { IdpProvider } from '@/services/ssoAdminService'
import {
    useIdpConnectionWizard, WIZARD_STEPS, type WizardStep,
} from './useIdpConnectionWizard'
import { ChooseStep } from './steps/ChooseStep'
import { ConnectStep } from './steps/ConnectStep'
import { MapStep } from './steps/MapStep'
import { RehearseStep } from './steps/RehearseStep'
import { PublishStep } from './steps/PublishStep'

const STEP_DEFS: Record<WizardStep, WizardStepDef> = {
    choose: { id: 'choose', label: 'Provider', icon: <Fingerprint className="w-3.5 h-3.5" /> },
    connect: { id: 'connect', label: 'Connect', icon: <Plug className="w-3.5 h-3.5" /> },
    map: { id: 'map', label: 'Fields', icon: <Waypoints className="w-3.5 h-3.5" /> },
    rehearse: { id: 'rehearse', label: 'Rehearse', icon: <FlaskConical className="w-3.5 h-3.5" /> },
    publish: { id: 'publish', label: 'Publish', icon: <Rocket className="w-3.5 h-3.5" /> },
}

export function IdpConnectionWizard({
    onClose, onPublished,
}: {
    onClose: () => void
    onPublished: (provider: IdpProvider) => void
}) {
    const w = useIdpConnectionWizard()
    const [published, setPublished] = useState(false)
    const [direction, setDirection] = useState(1)

    const idx = WIZARD_STEPS.indexOf(w.step)
    const isLast = idx === WIZARD_STEPS.length - 1

    const goTo = useCallback((next: string) => {
        const to = WIZARD_STEPS.indexOf(next as WizardStep)
        if (to < 0) return
        setDirection(to > idx ? 1 : -1)
        w.setStep(next as WizardStep)
    }, [idx, w])

    const onNext = useCallback(() => {
        if (!w.canAdvance || isLast) return
        goTo(WIZARD_STEPS[idx + 1])
    }, [w.canAdvance, isLast, idx, goTo])

    const onBack = useCallback(() => {
        if (idx === 0) return
        goTo(WIZARD_STEPS[idx - 1])
    }, [idx, goTo])

    const onSubmit = useCallback(async () => {
        if (await w.publish()) {
            setPublished(true)
            if (w.provider) onPublished(w.provider)
        }
    }, [w, onPublished])

    return (
        <WizardShell
            title="Connect an identity provider"
            submitLabel="Publish"
            helpSlug="sso-setup"
            currentStep={w.step}
            activeSteps={WIZARD_STEPS.map(s => STEP_DEFS[s])}
            currentStepIndex={idx}
            onStepClick={goTo}
            onBack={onBack}
            onNext={onNext}
            onClose={onClose}
            canProceed={w.canAdvance}
            isLastStep={isLast}
            isSubmitting={w.saving}
            onSubmit={() => { void onSubmit() }}
            terminalPhase={published ? 'success' : undefined}
            terminalLabel="Publish"
            terminalSubtitle={published ? 'Live on the sign-in page' : undefined}
            wide={w.step === 'choose' || w.step === 'map' || w.step === 'connect'}
        >
            <AnimatePresence mode="wait" custom={direction}>
                <motion.div
                    key={w.step}
                    custom={direction}
                    initial={{ opacity: 0, x: direction * 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: direction * -24 }}
                    transition={{ duration: 0.18 }}
                >
                    {w.step === 'choose' && (
                        <ChooseStep presetId={w.presetId} onChoose={w.choose} />
                    )}
                    {w.step === 'connect' && w.preset && (
                        <ConnectStep
                            preset={w.preset}
                            displayName={w.displayName}
                            onDisplayName={w.setDisplayName}
                            slug={w.slug}
                            connectInput={w.connectInput}
                            onConnectInput={w.setConnectInput}
                            onDiscover={() => { void w.runDiscovery() }}
                            discovering={w.discovering}
                            discovery={w.discovery}
                            settings={w.settings}
                            onSettings={w.setSettings}
                        />
                    )}
                    {w.step === 'map' && w.preset && (
                        <MapStep
                            preset={w.preset}
                            claimMapping={w.claimMapping}
                            onChange={w.setClaimMapping}
                            providerId={w.provider?.id}
                            slug={w.slug}
                        />
                    )}
                    {w.step === 'rehearse' && (
                        <RehearseStep
                            provider={w.provider}
                            kind={w.preset?.kind}
                            rehearsed={w.rehearsed}
                            onRehearsed={() => w.setRehearsed(true)}
                            onCreateDraft={w.createDraft}
                            saving={w.saving}
                        />
                    )}
                    {w.step === 'publish' && w.preset && (
                        <PublishStep
                            preset={w.preset}
                            displayName={w.displayName}
                            slug={w.slug}
                            provider={w.provider}
                            published={published}
                        />
                    )}
                </motion.div>
            </AnimatePresence>

            {w.error && (
                <p role="alert" className="mt-4 text-center text-sm text-red-400">
                    {w.error}
                </p>
            )}
        </WizardShell>
    )
}
