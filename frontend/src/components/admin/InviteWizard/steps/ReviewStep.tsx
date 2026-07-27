/**
 * Step 4 — the receipt.
 *
 * A sentence first, because that is the thing a person can actually check,
 * then the same facts as rows you can jump back and change. The dialog this
 * replaces had the sentence last, three scroll-lengths below the fields it
 * described, which made it a footnote rather than the check it exists to be.
 */
import { Mail, Users, Clock, Shield, Building2, Globe, ListChecks, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InviteSummary } from '../results'
import type { InviteWizardState, WizardStep } from '../useInviteWizard'

function Row({
    icon: Icon, label, value, onEdit, tone,
}: {
    icon: typeof Mail
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
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                    {label}
                </p>
                <p className={cn(
                    'text-sm font-medium truncate',
                    tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-ink',
                )}>
                    {value}
                </p>
            </div>
            <button
                type="button"
                onClick={onEdit}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all shrink-0"
            >
                <Pencil className="w-3 h-3" />
                Change
            </button>
        </div>
    )
}

export function ReviewStep({
    w, onEdit,
}: {
    w: InviteWizardState
    onEdit: (s: WizardStep) => void
}) {
    const audienceIcon =
        w.audience === 'person' ? Mail
        : w.audience === 'several' ? ListChecks
        : w.audience === 'domain' ? Building2
        : Globe

    return (
        <div>
            <h3 className="text-lg font-bold text-ink">Review and generate</h3>
            <p className="text-sm text-ink-muted mt-1 mb-5 leading-relaxed">
                One last look at what this link does before it exists.
            </p>

            <InviteSummary
                roleLabel={w.roleLabel}
                workspaceName={w.workspaceName}
                groupNames={w.selectedGroupNames}
                email={w.email.trim() || null}
                emailRequired={w.needsEmail}
                shareable={w.overrideActive}
                expiresIn={w.expiresIn}
                maxUses={w.bulkMode ? 1 : w.maxUses}
                emailDomain={w.email.trim() ? null : (w.emailDomain.trim().replace(/^@/, '') || null)}
                recipientCount={w.bulkMode ? w.bulkEmailList.length : 1}
            />

            <div className="mt-5 rounded-2xl border border-black/[0.08] dark:border-white/[0.10] overflow-hidden bg-canvas-elevated">
                <Row
                    icon={audienceIcon}
                    label="Who it's for"
                    value={w.audienceSummary ?? '—'}
                    onEdit={() => onEdit('audience')}
                />
                <Row
                    icon={Shield}
                    label="What they get"
                    value={w.accessSummary}
                    onEdit={() => onEdit('access')}
                    tone={w.isPrivileged ? 'warn' : undefined}
                />
                <Row
                    icon={Users}
                    label="Seats"
                    value={w.bulkMode
                        ? `${w.bulkEmailList.length} links, one signup each`
                        : w.maxUses === null ? 'Unlimited' : `${w.maxUses} ${w.maxUses === 1 ? 'person' : 'people'}`}
                    onEdit={() => onEdit('safety')}
                    tone={!w.bulkMode && w.maxUses === null ? 'warn' : undefined}
                />
                <Row
                    icon={Clock}
                    label="Expires in"
                    value={w.expiresIn}
                    onEdit={() => onEdit('safety')}
                />
            </div>
        </div>
    )
}
