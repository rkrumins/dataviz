/**
 * Step 2 — what the invited person gets.
 *
 * Full width, so a privileged role's description is readable rather than
 * clamped to one line and cut mid-sentence. These are the choices where
 * knowing what you are granting matters most.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { Building2, Lock, AlertCircle, Users2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    SectionLabel, FieldHint, RoleListSkeleton, RoleGroup, NoRoleCard,
    WorkspacePicker, GroupsPicker,
} from '../pickers'
import type { InviteWizardState } from '../useInviteWizard'

export function AccessStep({
    w, onFixAudience,
}: {
    w: InviteWizardState
    onFixAudience: () => void
}) {
    if (w.roles === null) return <RoleListSkeleton />

    return (
        <div>
            <h3 className="text-lg font-bold text-ink">What will they get?</h3>
            <p className="text-sm text-ink-muted mt-1 mb-5 leading-relaxed">
                Everyone lands as a standard team member. Workspace access is granted by
                each workspace&apos;s admin after they sign up.
            </p>

            <NoRoleCard
                option={w.noRole}
                selected={w.selectedRole === ''}
                onSelect={() => w.setSelectedRole('')}
            />

            <div className="mt-5 space-y-5">
                {w.platformTiers.length > 0 && (
                    <RoleGroup
                        title="Elevate to a privileged role"
                        subtitle="Optional. Grants access across the whole organization."
                        options={w.platformTiers}
                        selected={w.selectedRole}
                        onSelect={w.setSelectedRole}
                    />
                )}
                {w.customRoles.length > 0 && (
                    <RoleGroup
                        title="Custom roles"
                        subtitle="Created by your team. How they work depends on the role."
                        options={w.customRoles}
                        selected={w.selectedRole}
                        onSelect={w.setSelectedRole}
                    />
                )}
            </div>

            <AnimatePresence initial={false}>
                {w.isWorkspaceScoped && (
                    <motion.div
                        key="ws"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                    >
                        <div className="mt-6">
                            <SectionLabel>Workspace</SectionLabel>
                            {w.fixedWorkspaceId ? (
                                <div className="flex items-center gap-2.5 p-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/[0.08] dark:border-white/[0.10]">
                                    <Building2 className="w-4 h-4 text-ink-muted shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-ink truncate">
                                            {w.workspaceName ?? w.fixedWorkspaceId}
                                        </p>
                                        <p className="text-[11px] text-ink-muted">
                                            This custom role is fixed to this workspace.
                                        </p>
                                    </div>
                                    <Lock className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                                </div>
                            ) : (
                                <WorkspacePicker
                                    workspaces={w.workspaces}
                                    value={w.workspaceId}
                                    onChange={w.setWorkspaceId}
                                />
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="mt-6">
                <SectionLabel>
                    Add to groups
                    <span className="ml-1 text-ink-muted normal-case tracking-normal font-normal">
                        (optional)
                    </span>
                </SectionLabel>
                <GroupsPicker
                    groups={w.groups}
                    selected={w.selectedGroups}
                    onToggle={w.toggleGroup}
                />
                <FieldHint>
                    Group memberships apply across every workspace the group is bound to.
                </FieldHint>
            </div>

            {/* The email-pin rule, and the way out of it. It used to disable
                the submit button with the explanation in another column; it
                now names the conflict against the audience already chosen
                and offers both real resolutions. */}
            <AnimatePresence initial={false}>
                {w.audienceConflict && (
                    <motion.div
                        key="conflict"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.18 }}
                        className="mt-6 p-4 rounded-xl bg-amber-500/[0.08] border border-amber-500/25 text-amber-700 dark:text-amber-300"
                    >
                        <div className="flex items-start gap-3">
                            <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                            <div className="text-xs leading-relaxed flex-1 min-w-0">
                                <p className="font-semibold">
                                    {w.isPrivileged
                                        ? 'A privileged role cannot go on a shareable link.'
                                        : 'Group attachments cannot go on a shareable link.'}
                                </p>
                                <p className="mt-1 text-amber-700/80 dark:text-amber-300/80">
                                    {w.isPrivileged
                                        ? 'This role grants admin or system permissions. Pinning to one address stops a forwarded link from escalating someone else.'
                                        : 'Group memberships can reach across workspaces. Pinning to one address stops a forwarded link from granting the wrong identity that access.'}
                                </p>
                                <div className="mt-3 flex items-center gap-2 flex-wrap">
                                    <button
                                        type="button"
                                        onClick={() => { w.pickAudience('person'); onFixAudience() }}
                                        className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-amber-500 text-white hover:brightness-110 transition-all"
                                    >
                                        Pin it to one person
                                    </button>
                                    {w.overrideAvailable && !w.overrideConfirmOpen && (
                                        <button
                                            type="button"
                                            onClick={() => { w.setOverrideConfirmOpen(true); w.setOverrideAck(false) }}
                                            className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:underline"
                                        >
                                            Keep it shareable anyway →
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        <AnimatePresence initial={false}>
                            {w.overrideConfirmOpen && (
                                <motion.div
                                    key="override"
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.18 }}
                                    className="overflow-hidden"
                                >
                                    <div className="mt-3 p-3.5 rounded-xl bg-canvas-elevated border border-amber-500/40 text-ink">
                                        <div className="flex items-start gap-2.5">
                                            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                            <div className="text-xs leading-snug flex-1 min-w-0">
                                                <p className="font-bold">Override the email pin?</p>
                                                <p className="mt-1 text-ink-secondary">
                                                    Anyone with this link can sign up and join{' '}
                                                    <span className="font-semibold text-ink">
                                                        {w.selectedGroupNames.join(', ')}
                                                    </span>. Forwardable and reusable — only override for
                                                    low-stakes, broadly-shared groups.
                                                </p>
                                                <label className="mt-2.5 flex items-start gap-2 cursor-pointer select-none">
                                                    <input
                                                        type="checkbox"
                                                        checked={w.overrideAck}
                                                        onChange={e => w.setOverrideAck(e.target.checked)}
                                                        className="mt-0.5 accent-amber-500 cursor-pointer"
                                                    />
                                                    <span className="text-[11px] text-ink-secondary">
                                                        I understand this link can be shared and reused by
                                                        multiple people.
                                                    </span>
                                                </label>
                                                <div className="mt-3 flex items-center gap-2 flex-wrap">
                                                    <button
                                                        type="button"
                                                        onClick={() => { w.setOverrideConfirmOpen(false); w.setOverrideAck(false) }}
                                                        className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={!w.overrideAck}
                                                        onClick={() => { w.setAllowShareableGroups(true); w.setOverrideConfirmOpen(false) }}
                                                        className={cn(
                                                            'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors',
                                                            w.overrideAck
                                                                ? 'bg-amber-500 text-white hover:brightness-110'
                                                                : 'bg-amber-500/30 text-amber-700 dark:text-amber-300 cursor-not-allowed',
                                                        )}
                                                    >
                                                        <Lock className="w-3 h-3" />
                                                        Make shareable
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )}
            </AnimatePresence>

            {w.overrideActive && (
                <div className="mt-6 flex items-start gap-3 p-4 rounded-xl bg-slate-500/10 border border-slate-500/25 text-slate-700 dark:text-slate-300">
                    <Users2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <div className="text-xs leading-relaxed flex-1 min-w-0">
                        <p className="font-semibold">Shareable group invite</p>
                        <p className="mt-0.5 text-slate-700/80 dark:text-slate-300/80">
                            Anyone with this link can sign up and join the selected{' '}
                            {w.selectedGroupNames.length === 1 ? 'group' : 'groups'}.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => w.setAllowShareableGroups(false)}
                        className="p-1 -m-1 rounded-md text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                        title="Require email instead"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}
        </div>
    )
}
