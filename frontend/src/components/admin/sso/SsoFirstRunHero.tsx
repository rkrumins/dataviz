/**
 * Nothing configured yet.
 *
 * An empty table with an "Add provider" button above it tells an operator
 * nothing about what they are about to do or how long it takes. This is
 * the same move ``FirstRunHero`` makes for data providers: replace the
 * empty surface with the path through it.
 *
 * The four stages named here are the wizard's own steps, so the promise
 * on this screen and the flow behind the button are the same thing.
 */
import { motion } from 'framer-motion'
import {
    Fingerprint, Plug, FlaskConical, Rocket, ChevronRight, KeyRound,
} from 'lucide-react'
import { DocsLink } from '@/components/help/DocsLink'

const STAGES = [
    {
        icon: Fingerprint,
        title: 'Pick your provider',
        description: 'Entra, Okta, Auth0, Keycloak, or anything speaking OIDC or SAML',
    },
    {
        icon: Plug,
        title: 'Connect it',
        description: "We read what it publishes and show you what to paste into its console",
    },
    {
        icon: FlaskConical,
        title: 'Try it yourself',
        description: 'Sign in against it while it is still invisible to everyone else',
    },
    {
        icon: Rocket,
        title: 'Publish',
        description: 'Only then does it appear on the sign-in page',
    },
]

export function SsoFirstRunHero({ onStart }: { onStart: () => void }) {
    return (
        <div className="py-10 px-4 max-w-3xl mx-auto text-center">
            <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-accent-lineage to-accent-lineage/70 flex items-center justify-center shadow-lg shadow-accent-lineage/25"
            >
                <KeyRound className="w-8 h-8 text-white" />
            </motion.div>

            <h2 className="text-2xl font-bold tracking-tight text-ink">
                Let people sign in with your company account
            </h2>
            <p className="mt-2.5 text-sm text-ink-secondary max-w-xl mx-auto">
                Connect your identity provider and your team signs in with the
                credentials they already have — no extra passwords to manage,
                and access follows the groups you already maintain.
            </p>

            <div className="mt-9 grid sm:grid-cols-2 gap-3 text-left">
                {STAGES.map((s, i) => (
                    <motion.div
                        key={s.title}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.1 + i * 0.07 }}
                        className="flex gap-3 p-4 rounded-xl border border-white/10 bg-white/[0.02]"
                    >
                        <div className="shrink-0 w-8 h-8 rounded-lg bg-accent-lineage/10 flex items-center justify-center">
                            <s.icon className="w-4 h-4 text-accent-lineage" />
                        </div>
                        <div className="min-w-0">
                            <div className="text-sm font-medium text-ink">
                                <span className="text-ink-muted mr-1.5">{i + 1}.</span>
                                {s.title}
                            </div>
                            <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">
                                {s.description}
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>

            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.45 }}
                className="mt-9 flex flex-col items-center gap-3"
            >
                <button
                    type="button"
                    onClick={onStart}
                    className="px-6 py-3 rounded-xl bg-accent-lineage text-white text-sm font-semibold inline-flex items-center gap-2 hover:brightness-110 transition-all shadow-lg shadow-accent-lineage/20"
                >
                    Connect a provider
                    <ChevronRight className="w-4 h-4" />
                </button>
                <DocsLink slug="sso-setup" label="Read the setup guide first" />
            </motion.div>
        </div>
    )
}
