/**
 * The Dashboard for someone who isn't in a workspace yet and can't create
 * one — the admin onboarding ("connect your first data source") means
 * nothing to them. It says where they stand and the way in: Find a
 * workspace while that is switched on, otherwise who to ask; and any
 * request already on its way, so they can see it moving.
 */
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Boxes, Compass, Link2, Send, Sparkles } from 'lucide-react'

import { STATUS_META, idpInstruction, roleLabel } from '@/components/access/accessRequestCopy'
import { useMyAccessRequests, WORKSPACE_DIRECTORY_FEATURE } from '@/hooks/useWorkspaceAccess'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useBrand } from '@/store/branding'
import { useFeature } from '@/store/features'

export function DashboardJoinWorkspace() {
    const { appName } = useBrand()
    const navigate = useNavigate()
    const directoryOn = useFeature(WORKSPACE_DIRECTORY_FEATURE)
    const { requests } = useMyAccessRequests('open')
    const open = requests ?? []

    const steps = [
        directoryOn
            ? { icon: Compass, title: 'Find a workspace', body: 'Browse what each team works on and who looks after it.' }
            : { icon: Link2, title: 'Get a link', body: 'Ask a colleague for a link to the workspace your team uses.' },
        { icon: Send, title: 'Ask to join', body: 'Say what you need and why. Its admins answer — you hear in your Inbox.' },
        { icon: Sparkles, title: 'Start exploring', body: 'Approved, the workspace and its views are yours to open straight away.' },
    ]

    return (
        <motion.section
            initial={{ opacity: 0, y: MOTION.sectionY }}
            animate={{ opacity: 1, y: 0 }}
            transition={MOTION.sectionEntry}
            className="pt-8 space-y-6"
            aria-labelledby="join-workspace-title"
        >
            <div className="relative overflow-hidden rounded-3xl border border-glass-border bg-canvas-elevated p-8">
                <div className="pointer-events-none absolute -top-24 -right-16 w-72 h-72 rounded-full bg-emerald-500/15 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-24 -left-10 w-72 h-72 rounded-full bg-sky-500/10 blur-3xl" />
                <div className="relative flex items-start gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-lg shadow-emerald-500/25 shrink-0">
                        <Boxes className="w-6 h-6" />
                    </div>
                    <div className="min-w-0">
                        <h1 id="join-workspace-title" className="text-2xl font-bold text-ink">Welcome to {appName}</h1>
                        <p className="text-sm text-ink-secondary mt-1 max-w-2xl">
                            You’re not in a workspace yet. Workspaces hold a team’s data sources and views —
                            join one to start exploring.
                        </p>
                        <div className="mt-5 flex flex-wrap items-center gap-3">
                            {directoryOn ? (
                                <button
                                    type="button"
                                    onClick={() => navigate('/workspaces?tab=discover')}
                                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25 hover:-translate-y-0.5 transition-transform"
                                >
                                    <Compass className="w-4 h-4" /> Find a workspace
                                </button>
                            ) : (
                                <p className="text-sm text-ink">
                                    Ask an administrator to add you, or a colleague for a link to their workspace —
                                    opening it lets you ask to join.
                                </p>
                            )}
                            <Link to="/my/access" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-secondary hover:text-ink">
                                See your access <ArrowRight className="w-3.5 h-3.5" />
                            </Link>
                        </div>
                    </div>
                </div>
            </div>

            <ol className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {steps.map((step, i) => (
                    <li key={step.title} className="rounded-2xl border border-glass-border bg-canvas-elevated p-5">
                        <div className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-xs font-bold flex items-center justify-center">
                                {i + 1}
                            </span>
                            <step.icon className="w-4 h-4 text-ink-muted" aria-hidden />
                        </div>
                        <h2 className="mt-3 text-sm font-bold text-ink">{step.title}</h2>
                        <p className="mt-1 text-xs text-ink-muted">{step.body}</p>
                    </li>
                ))}
            </ol>

            {open.length > 0 && (
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                    <div className="px-5 py-3 border-b border-glass-border flex items-center justify-between">
                        <h2 className="text-sm font-bold text-ink">Your requests</h2>
                        <Link to="/my/access" className="text-xs font-semibold text-ink-muted hover:text-ink">Follow them</Link>
                    </div>
                    <ul className="divide-y divide-glass-border">
                        {open.map(r => {
                            const meta = STATUS_META[r.status]
                            const Icon = meta.icon
                            return (
                                <li key={r.id} className="px-5 py-3 flex items-start gap-3">
                                    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0', meta.pill)}>
                                        <Icon className="w-2.5 h-2.5" /> {meta.label}
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-ink truncate">
                                            {r.target.label ?? 'A workspace you asked to join'}
                                            <span className="font-normal text-ink-muted ml-1.5">as {roleLabel(r.requestedRole)}</span>
                                        </p>
                                        {r.status === 'awaiting_idp' && r.idpGroup && (
                                            <p className="text-xs text-ink-muted mt-0.5">{idpInstruction(r.idpGroup, r.idpProvider)}</p>
                                        )}
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}
        </motion.section>
    )
}
