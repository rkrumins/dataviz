/**
 * Every decision the invite wizard makes, in one place.
 *
 * The rules here are load-bearing and predate the wizard: a privileged
 * role or a group attachment forces an email pin, because that pin is the
 * only thing stopping a forwarded link from escalating whoever opens it.
 * Splitting the form into steps must not soften them, so they live here
 * rather than in any one step, and the steps only render what they say.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { permissionsService, type RoleDefinitionResponse } from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { ROLE_NAMES } from '@/lib/roleNames'
import type { CreateInviteOptions } from '@/services/adminUserService'
import {
    roleIsPrivileged, roleNeedsWorkspace, inviteRoleVisual,
    _BUILTIN_ORDER, _ROLE_FALLBACK_DESC, _ROLE_VISUAL_NONE,
    type RoleOption,
} from './roleModel'

export type WizardStep = 'audience' | 'access' | 'safety' | 'review'
export type Audience = 'person' | 'several' | 'domain' | 'anyone'
export type Expiry = '24h' | '7d' | '30d' | '90d'

const EXPIRY_HOURS: Record<Expiry, number> = {
    '24h': 24, '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90,
}

export type InviteWizardState = ReturnType<typeof useInviteWizard>

export function useInviteWizard({ canGrantSuperAdmin }: { canGrantSuperAdmin: boolean }) {
    const [step, setStep] = useState<WizardStep>('audience')
    const [audience, setAudience] = useState<Audience | null>(null)

    const [roles, setRoles] = useState<RoleDefinitionResponse[] | null>(null)
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[] | null>(null)
    const [groups, setGroups] = useState<GroupResponse[] | null>(null)

    const [selectedRole, setSelectedRole] = useState('')
    const [workspaceId, setWorkspaceId] = useState('')
    const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
    const [email, setEmail] = useState('')
    const [bulkEmails, setBulkEmails] = useState('')
    const [emailDomain, setEmailDomain] = useState('')
    const [expiresIn, setExpiresIn] = useState<Expiry>('7d')
    const [maxUses, setMaxUses] = useState<number | null>(null)

    // Opt-in override for shareable group invites. Off by default; flips on
    // only after the admin acknowledges the warning, and resets itself when
    // the conditions that allowed it change.
    const [allowShareableGroups, setAllowShareableGroups] = useState(false)
    const [overrideConfirmOpen, setOverrideConfirmOpen] = useState(false)
    const [overrideAck, setOverrideAck] = useState(false)

    useEffect(() => {
        permissionsService.listRoles()
            .then(rs => setRoles(canGrantSuperAdmin ? rs : rs.filter(r => r.name !== ROLE_NAMES.SUPER_ADMIN)))
            .catch(() => setRoles([]))
        workspaceService.list().then(setWorkspaces).catch(() => setWorkspaces([]))
        groupsService.list().then(setGroups).catch(() => setGroups([]))
    }, [canGrantSuperAdmin])

    const roleObj = useMemo(
        () => roles?.find(r => r.name === selectedRole) ?? null,
        [roles, selectedRole],
    )
    const isPrivileged = roleObj ? roleIsPrivileged(roleObj.permissions) : false
    const isWorkspaceScoped = roleObj ? roleNeedsWorkspace(roleObj) : false
    const fixedWorkspaceId = roleObj && roleObj.scopeType === 'workspace' ? roleObj.scopeId : null
    const needsWorkspacePick = isWorkspaceScoped && !fixedWorkspaceId
    const effectiveWorkspaceId = fixedWorkspaceId ?? (needsWorkspacePick ? workspaceId : null)

    const hasGroups = selectedGroups.size > 0
    const groupsRequireEmail = hasGroups && !allowShareableGroups
    const needsEmail = isPrivileged || groupsRequireEmail
    const overrideAvailable = hasGroups && !isPrivileged
    const overrideActive = allowShareableGroups && overrideAvailable

    // Never let a stale override survive the conditions that permitted it.
    useEffect(() => {
        if (!overrideAvailable && allowShareableGroups) {
            setAllowShareableGroups(false)
            setOverrideConfirmOpen(false)
            setOverrideAck(false)
        }
    }, [overrideAvailable, allowShareableGroups])

    const emailValid = /.+@.+\..+/.test(email.trim())
    const domainValid = /^@?[^\s@]+\.[^\s@]+$/.test(emailDomain.trim())
    const bulkEmailList = useMemo(
        () => bulkEmails.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
        [bulkEmails],
    )

    /** Choosing an audience carries its own safe defaults.
     *
     *  This is why the question is asked first. The dialog this replaces
     *  defaulted to "anyone with the link · unlimited · 30 days" — the
     *  widest invite the product can mint, reached by touching nothing.
     *  Settings a given audience cannot use are cleared rather than left
     *  to leak into the submit. */
    const pickAudience = useCallback((next: Audience) => {
        setAudience(next)
        if (next !== 'person') setEmail('')
        if (next !== 'several') setBulkEmails('')
        if (next !== 'domain') setEmailDomain('')
        setMaxUses(next === 'person' ? 1 : next === 'domain' ? 25 : next === 'anyone' ? 5 : null)
        setExpiresIn(next === 'domain' ? '30d' : '7d')
    }, [])

    const toggleGroup = useCallback((id: string) => {
        setSelectedGroups(prev => {
            const nx = new Set(prev)
            if (nx.has(id)) nx.delete(id); else nx.add(id)
            return nx
        })
    }, [])

    const bulkMode = audience === 'several'

    const audienceReady =
        audience === 'person' ? emailValid
        : audience === 'several' ? bulkEmailList.length > 0
        : audience === 'domain' ? domainValid
        : audience === 'anyone'

    // The pin rule can now contradict an audience already chosen, so the
    // access step has to surface it rather than disable a later button.
    const audienceConflict = needsEmail && audience !== 'person' && audience !== 'several'

    const canSubmit = bulkMode
        ? bulkEmailList.length > 0 && (!needsWorkspacePick || !!workspaceId)
        : (!needsWorkspacePick || !!workspaceId) && (!needsEmail || emailValid)

    const canAdvance =
        step === 'audience' ? audienceReady
        : step === 'access' ? (!needsWorkspacePick || !!workspaceId) && !audienceConflict
        : step === 'safety' ? true
        : canSubmit

    // ── Role catalogue ────────────────────────────────────────────────
    // Only two buckets are surfaced: organization-wide tiers, and custom
    // roles. Built-in workspace tiers belong in each workspace's own
    // Members tab — this flow is about getting someone into the org.
    const { platformTiers, customRoles, noRole } = useMemo(() => {
        const opt = (r: RoleDefinitionResponse): RoleOption => ({
            value: r.name,
            label: roleVisualFor(r.name).label,
            sublabel: r.description?.trim()
                || _ROLE_FALLBACK_DESC[r.name]
                || (roleNeedsWorkspace(r) ? 'Workspace-scoped role.' : 'Global role.'),
            privileged: roleIsPrivileged(r.permissions),
            scoped: roleNeedsWorkspace(r),
            fixedWorkspaceId: r.scopeType === 'workspace' ? r.scopeId : null,
            visual: inviteRoleVisual(r.name),
            isBuiltin: r.isSystem,
        })
        const platformTiers: RoleOption[] = []
        const customRoles: RoleOption[] = []
        for (const o of (roles ?? []).map(opt)) {
            if (!o.isBuiltin) { customRoles.push(o); continue }
            if (o.scoped) continue
            platformTiers.push(o)
        }
        const byCanonical = (a: RoleOption, b: RoleOption) => {
            const ia = _BUILTIN_ORDER.indexOf(a.value)
            const ib = _BUILTIN_ORDER.indexOf(b.value)
            if (ia >= 0 && ib >= 0) return ia - ib
            if (ia >= 0) return -1
            if (ib >= 0) return 1
            return a.label.localeCompare(b.label)
        }
        platformTiers.sort(byCanonical)
        customRoles.sort((a, b) => a.label.localeCompare(b.label))
        return {
            platformTiers,
            customRoles,
            noRole: {
                value: '',
                label: 'Standard user',
                sublabel: 'A regular team account with no organization-wide privileges. A workspace admin will invite them into specific workspaces with the right role from inside that workspace.',
                privileged: false, scoped: false, fixedWorkspaceId: null,
                visual: _ROLE_VISUAL_NONE, isBuiltin: false,
            } as RoleOption,
        }
    }, [roles])

    const selectedGroupNames = useMemo(() => {
        if (!groups) return []
        return Array.from(selectedGroups)
            .map(id => groups.find(g => g.id === id)?.name)
            .filter((n): n is string => !!n)
    }, [groups, selectedGroups])

    const workspaceName = effectiveWorkspaceId
        ? (workspaces?.find(x => x.id === effectiveWorkspaceId)?.name ?? effectiveWorkspaceId)
        : null
    const roleLabel = selectedRole ? roleVisualFor(selectedRole).label : null

    /**
     * How far this link reaches, 0–100.
     *
     * A meter, not a score with a decimal point: it is a single ratio
     * against a ceiling, and it exists to make "anyone · unlimited · 90
     * days · org admin" feel different from "one person · 1 seat · 7
     * days" BEFORE the link is minted rather than in an audit later. The
     * weights are ordinal, not a risk model — each term is one thing that
     * widens the blast radius, and the label beside it always says which.
     */
    const exposure = useMemo(() => {
        let n = 0
        n += audience === 'anyone' ? 40 : audience === 'domain' ? 22 : 6
        n += maxUses === null ? 25 : maxUses > 20 ? 16 : maxUses > 1 ? 8 : 0
        n += expiresIn === '90d' ? 20 : expiresIn === '30d' ? 12 : expiresIn === '7d' ? 5 : 0
        n += isPrivileged ? 15 : hasGroups ? 7 : 0
        const pct = Math.min(100, n)
        const band = pct >= 65 ? 'wide' : pct >= 35 ? 'moderate' : 'narrow'
        return { pct, band } as const
    }, [audience, maxUses, expiresIn, isPrivileged, hasGroups])

    /** Only things that are true, and only things worth saying. */
    const warnings = useMemo(() => {
        const out: string[] = []
        if (step === 'safety' || step === 'review') {
            if (audience === 'anyone' && maxUses === null) {
                out.push('Nothing closes this link but its expiry — anyone it reaches can sign up until then.')
            }
            if (expiresIn === '90d' && audience !== 'person') {
                out.push('Ninety days is a long time for a link you do not control the spread of.')
            }
        }
        if (step === 'review' && isPrivileged) {
            out.push(`${roleLabel} grants admin or system permissions across the organization.`)
        }
        return out
    }, [step, audience, maxUses, expiresIn, isPrivileged, roleLabel])

    const audienceSummary =
        audience === 'person' ? (email.trim() || 'One person')
        : audience === 'several' ? `${bulkEmailList.length} people`
        : audience === 'domain' ? `@${emailDomain.trim().replace(/^@/, '')}`
        : audience === 'anyone' ? 'Anyone with the link'
        : null

    const accessSummary = [
        roleLabel ?? 'Standard user',
        workspaceName ? `in ${workspaceName}` : null,
        selectedGroupNames.length ? `+${selectedGroupNames.length} group${selectedGroupNames.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' ')

    const safetySummary = bulkMode
        ? expiresIn
        : `${maxUses === null ? '∞' : maxUses} seat${maxUses === 1 ? '' : 's'} · ${expiresIn}`

    const generateLabel = bulkMode && bulkEmailList.length > 1
        ? `Generate ${bulkEmailList.length} links`
        : 'Generate link'

    const buildPayload = useCallback(() => {
        if (!canSubmit) return null
        const shared = {
            workspaceId: isWorkspaceScoped ? effectiveWorkspaceId : null,
            groupIds: hasGroups ? Array.from(selectedGroups) : null,
            expiresInHours: EXPIRY_HOURS[expiresIn],
        }
        if (bulkMode) {
            return {
                kind: 'bulk' as const,
                emails: bulkEmailList,
                role: selectedRole || null,
                opts: shared satisfies CreateInviteOptions,
            }
        }
        return {
            kind: 'single' as const,
            role: selectedRole || null,
            opts: {
                ...shared,
                email: email.trim() || null,
                allowShareableWithGroups: overrideActive,
                maxUses,
                // A pin is strictly narrower, so sending both would store a
                // constraint that can never bind. The backend drops it too.
                emailDomain: email.trim() ? null : (emailDomain.trim() || null),
            } satisfies CreateInviteOptions,
        }
    }, [
        canSubmit, isWorkspaceScoped, effectiveWorkspaceId, hasGroups, selectedGroups,
        expiresIn, bulkMode, bulkEmailList, selectedRole, email, overrideActive,
        maxUses, emailDomain,
    ])

    return {
        step, setStep, audience, pickAudience,
        roles, workspaces, groups,
        selectedRole, setSelectedRole, workspaceId, setWorkspaceId,
        selectedGroups, toggleGroup, selectedGroupNames,
        email, setEmail, bulkEmails, setBulkEmails, emailDomain, setEmailDomain,
        expiresIn, setExpiresIn, maxUses, setMaxUses,
        allowShareableGroups, setAllowShareableGroups,
        overrideConfirmOpen, setOverrideConfirmOpen, overrideAck, setOverrideAck,
        isPrivileged, isWorkspaceScoped, fixedWorkspaceId, needsWorkspacePick,
        needsEmail, overrideAvailable, overrideActive, audienceConflict,
        emailValid, domainValid, bulkEmailList, bulkMode,
        platformTiers, customRoles, noRole,
        roleLabel, workspaceName,
        canAdvance, canSubmit, exposure, warnings,
        audienceSummary, accessSummary, safetySummary, generateLabel,
        buildPayload,
    }
}
