/**
 * Step 2 — what the new accounts get.
 *
 * The same controls, rules and collapse behaviour as the invite wizard's
 * access step, because it is the same decision: the account that comes
 * out is identical whichever door it came through.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Building2, Lock, ShieldPlus, ChevronDown, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    RoleListSkeleton, RoleGroup, NoRoleCard, WorkspacePicker, GroupsPicker,
} from '@/components/admin/InviteWizard/pickers'
import { StepColumn, StepHero, StepBlock, FieldLabel, Hint } from '@/components/admin/InviteWizard/ui'
import type { CreateUserState } from '../useCreateUser'

export function UserAccessStep({ w }: { w: CreateUserState }) {
    const [elevateOpen, setElevateOpen] = useState(false)

    if (w.roles === null) return <RoleListSkeleton />

    const elevateCount = w.platformTiers.length + w.customRoles.length
    const elevated = w.selectedRole !== ''
    const open = elevateOpen || elevated

    return (
        <StepColumn wide>
            <StepHero
                pill="Access"
                pillIcon={KeyRound}
                tone="emerald"
                title="What will they get?"
                subtitle="Everyone lands as a standard team member. Workspace access is granted by each workspace's admin afterwards."
            />

            <StepBlock delay={0.04}>
                <NoRoleCard
                    option={w.noRole}
                    selected={w.selectedRole === ''}
                    onSelect={() => w.setSelectedRole('')}
                />

                {elevateCount > 0 && (
                    <div className={cn(
                        'mt-4 rounded-2xl border-2 transition-colors',
                        elevated
                            ? 'border-amber-500/30 bg-amber-500/[0.04]'
                            : 'border-black/[0.10] dark:border-white/[0.12]',
                    )}>
                        <button
                            type="button"
                            onClick={() => setElevateOpen(o => !o)}
                            aria-expanded={open}
                            className="w-full flex items-center gap-3 p-4 text-left"
                        >
                            <span className={cn(
                                'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                                elevated
                                    ? 'bg-amber-500/10 border-amber-500/25 text-amber-500'
                                    : 'bg-black/[0.03] dark:bg-white/[0.05] border-black/[0.07] dark:border-white/[0.09] text-ink-muted',
                            )}>
                                <ShieldPlus className="w-4 h-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold text-ink">
                                    Give them more than that
                                </span>
                                <span className="block text-xs text-ink-muted mt-0.5">
                                    {elevated
                                        ? `Selected: ${w.roleLabel}`
                                        : `${elevateCount} organization-wide ${elevateCount === 1 ? 'role' : 'roles'} available — optional`}
                                </span>
                            </span>
                            <ChevronDown className={cn(
                                'w-4 h-4 text-ink-muted shrink-0 transition-transform duration-200',
                                open && 'rotate-180',
                            )} />
                        </button>

                        <AnimatePresence initial={false}>
                            {open && (
                                <motion.div
                                    key="elevate"
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.18 }}
                                    className="overflow-hidden"
                                >
                                    <div className="px-4 pb-4 space-y-5">
                                        {w.platformTiers.length > 0 && (
                                            <RoleGroup
                                                title="Organization-wide"
                                                subtitle="Applies everywhere, not just one workspace."
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
                                        {elevated && (
                                            <button
                                                type="button"
                                                onClick={() => w.setSelectedRole('')}
                                                className="text-xs font-semibold text-ink-secondary hover:text-ink hover:underline"
                                            >
                                                Clear — go back to standard user
                                            </button>
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </StepBlock>

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
                            <FieldLabel required>Workspace</FieldLabel>
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

            <StepBlock delay={0.08}>
                <FieldLabel hint="(optional)">Add to groups</FieldLabel>
                <GroupsPicker
                    groups={w.groups}
                    selected={w.selectedGroups}
                    onToggle={w.toggleGroup}
                />
                <Hint>
                    Group memberships apply across every workspace the group is bound to.
                </Hint>
            </StepBlock>
        </StepColumn>
    )
}
