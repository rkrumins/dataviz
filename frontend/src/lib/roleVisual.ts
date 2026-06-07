/**
 * Single source of truth for role visuals across the FE.
 *
 * Before this module existed, four independent copies lived in
 * AdminPermissions, AdminUsers, WorkspaceMembers, and AccessSummary,
 * and they silently drifted whenever the backend role taxonomy changed
 * (Phase 5 rename, Phase 6 additions). Every consumer now imports from
 * here, so adding a role / updating a label / swapping an icon is a
 * one-line edit and every surface picks it up.
 *
 * The canonical shape carries every field any caller needs (badge,
 * gradient, iconBg). Consumers that only render badges (AccessSummary)
 * just ignore the rest — TypeScript doesn't care.
 *
 * Adding a new role:
 *   1. Add an entry to ROLE_VISUAL below using the same keys.
 *   2. That's it — every consumer picks it up automatically.
 *
 * Adding a new visual property:
 *   1. Extend the RoleVisual interface.
 *   2. Add the value to every entry below (or make it optional).
 */
import { Shield, UserCog, Eye, Database, ScrollText, Sparkles, type LucideIcon } from 'lucide-react'

export interface RoleVisual {
    /** Display label for the role (e.g. "Super admin"). For custom
     *  roles this is the role's own name so chips don't all read
     *  "Custom". */
    label: string
    /** Lucide icon used by the chip / hero card. */
    icon: LucideIcon
    /** Colour family name (amber / rose / etc.) — used by call sites
     *  that compose dynamic class names from the accent. */
    accent: string
    /** Chip/badge classes. */
    badge: string
    /** Hero-card gradient classes (Role matrix tab uses this). */
    gradient: string
    /** Square icon-tile background classes. */
    iconBg: string
}

export const ROLE_VISUAL: Record<string, RoleVisual> = {
    // ── Phase 5 post-uplift built-ins ──────────────────────────────
    super_admin: {
        label: 'Super admin',
        icon: Shield,
        accent: 'amber',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        gradient: 'from-amber-500/20 to-amber-500/0',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    },
    org_admin: {
        label: 'Org admin',
        icon: Shield,
        accent: 'rose',
        badge: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
        gradient: 'from-rose-500/20 to-rose-500/0',
        iconBg: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
    },
    workspace_admin: {
        label: 'Workspace admin',
        icon: Shield,
        accent: 'indigo',
        badge: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
        gradient: 'from-indigo-500/20 to-indigo-500/0',
        iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    },
    workspace_member: {
        label: 'Workspace member',
        icon: UserCog,
        accent: 'sky',
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
        gradient: 'from-sky-500/20 to-sky-500/0',
        iconBg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    },
    workspace_viewer: {
        label: 'Workspace viewer',
        icon: Eye,
        accent: 'slate',
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        gradient: 'from-slate-500/20 to-slate-500/0',
        iconBg: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
    },
    // ── Phase 6 additions ─────────────────────────────────────────
    workspace_data_engineer: {
        label: 'Data engineer',
        icon: Database,
        accent: 'emerald',
        badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        gradient: 'from-emerald-500/20 to-emerald-500/0',
        iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    },
    org_auditor: {
        label: 'Org auditor',
        icon: ScrollText,
        accent: 'violet',
        badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
        gradient: 'from-violet-500/20 to-violet-500/0',
        iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
    },
    // ── Pre-uplift legacy names ───────────────────────────────────
    // Kept so any old data (audit logs, in-flight migration windows,
    // dev DBs) doesn't fall through to the "Custom" badge with the
    // wrong colour. New code should never grant these directly.
    admin: {
        label: 'Admin',
        icon: Shield,
        accent: 'amber',
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        gradient: 'from-amber-500/20 to-amber-500/0',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    },
    user: {
        label: 'User',
        icon: UserCog,
        accent: 'sky',
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
        gradient: 'from-sky-500/20 to-sky-500/0',
        iconBg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    },
    viewer: {
        label: 'Viewer',
        icon: Eye,
        accent: 'slate',
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        gradient: 'from-slate-500/20 to-slate-500/0',
        iconBg: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
    },
}

const CUSTOM_ROLE_VISUAL_BASE = {
    icon: Sparkles,
    accent: 'violet',
    badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    gradient: 'from-violet-500/20 to-violet-500/0',
    iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
} as const

/** Visual for a non-built-in role — uses the role's own name as the
 *  label so chips show e.g. "marketing_lead" instead of all reading
 *  "Custom". The Sparkles icon marks it visually distinct from
 *  system roles. */
export function customRoleVisual(roleName: string): RoleVisual {
    return { ...CUSTOM_ROLE_VISUAL_BASE, label: roleName }
}

/** Canonical lookup + fallback in one call. Use this at every chip
 *  / row / matrix-header callsite — it's the standard pattern. */
export function roleVisualFor(roleName: string): RoleVisual {
    return ROLE_VISUAL[roleName] ?? customRoleVisual(roleName)
}

/** True if the role name is a known built-in (matches the system
 *  taxonomy). Useful for filtering custom roles from system roles
 *  in pickers. */
export function isBuiltinRole(roleName: string): boolean {
    return roleName in ROLE_VISUAL
}
