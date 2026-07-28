/**
 * State and rules for creating accounts directly.
 *
 * Shares its grant model with the invite wizard on purpose — the account
 * that comes out the far end is the same account either way, so the role,
 * workspace and group rules are the same rules, resolved by the same
 * helpers. What differs is the front and back: an invite asks who the
 * LINK is for and ends in a URL; this asks who the PERSON is and ends in
 * an account that already exists.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { permissionsService, type RoleDefinitionResponse } from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { ROLE_NAMES } from '@/lib/roleNames'
import type {
    CredentialMode, CreateUserRequest, BulkCreateUsersRequest, BulkCreateUserRow,
} from '@/services/adminUserService'
import {
    roleIsPrivileged, roleNeedsWorkspace, inviteRoleVisual,
    _BUILTIN_ORDER, _ROLE_FALLBACK_DESC, _ROLE_VISUAL_NONE,
    type RoleOption,
} from '@/components/admin/InviteWizard/roleModel'

export type CreateStep = 'people' | 'access' | 'signin' | 'review'
export type Mode = 'one' | 'many'

export type CreateUserState = ReturnType<typeof useCreateUser>

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** "grace.hopper@x.com" → "Grace Hopper".
 *
 *  Mirrors the server's own derivation so the review step can show what
 *  the bulk path will actually store, rather than a blank the user only
 *  discovers in the list afterwards. */
export function deriveName(email: string): { first: string; last: string } {
    const local = email.split('@')[0] ?? ''
    const parts = local.split(/[._\-+]+/).filter(Boolean)
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    if (parts.length >= 2) return { first: cap(parts[0]), last: parts.slice(1).map(cap).join(' ') }
    return { first: parts[0] ? cap(parts[0]) : email, last: '' }
}

