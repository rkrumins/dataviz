/**
 * Role model for the invite flow — how a role is classified, ordered and
 * described, plus the field styling its controls share.
 *
 * Separate from `pickers.tsx` because these are not components: mixing the
 * two in one module breaks fast refresh, and the boundary is real anyway.
 */
import { Shield, Globe } from 'lucide-react'
import { ROLE_NAMES, WORKSPACE_TEMPLATE_ROLE_SET, type RoleName } from '@/lib/roleNames'
import { type RoleDefinitionResponse } from '@/services/permissionsService'
import { roleVisualFor } from '@/lib/roleVisual'

export const _ROLE_VISUAL_NONE = {
    icon: Globe,
    bg: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
    accent: 'text-slate-600 dark:text-slate-400',
} as const

export const _BUILTIN_ORDER: readonly string[] = [
    ROLE_NAMES.SUPER_ADMIN, ROLE_NAMES.ORG_ADMIN, ROLE_NAMES.ORG_AUDITOR,
    ROLE_NAMES.WORKSPACE_ADMIN, ROLE_NAMES.WORKSPACE_DATA_ENGINEER,
    ROLE_NAMES.WORKSPACE_MEMBER, ROLE_NAMES.WORKSPACE_VIEWER,
]

export const _ROLE_FALLBACK_DESC: Record<string, string> = {
    [ROLE_NAMES.SUPER_ADMIN]: 'Full administrator. Unrestricted access across the whole organization.',
    [ROLE_NAMES.ORG_ADMIN]: 'Manages every workspace and creates new ones. Doesn\'t manage user accounts or sign-in.',
    [ROLE_NAMES.ORG_AUDITOR]: 'Read-only access to every workspace and the activity log.',
    [ROLE_NAMES.WORKSPACE_ADMIN]: 'Full control inside the workspace — members, settings, and content.',
    [ROLE_NAMES.WORKSPACE_DATA_ENGINEER]: 'Owns data sources, semantic layers, and views inside the workspace.',
    [ROLE_NAMES.WORKSPACE_MEMBER]: 'Day-to-day contributor. Creates and edits views and data sources.',
    [ROLE_NAMES.WORKSPACE_VIEWER]: 'Read-only access to the workspace.',
}


/** Adapter from the canonical ``RoleVisual`` to the {icon, bg, accent}
 *  shape this file's InviteForm + change-role modal use. */

/** Adapter from the canonical ``RoleVisual`` to the {icon, bg, accent}
 *  shape this file's InviteForm + change-role modal use. */
export function inviteRoleVisual(roleName: string): {
    icon: typeof Shield; bg: string; accent: string
} {
    const v = roleVisualFor(roleName)
    return {
        icon: v.icon,
        bg: v.iconBg,
        accent: `text-${v.accent}-600 dark:text-${v.accent}-400`,
    }
}

export interface RoleOption {
    value: string                 // '' = No role
    label: string
    sublabel: string
    privileged: boolean
    scoped: boolean
    fixedWorkspaceId: string | null
    visual: { icon: typeof Shield; bg: string; accent: string }
    isBuiltin: boolean
}

export function roleIsPrivileged(perms: string[]): boolean {
    return perms.some(p => p === 'workspace:admin' || p.startsWith('system:'))
}

export function roleNeedsWorkspace(role: RoleDefinitionResponse): boolean {
    return _WORKSPACE_TEMPLATE_ROLES.has(role.name as RoleName) || role.scopeType === 'workspace'
}

// ── Types & constants ────────────────────────────────────────────────

export const _WORKSPACE_TEMPLATE_ROLES = WORKSPACE_TEMPLATE_ROLE_SET

export const INPUT_CLASS =
    'w-full bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] focus:border-indigo-500/40 rounded-xl pl-10 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:outline-none transition-colors'
