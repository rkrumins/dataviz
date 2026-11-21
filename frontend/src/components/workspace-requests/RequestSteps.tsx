/**
 * The Request a workspace wizard's steps: what it's for, who it's for, what it will
 * work with, and a last look before sending. Each is a centred column with a hero
 * question, in the ViewWizard idiom (`InviteWizard/ui`).
 */
import {
    BarChart3, Check, Database, Eye, FlaskConical, Inbox, KeyRound, Link2, MessageSquareText, Pencil, Plus, Send, Shield,
    Sparkles, Target, Trash2, Upload, User, Users, UsersRound, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    groupFullName, type ProposedGroup, type ProposedGroupRole, type WorkspacePurpose, type WorkspaceRequestDraft,
} from '@/services/workspaceRequestsService'
import { SubjectPicker, subjectKey } from '@/components/serviceAccounts/SubjectPicker'
import { BigInput, BigTextarea, FieldLabel, Hint, StepBlock, StepColumn, StepHero } from '@/components/admin/InviteWizard/ui'
import { IdpGroupInput } from '@/components/workspaces/IdpGroupInput'
import { NextSteps } from './NextSteps'

export const PURPOSES: { value: WorkspacePurpose; label: string; detail: string; icon: LucideIcon; example: string }[] = [
    { value: 'team', label: 'A team’s home', detail: 'Lineage a team relies on every day', icon: Users, example: 'Finance Data' },
    { value: 'project', label: 'A project', detail: 'Time-boxed work with a goal', icon: Target, example: 'Billing migration' },
    { value: 'poc', label: 'A proof of concept', detail: 'Prove an idea before it goes further', icon: FlaskConical, example: 'Lineage for the ML platform' },
    { value: 'reporting', label: 'Reporting', detail: 'The lineage behind the numbers', icon: BarChart3, example: 'Regulatory returns' },
    { value: 'other', label: 'Something else', detail: 'Tell the platform team in your words', icon: Sparkles, example: 'My workspace' },
]

export const purposeLabel = (p: WorkspacePurpose) => PURPOSES.find(x => x.value === p)?.label ?? p

export interface PersonChip { id: string; name: string; detail?: string }

export const GROUP_ROLES: { value: ProposedGroupRole; label: string; detail: string; icon: LucideIcon }[] = [
    { value: 'workspace_viewer', label: 'Can view', detail: 'Open and explore views', icon: Eye },
    { value: 'workspace_member', label: 'Can edit', detail: 'Build views and change data in drafts', icon: Pencil },
    { value: 'workspace_publisher', label: 'Can publish', detail: 'Edit, and publish changes to the data', icon: Upload },
]
export const groupRoleLabel = (r: ProposedGroupRole) => GROUP_ROLES.find(x => x.value === r)?.label ?? r

/** A proposed group's own id, unique on this page. */
let groupKeys = 0
function newGroupKey(): string {
    groupKeys += 1
    return `g${groupKeys}${Math.random().toString(36).slice(2, 7)}`
}

/** Quick starts for the Groups step. */
const STARTERS: { name: string; role: ProposedGroupRole }[] = [
    { name: 'Editors', role: 'workspace_member' },
    { name: 'Viewers', role: 'workspace_viewer' },
    { name: 'Publishers', role: 'workspace_publisher' },
]
export interface GraphOption { id: string; label: string; viewCount: number }

type Patch = (patch: Partial<WorkspaceRequestDraft>) => void

