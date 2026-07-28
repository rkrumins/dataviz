/** Step 4 — the receipt, with each row jumping back to what set it. */
import { Users, Shield, KeyRound, CheckCircle2, Pencil, ClipboardCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StepColumn, StepHero, StepBlock } from '@/components/admin/InviteWizard/ui'
import { deriveName, type CreateUserState, type CreateStep } from '../useCreateUser'

function Row({
    icon: Icon, label, value, onEdit, tone,
}: {
    icon: typeof Users
    label: string
    value: string
    onEdit: () => void
    tone?: 'warn'
}) {
    return (
        <div className="group flex items-center gap-3 px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.08] last:border-0">
            <span className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border',
                tone === 'warn'
                    ? 'bg-amber-500/10 border-amber-500/25 text-amber-500'
                    : 'bg-black/[0.03] dark:bg-white/[0.04] border-black/[0.06] dark:border-white/[0.08] text-ink-muted',
            )}>
                <Icon className="w-4 h-4" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
                <p className={cn(
                    'text-sm font-medium truncate',
                    tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-ink',
                )}>{value}</p>
            </div>
            <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-ink-muted group-hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
            >
                <Pencil className="w-3 h-3" />
                Change
            </button>
        </div>
    )
}

export function UserReviewStep({
    w, onEdit,
}: {
    w: CreateUserState
    onEdit: (s: CreateStep) => void
}) {
    return (
        <StepColumn wide>
            <StepHero
                pill="Last look"
                pillIcon={ClipboardCheck}
                tone="emerald"
                title="Review and create"
                subtitle="These accounts will exist as soon as you press the button. Any row can be changed without losing the rest."
            />

            <StepBlock delay={0.04}>
                <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-500/[0.10] via-emerald-500/[0.05] to-indigo-500/[0.06] border border-emerald-500/25">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5">
                        This will
                    </p>
                    <p className="text-xs text-ink leading-relaxed">
                        Create <span className="font-semibold">{w.peopleSummary}</span>
                        {' '}as <span className="font-semibold">{w.roleLabel ?? 'standard users'}</span>
                        {w.workspaceName && <> in <span className="font-semibold">{w.workspaceName}</span></>}
                        {w.selectedGroupNames.length > 0 && <>, in {w.selectedGroupNames.join(', ')}</>}
                        .{' '}
                        {w.credential === 'setup_link'
                            ? 'Each gets a one-time setup link for you to send.'
                            : w.credential === 'password'
                                ? 'The password you set is the only way in until they change it.'
                                : 'They sign in through your identity provider.'}
                        {!w.activate && ' Held in the pending queue rather than activated.'}
                    </p>
                </div>
            </StepBlock>

            {/* For a batch, show what the names will actually be. Deriving
                them silently and letting the admin discover the result in
                the user list afterwards is how you get a list of Ada
                Lovelaces called "ada". */}
            {w.mode === 'many' && w.validBulk.length > 0 && (
                <StepBlock delay={0.06}>
                    <div className="rounded-2xl border-2 border-black/[0.10] dark:border-white/[0.12] overflow-hidden max-h-56 overflow-y-auto">
                        {w.validBulk.slice(0, 50).map(r => {
                            const d = deriveName(r.email)
                            const first = r.firstName || d.first
                            const last = r.lastName || d.last
                            return (
                                <div key={r.email} className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.06] dark:border-white/[0.08] last:border-0">
                                    <span className="w-7 h-7 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold flex items-center justify-center shrink-0 uppercase">
                                        {(first || r.email).charAt(0)}
                                    </span>
                                    <span className="text-sm text-ink font-medium truncate flex-1 min-w-0">
                                        {`${first} ${last}`.trim()}
                                    </span>
                                    <span className="text-xs text-ink-muted truncate max-w-[45%]">{r.email}</span>
                                </div>
                            )
                        })}
                    </div>
                    {w.validBulk.length > 50 && (
                        <p className="text-[11px] text-ink-muted mt-2">
                            Showing the first 50 of {w.validBulk.length}.
                        </p>
                    )}
                </StepBlock>
            )}

            <StepBlock delay={0.08}>
                <div className="rounded-2xl border-2 border-black/[0.10] dark:border-white/[0.12] overflow-hidden bg-canvas-elevated">
                    <Row icon={Users} label="Who" value={w.peopleSummary} onEdit={() => onEdit('people')} />
                    <Row
                        icon={Shield} label="Access" value={w.accessSummary}
                        onEdit={() => onEdit('access')}
                        tone={w.isPrivileged ? 'warn' : undefined}
                    />
                    <Row
                        icon={KeyRound} label="Sign-in" value={w.signinSummary}
                        onEdit={() => onEdit('signin')}
                        tone={w.credential === 'password' ? 'warn' : undefined}
                    />
                    <Row
                        icon={CheckCircle2} label="Status"
                        value={w.activate ? 'Active straight away' : 'Pending approval'}
                        onEdit={() => onEdit('signin')}
                    />
                </div>
            </StepBlock>
        </StepColumn>
    )
}