export function useCreateUser({ canGrantSuperAdmin }: { canGrantSuperAdmin: boolean }) {
    const [step, setStep] = useState<CreateStep>('people')
    const [mode, setMode] = useState<Mode>('one')

    const [roles, setRoles] = useState<RoleDefinitionResponse[] | null>(null)
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[] | null>(null)
    const [groups, setGroups] = useState<GroupResponse[] | null>(null)

    const [email, setEmail] = useState('')
    const [firstName, setFirstName] = useState('')
    const [lastName, setLastName] = useState('')
    const [bulkText, setBulkText] = useState('')

    const [selectedRole, setSelectedRole] = useState('')
    const [workspaceId, setWorkspaceId] = useState('')
    const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())

    const [rawCredential, setCredential] = useState<CredentialMode>('setup_link')
    const [password, setPassword] = useState('')
    const [activate, setActivate] = useState(true)

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

    /** Parsed rows for the bulk path. Accepts "Name <a@b.com>" and bare
     *  addresses, because both are what people actually paste. */
    const bulkRows = useMemo<BulkCreateUserRow[]>(() => {
        const out: BulkCreateUserRow[] = []
        const seen = new Set<string>()
        for (const raw of bulkText.split(/[\n,;]+/)) {
            const line = raw.trim()
            if (!line) continue
            const angled = line.match(/^(.*?)<([^>]+)>$/)
            const addr = (angled ? angled[2] : line).trim().toLowerCase()
            if (seen.has(addr)) continue
            seen.add(addr)
            const namePart = angled ? angled[1].trim() : ''
            if (namePart) {
                const bits = namePart.split(/\s+/)
                out.push({ email: addr, firstName: bits[0], lastName: bits.slice(1).join(' ') })
            } else {
                out.push({ email: addr })
            }
        }
        return out
    }, [bulkText])

    const validBulk = bulkRows.filter(r => EMAIL_RE.test(r.email))
    const invalidBulk = bulkRows.filter(r => !EMAIL_RE.test(r.email))

    const emailValid = EMAIL_RE.test(email.trim())
    const passwordLongEnough = password.trim().length >= 12

    const peopleReady = mode === 'one'
        ? emailValid && firstName.trim().length > 0
        : validBulk.length > 0

    // A shared password across a batch is not a credential — the server
    // refuses it, and offering it here would only produce a 400.
    const credentialOptions = useMemo<CredentialMode[]>(
        () => (mode === 'one'
            ? ['setup_link', 'password', 'sso_only']
            : ['setup_link', 'sso_only']),
        [mode],
    )

    // Derived, not reset in an effect: switching to a list while
    // "password" is selected should simply not mean password any more.
    // Correcting it afterwards costs a render and can be seen doing it.
    const credential: CredentialMode = credentialOptions.includes(rawCredential)
        ? rawCredential
        : 'setup_link'

    const signinReady = credential !== 'password' || passwordLongEnough

    const canSubmit = peopleReady && signinReady && (!needsWorkspacePick || !!workspaceId)

    const canAdvance =
        step === 'people' ? peopleReady
        : step === 'access' ? (!needsWorkspacePick || !!workspaceId)
        : step === 'signin' ? signinReady
        : canSubmit

    const toggleGroup = useCallback((id: string) => {
        setSelectedGroups(prev => {
            const nx = new Set(prev)
            if (nx.has(id)) nx.delete(id); else nx.add(id)
            return nx
        })
    }, [])

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

    const peopleSummary = mode === 'one'
        ? (email.trim() || 'One person')
        : `${validBulk.length} ${validBulk.length === 1 ? 'person' : 'people'}`
    const accessSummary = [
        roleLabel ?? 'Standard user',
        workspaceName ? `in ${workspaceName}` : null,
        selectedGroupNames.length ? `+${selectedGroupNames.length} group${selectedGroupNames.length === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' ')
    const signinSummary =
        credential === 'setup_link' ? 'Setup link'
        : credential === 'password' ? 'Password set by you'
        : 'Single sign-on'

    const submitLabel = mode === 'many' && validBulk.length > 1
        ? `Create ${validBulk.length} accounts`
        : 'Create account'

    const warnings = useMemo(() => {
        const out: string[] = []
        if (step === 'review' && isPrivileged) {
            out.push(`${roleLabel} grants administrative permissions across the organization.`)
        }
        if (step === 'review' && credential === 'password') {
            out.push('You will need to pass this password on yourself — nothing sends it for you.')
        }
        if (step === 'review' && invalidBulk.length > 0) {
            out.push(`${invalidBulk.length} line${invalidBulk.length === 1 ? '' : 's'} will be skipped as not a valid address.`)
        }
        return out
    }, [step, isPrivileged, roleLabel, credential, invalidBulk.length])

    const buildPayload = useCallback(() => {
        if (!canSubmit) return null
        const shared = {
            role: selectedRole || null,
            workspaceId: isWorkspaceScoped ? effectiveWorkspaceId : null,
            groupIds: selectedGroups.size > 0 ? Array.from(selectedGroups) : null,
            credential,
            activate,
        }
        if (mode === 'many') {
            return { kind: 'bulk' as const, body: { ...shared, users: validBulk } satisfies BulkCreateUsersRequest }
        }
        return {
            kind: 'single' as const,
            body: {
                ...shared,
                email: email.trim(),
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                password: credential === 'password' ? password : null,
            } satisfies CreateUserRequest,
        }
    }, [
        canSubmit, selectedRole, isWorkspaceScoped, effectiveWorkspaceId, selectedGroups,
        credential, activate, mode, validBulk, email, firstName, lastName, password,
    ])

    return {
        step, setStep, mode, setMode,
        roles, workspaces, groups,
        email, setEmail, firstName, setFirstName, lastName, setLastName,
        bulkText, setBulkText, bulkRows, validBulk, invalidBulk,
        selectedRole, setSelectedRole, workspaceId, setWorkspaceId,
        selectedGroups, toggleGroup, selectedGroupNames,
        credential, setCredential, credentialOptions,
        password, setPassword, passwordLongEnough,
        activate, setActivate,
        isPrivileged, isWorkspaceScoped, fixedWorkspaceId, needsWorkspacePick,
        emailValid, platformTiers, customRoles, noRole,
        roleLabel, workspaceName,
        canAdvance, canSubmit,
        peopleSummary, accessSummary, signinSummary, submitLabel, warnings,
        buildPayload,
    }
}
