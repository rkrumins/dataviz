/**
 * PlaygroundCard — the way into the Playground, wherever it is offered.
 *
 * The Playground is a common area: anyone who can sign in opens it to build graphs
 * of their own from blank, try views out and see what others made — without access
 * to any team's workspace or its data. The card says that and opens it (through
 * /playground, which makes the person a member on the way when needed); before
 * there is one, a platform administrator sets it up here. It renders nothing while
 * the switch is off.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FlaskConical, Infinity as Forever, Settings2, ShieldCheck, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePlayground } from '@/hooks/usePlayground'
import { PlaygroundSetupDialog } from './PlaygroundSetupDialog'

export function PlaygroundCard({ className, compact = false }: { className?: string; compact?: boolean }) {
    const navigate = useNavigate()
    const { data: info } = usePlayground()
    const [settingUp, setSettingUp] = useState(false)

    if (!info?.enabled || (!info.exists && !info.canSetUp)) return null

    return (
        <section
            aria-labelledby="playground-card-title"
            data-tour="playground-card"
            className={cn(
                'relative overflow-hidden rounded-3xl border border-violet-500/25 bg-canvas-elevated',
                compact ? 'p-5' : 'p-6 sm:p-7', className,
            )}
        >
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.10] via-fuchsia-500/[0.05] to-amber-400/[0.08]" />
            <div aria-hidden className="pointer-events-none absolute -top-20 -right-10 h-56 w-56 rounded-full bg-fuchsia-500/20 blur-3xl" />
            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
                <span className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-lg shadow-violet-500/25 shrink-0">
                    <FlaskConical className="w-6 h-6" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 id="playground-card-title" className="font-display text-lg font-bold text-ink">
                        {info.exists ? (info.name || 'Playground') : 'Set up a Playground'}
                    </h2>
                    <p className="mt-0.5 text-sm text-ink-secondary max-w-2xl">
                        {info.exists
                            ? 'A common area to build graphs, proofs of concept and experiments — and see what others made, apart from every team’s data.'
                            : 'Give everyone a safe place to build their own graphs and try views out, apart from production.'}
                    </p>
                    {info.exists && (
                        <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" aria-hidden />
                            Nothing here touches production · {info.joined
                                ? `${info.graphsUsed} of ${info.graphQuota} graphs used`
                                : `up to ${info.graphQuota} graphs each`}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {info.exists && (
                        <button type="button" onClick={() => navigate('/playground')} className={PRIMARY}>
                            Open the Playground <ArrowRight className="w-4 h-4" aria-hidden />
                        </button>
                    )}
                    {info.canSetUp && (
                        <button
                            type="button"
                            onClick={() => setSettingUp(true)}
                            className={info.exists ? SECONDARY : PRIMARY}
                            aria-label={info.exists ? 'Playground settings' : undefined}
                        >
                            <Settings2 className="w-4 h-4" aria-hidden /> {info.exists ? 'Settings' : 'Set it up'}
                        </button>
                    )}
                </div>
            </div>
            {/* The full card, where it is the way in: what the Playground promises, at a glance. */}
            {!compact && info.exists && !info.joined && (
                <ul className="relative mt-5 grid gap-2 sm:grid-cols-3">
                    {PROMISES.map(({ icon: Icon, title, detail }) => (
                        <li key={title} className="flex items-start gap-2.5 rounded-2xl border border-violet-500/15 bg-canvas-elevated/70 p-3">
                            <span className="w-7 h-7 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300 flex items-center justify-center shrink-0">
                                <Icon className="w-3.5 h-3.5" aria-hidden />
                            </span>
                            <span className="min-w-0">
                                <span className="block text-xs font-semibold text-ink">{title}</span>
                                <span className="block text-[11px] text-ink-muted">{detail}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {settingUp && <PlaygroundSetupDialog info={info} onClose={() => setSettingUp(false)} />}
        </section>
    )
}

const PROMISES = [
    { icon: FlaskConical, title: 'Yours to build', detail: 'Start graphs from blank, from a starter data model.' },
    { icon: Users, title: 'Shared with everyone', detail: 'What you make is open to everyone here — or keep it to yourself.' },
    { icon: Forever, title: 'Never expires', detail: 'Keep experimenting — nothing is cleared away.' },
]

const PRIMARY = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50'
const SECONDARY = 'inline-flex h-9 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold border border-glass-border bg-canvas-elevated text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40'