// ── 1. What it's for ────────────────────────────────────────────────────
export function PurposeStep({ draft, onChange, nameError, suggestion, onUseSuggestion }: {
    draft: WorkspaceRequestDraft
    onChange: Patch
    nameError?: string | null
    suggestion?: string | null
    onUseSuggestion: (name: string) => void
}) {
    const chosen = PURPOSES.find(p => p.value === draft.purpose) ?? PURPOSES[0]
    const length = draft.name.trim().length
    return (
        <StepColumn wide>
            <StepHero pill="Your own workspace" pillIcon={Sparkles} title="What’s it for?"
                subtitle="A few words about what you’d like to do. The platform team sets it up — you won’t need to configure anything." />
            <StepBlock delay={0.04}>
                <div role="radiogroup" aria-label="What it’s for" className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {PURPOSES.map(p => {
                        const on = p.value === draft.purpose
                        const Icon = p.icon
                        return (
                            <button key={p.value} type="button" role="radio" aria-checked={on}
                                onClick={() => onChange({ purpose: p.value })}
                                className={cn(
                                    'group flex flex-col items-start gap-2 rounded-2xl border-2 p-3.5 text-left transition-all duration-150',
                                    on ? 'border-violet-500 bg-violet-500/[0.06] shadow-md shadow-violet-500/10'
                                        : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-violet-500/40 hover:-translate-y-0.5',
                                )}>
                                <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl transition-colors',
                                    on ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'bg-violet-500/10 text-violet-600 dark:text-violet-300')}>
                                    <Icon className="h-[18px] w-[18px]" aria-hidden />
                                </span>
                                <span>
                                    <span className="block text-sm font-semibold text-ink">{p.label}</span>
                                    <span className="block text-[11px] leading-snug text-ink-muted">{p.detail}</span>
                                </span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>
            <StepBlock delay={0.08}>
                <FieldLabel required hint={`${length} / 120`}>Name</FieldLabel>
                <BigInput
                    aria-label="Name"
                    value={draft.name}
                    onChange={e => onChange({ name: e.target.value })}
                    placeholder={`e.g. ${chosen.example}`}
                    maxLength={120}
                    autoFocus
                    aria-invalid={!!nameError}
                    state={nameError ? 'invalid' : length > 0 ? 'valid' : 'idle'}
                />
                {nameError ? (
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-rose-600 dark:text-rose-400" role="alert">
                        {nameError}
                        {suggestion && (
                            <button type="button" onClick={() => onUseSuggestion(suggestion)}
                                className="rounded-full bg-violet-500/10 px-2.5 py-1 font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/20">
                                Use “{suggestion}”
                            </button>
                        )}
                    </p>
                ) : <Hint>What people will see in the sidebar and the workspace list. The platform team may tweak it.</Hint>}
            </StepBlock>
            <StepBlock delay={0.12}>
                <FieldLabel hint="optional">Who should use it, and for what?</FieldLabel>
                <BigTextarea rows={3} aria-label="Who should use it, and for what?" value={draft.description ?? ''} onChange={e => onChange({ description: e.target.value })}
                    placeholder="e.g. The data team’s lineage for month-end close, from the ledger to every report."
                    maxLength={2000} className="font-sans" />
            </StepBlock>
        </StepColumn>
    )
}

// ── 2. Who it's for ─────────────────────────────────────────────────────
export function TeamStep({ draft, onChange, teammates, onAddTeammate, onRemoveTeammate, meId, meName }: {
    draft: WorkspaceRequestDraft
    onChange: Patch
    teammates: PersonChip[]
    onAddTeammate: (p: PersonChip) => void
    onRemoveTeammate: (id: string) => void
    meId?: string
    meName: string
}) {
    return (
        <StepColumn wide>
            <StepHero pill="People" pillIcon={Users} title="Who’s it for?"
                subtitle="You’ll be its admin. Name your teammates and they’ll join as members the moment it’s approved." />
            <StepBlock delay={0.04}>
                <FieldLabel hint="optional">Team or department</FieldLabel>
                <BigInput aria-label="Team or department" value={draft.teamName ?? ''} onChange={e => onChange({ teamName: e.target.value })}
                    placeholder="e.g. Finance Data Engineering" maxLength={120} icon={Users} />
            </StepBlock>
            <StepBlock delay={0.08} className="space-y-3">
                <ul aria-label="Who will be in it" className="space-y-2">
                    <li className="flex items-center gap-3 rounded-2xl border border-violet-500/25 bg-violet-500/[0.05] px-3.5 py-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
                            <User className="h-4 w-4" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-ink truncate">{meName} <span className="font-normal text-ink-muted">(you)</span></span>
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2.5 py-1 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                            <Shield className="h-3 w-3" aria-hidden /> Admin
                        </span>
                    </li>
                    {teammates.map(t => (
                        <li key={t.id} className="flex items-center gap-3 rounded-2xl border border-glass-border bg-canvas-elevated px-3.5 py-2.5">
                            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 text-xs font-bold">
                                {t.name.slice(0, 1).toUpperCase()}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-medium text-ink truncate">{t.name}</span>
                                {t.detail && <span className="block text-[11px] text-ink-muted truncate">{t.detail}</span>}
                            </span>
                            <span className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-ink-secondary">Member</span>
                            <button type="button" onClick={() => onRemoveTeammate(t.id)} aria-label={`Remove ${t.name}`}
                                className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                                <X className="h-4 w-4" />
                            </button>
                        </li>
                    ))}
                </ul>
                <SubjectPicker
                    label="Add teammates"
                    types={['user']}
                    exclude={[...teammates.map(t => subjectKey({ type: 'user', id: t.id })), ...(meId ? [subjectKey({ type: 'user', id: meId })] : [])]}
                    onPick={s => onAddTeammate({ id: s.id, name: s.name, detail: s.detail })}
                />
                <Hint>You can invite more people yourself once it’s ready.</Hint>
            </StepBlock>
        </StepColumn>
    )
}

// ── 3. Groups, for governance (optional) ───────────────────────────────
export function GroupsStep({ workspaceName, groups, people, onChange, onRemember }: {
    workspaceName: string
    groups: ProposedGroup[]
    /** Names for the people picked, by id. */
    people: Record<string, string>
    onChange: (groups: ProposedGroup[]) => void
    onRemember: (p: PersonChip) => void
}) {
    const add = (name = '', role: ProposedGroupRole = 'workspace_member') =>
        onChange([...groups, { key: newGroupKey(), name, role, memberIds: [], idpGroup: '' }])
    const update = (key: string, p: Partial<ProposedGroup>) => onChange(groups.map(g => g.key === key ? { ...g, ...p } : g))
    const names = groups.map(g => g.name.trim().toLowerCase())
    return (
        <StepColumn wide>
            <StepHero pill="Groups · optional" pillIcon={UsersRound} title="Organise people into groups"
                subtitle="Groups keep access easy to govern: each gets a role in the workspace, you invite colleagues, and you can link it to a group in your identity provider so membership follows it." />
            {groups.length === 0 && (
                <StepBlock delay={0.04} className="rounded-2xl border border-dashed border-glass-border p-5 text-center">
                    <p className="text-sm text-ink-secondary">No groups yet — people you named join as members directly. Start with one of these:</p>
                    <div className="mt-3 flex flex-wrap justify-center gap-2">
                        {STARTERS.map(s => (
                            <button key={s.name} type="button" onClick={() => add(s.name, s.role)}
                                className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/[0.06] px-3 py-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-500/10">
                                <Plus className="h-3.5 w-3.5" aria-hidden /> {s.name} <span className="font-normal text-ink-muted">· {groupRoleLabel(s.role)}</span>
                            </button>
                        ))}
                    </div>
                </StepBlock>
            )}
            {groups.map((g, i) => {
                const duplicate = !!g.name.trim() && names.indexOf(g.name.trim().toLowerCase()) !== i
                return (
                    <StepBlock key={g.key} delay={0.04}>
                        <section aria-label={`Group ${g.name || i + 1}`} className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 space-y-4">
                            <div className="flex items-start gap-3">
                                <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
                                    <UsersRound className="h-4 w-4" aria-hidden />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <input aria-label="Group name" value={g.name} maxLength={80} placeholder="e.g. Engineers"
                                        onChange={e => update(g.key, { name: e.target.value })}
                                        className={cn('w-full rounded-xl border-2 bg-canvas-elevated px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-indigo-500',
                                            duplicate || !g.name.trim() ? 'border-rose-400/70' : 'border-black/[0.10] dark:border-white/[0.12]')} />
                                    <p className="mt-1 text-[11px] text-ink-muted">
                                        {duplicate ? 'Two groups can’t share a name.'
                                            : g.name.trim() ? <>Created as “{groupFullName(workspaceName || 'Your workspace', g.name)}”</> : 'Give it a name.'}
                                    </p>
                                </div>
                                <button type="button" onClick={() => onChange(groups.filter(x => x.key !== g.key))} aria-label={`Remove ${g.name || 'this group'}`}
                                    className="rounded-lg p-1.5 text-ink-muted hover:text-rose-600 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button>
                            </div>

                            <div role="radiogroup" aria-label="What the group can do" className="grid grid-cols-3 gap-2">
                                {GROUP_ROLES.map(r => {
                                    const on = g.role === r.value
                                    return (
                                        <button key={r.value} type="button" role="radio" aria-checked={on} onClick={() => update(g.key, { role: r.value })}
                                            className={cn('rounded-xl border-2 px-2.5 py-2 text-left transition-colors',
                                                on ? 'border-violet-500 bg-violet-500/[0.06]' : 'border-black/[0.08] dark:border-white/[0.10] hover:border-violet-500/40')}>
                                            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink"><r.icon className="h-3.5 w-3.5 text-violet-500" aria-hidden />{r.label}</span>
                                            <span className="mt-0.5 block text-[10px] leading-snug text-ink-muted">{r.detail}</span>
                                        </button>
                                    )
                                })}
                            </div>

                            <div className="space-y-2">
                                {g.memberIds.length > 0 && (
                                    <ul aria-label={`Invited to ${g.name || 'this group'}`} className="flex flex-wrap gap-1.5">
                                        {g.memberIds.map(id => (
                                            <li key={id} className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 py-1 pl-2.5 pr-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                                                {people[id] ?? id}
                                                <button type="button" aria-label={`Remove ${people[id] ?? id}`} onClick={() => update(g.key, { memberIds: g.memberIds.filter(x => x !== id) })}
                                                    className="rounded-full p-0.5 hover:bg-indigo-500/20"><X className="h-3 w-3" /></button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <SubjectPicker label="Invite colleagues" types={['user']}
                                    exclude={g.memberIds.map(id => subjectKey({ type: 'user', id }))}
                                    onPick={p => { onRemember({ id: p.id, name: p.name, detail: p.detail }); update(g.key, { memberIds: [...g.memberIds, p.id] }) }} />
                            </div>

                            <div className="rounded-xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-3">
                                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                    <KeyRound className="h-3.5 w-3.5 text-violet-500" aria-hidden /> Link to your identity provider
                                    <span className="font-normal text-ink-muted">optional</span>
                                </p>
                                <IdpGroupInput value={g.idpGroup ?? ''} onChange={v => update(g.key, { idpGroup: v })} />
                                <p className="mt-1.5 text-[11px] text-ink-muted">
                                    The group’s name or ID in Active Directory, Entra, Okta… — we suggest the ones your own sign-ins carry. People in it then join this group when they sign in. A platform administrator confirms the link.
                                </p>
                            </div>
                        </section>
                    </StepBlock>
                )
            })}
            {groups.length > 0 && groups.length < 10 && (
                <StepBlock>
                    <button type="button" onClick={() => add()}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-black/[0.10] dark:border-white/[0.12] py-3 text-sm font-semibold text-ink-secondary hover:border-violet-500/40 hover:text-violet-700 dark:hover:text-violet-300">
                        <Plus className="h-4 w-4" aria-hidden /> Add another group
                    </button>
                </StepBlock>
            )}
        </StepColumn>
    )
}

// ── 4. What it will work with ───────────────────────────────────────────
export function DataStep({ draft, onChange, graphs, playgroundOn }: {
    draft: WorkspaceRequestDraft
    onChange: Patch
    graphs: GraphOption[]
    playgroundOn: boolean
}) {
    const toggle = (id: string) => onChange({
        playgroundSourceIds: draft.playgroundSourceIds.includes(id)
            ? draft.playgroundSourceIds.filter(x => x !== id)
            : [...draft.playgroundSourceIds, id],
    })
    return (
        <StepColumn wide>
            <StepHero pill="Data" pillIcon={Database} title="What will you work with?"
                subtitle="Bring what you built in the Playground, and tell the platform team which data to connect." />
            {playgroundOn && (
                <StepBlock delay={0.04}>
                    <FieldLabel hint="optional">Bring from the Playground</FieldLabel>
                    {graphs.length === 0 ? (
                        <p className="rounded-2xl border border-dashed border-glass-border px-4 py-5 text-center text-sm text-ink-muted">
                            You haven’t built anything in the Playground yet — that’s fine. The new workspace starts empty.
                        </p>
                    ) : (
                        <div role="group" aria-label="Your Playground graphs" className="grid gap-2.5 sm:grid-cols-2">
                            {graphs.map(g => {
                                const on = draft.playgroundSourceIds.includes(g.id)
                                return (
                                    <button key={g.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(g.id)}
                                        className={cn(
                                            'flex items-center gap-3 rounded-2xl border-2 p-3 text-left transition-all duration-150',
                                            on ? 'border-violet-500 bg-violet-500/[0.06]' : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-violet-500/40',
                                        )}>
                                        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                                            on ? 'bg-violet-500 text-white' : 'bg-violet-500/10 text-violet-600 dark:text-violet-300')}>
                                            {on ? <Check className="h-4 w-4" aria-hidden /> : <FlaskConical className="h-4 w-4" aria-hidden />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-semibold text-ink truncate">{g.label}</span>
                                            <span className="block text-[11px] text-ink-muted">
                                                {g.viewCount === 0 ? 'No views yet' : `${g.viewCount} view${g.viewCount === 1 ? '' : 's'}`} · moves with its views
                                            </span>
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                    {draft.playgroundSourceIds.length > 0 && (
                        <Hint>When it’s approved these leave the Playground for your workspace. Views of yours that others opened there go with them.</Hint>
                    )}
                </StepBlock>
            )}
            <StepBlock delay={0.08}>
                <FieldLabel hint="optional">Data you’ll need</FieldLabel>
                <BigTextarea rows={3} aria-label="Data you’ll need" value={draft.dataNeeds ?? ''} onChange={e => onChange({ dataNeeds: e.target.value })}
                    placeholder="e.g. Snowflake finance marts and the dbt project “core”."
                    maxLength={2000} className="font-sans" />
                <Hint>Which systems or sources should the platform team connect for you? Once the workspace is approved, you can follow it there.</Hint>
            </StepBlock>
        </StepColumn>
    )
}

// ── 5. A last look ──────────────────────────────────────────────────────
export function ReviewStep({ draft, onChange, teammates, graphs, meName, question, people = {} }: {
    draft: WorkspaceRequestDraft
    onChange: Patch
    teammates: PersonChip[]
    graphs: GraphOption[]
    meName: string
    question?: string | null
    people?: Record<string, string>
}) {
    const purpose = PURPOSES.find(p => p.value === draft.purpose) ?? PURPOSES[0]
    const groups = draft.groups ?? []
    const bringing = graphs.filter(g => draft.playgroundSourceIds.includes(g.id))
    return (
        <StepColumn wide>
            <StepHero pill="Review" pillIcon={Send} title={question ? 'Answer and send it back' : 'Ready to send?'}
                subtitle={question ? 'Change what you need to, answer the question below, and send it back to the platform team.'
                    : 'Here’s what the platform team will see. Add a note if there’s anything else they should know.'} />
            <StepBlock delay={0.04}>
                <div className="overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
                    <div className="relative flex items-start gap-3 p-4 border-b border-glass-border">
                        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet-500/[0.07] to-fuchsia-500/[0.03]" />
                        <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/20">
                            <purpose.icon className="h-5 w-5" aria-hidden />
                        </span>
                        <span className="relative min-w-0">
                            <span className="block font-display text-lg font-bold text-ink truncate">{draft.name.trim() || 'Untitled'}</span>
                            <span className="block text-xs text-ink-muted">{purpose.label}{draft.teamName?.trim() ? ` · ${draft.teamName.trim()}` : ''}</span>
                            {draft.description?.trim() && <span className="mt-1 block text-sm text-ink-secondary">{draft.description.trim()}</span>}
                        </span>
                    </div>
                    <dl className="divide-y divide-glass-border text-sm">
                        <Row icon={Users} label="People">
                            {meName} (admin){teammates.length > 0 ? ` and ${teammates.length} teammate${teammates.length === 1 ? '' : 's'}: ${teammates.map(t => t.name).join(', ')}` : ''}
                        </Row>
                        {groups.length > 0 && (
                            <Row icon={UsersRound} label="Groups">
                                <ul className="space-y-1">
                                    {groups.map(g => (
                                        <li key={g.key}>
                                            <span className="font-medium">{g.name.trim()}</span>
                                            <span className="text-ink-muted"> · {groupRoleLabel(g.role)}{g.memberIds.length ? ` · ${g.memberIds.map(id => people[id] ?? id).join(', ')}` : ''}</span>
                                            {g.idpGroup?.trim() && (
                                                <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                                                    <Link2 className="h-3 w-3" aria-hidden /> {g.idpGroup.trim()}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </Row>
                        )}
                        <Row icon={FlaskConical} label="From the Playground">
                            {bringing.length === 0 ? 'Nothing — it starts empty'
                                : bringing.map(g => `${g.label}${g.viewCount ? ` (${g.viewCount} view${g.viewCount === 1 ? '' : 's'})` : ''}`).join(', ')}
                        </Row>
                        <Row icon={Database} label="Data to connect">{draft.dataNeeds?.trim() || 'None named'}</Row>
                    </dl>
                </div>
            </StepBlock>
            <StepBlock delay={0.08}>
                <FieldLabel hint={question ? 'your answer' : 'optional'}>
                    <MessageSquareText className="inline h-4 w-4 mr-1 -mt-0.5 text-violet-500" aria-hidden />
                    {question ? 'Reply to the platform team' : 'A note to the platform team'}
                </FieldLabel>
                <BigTextarea rows={3} aria-label={question ? 'Reply to the platform team' : 'A note to the platform team'} value={draft.note ?? ''} onChange={e => onChange({ note: e.target.value })}
                    placeholder={question ? 'Your answer…' : 'e.g. We’d like it before the quarter-end close.'}
                    maxLength={2000} className="font-sans" />
            </StepBlock>
            <StepBlock delay={0.12}>
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4">
                    <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        <Inbox className="h-3.5 w-3.5" aria-hidden /> What happens next
                    </p>
                    <NextSteps reached={0} />
                </div>
            </StepBlock>
        </StepColumn>
    )
}

function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3">
            <dt className="flex w-40 shrink-0 items-center gap-2 text-xs font-semibold text-ink-muted">
                <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
            </dt>
            <dd className="min-w-0 flex-1 text-ink">{children}</dd>
        </div>
    )
}
