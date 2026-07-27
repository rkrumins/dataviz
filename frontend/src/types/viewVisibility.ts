/**
 * Canonical view-visibility tiers — the single source of truth for the FE.
 *
 * Prior to this module the union `'private' | 'workspace' | 'enterprise'`
 * was redeclared in ~15 files and the option lists (label, description,
 * icon) were duplicated across five selectors and four read-only badge
 * maps. They had already drifted: the same tier was described as
 * "Only you can see this view" in the create wizard, "Only you (and
 * workspace admins) can see this view" in the share dialog, and "Only you
 * can see it" in the edit panel — with `organisation`/`organization`
 * spelled both ways. Every consumer now imports from here.
 *
 * The backend's equivalent lives in `backend/common/view_visibility.py` —
 * the two files must stay in lock-step. That module owns the DB CHECK
 * constraint and the access evaluator; this one owns how the tiers are
 * named and described to users.
 */
import { Building2, Globe, Lock, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export const VIEW_VISIBILITY = {
    PRIVATE: 'private',
    WORKSPACE: 'workspace',
    ENTERPRISE: 'enterprise',
    PUBLIC: 'public',
} as const

export type ViewVisibility = (typeof VIEW_VISIBILITY)[keyof typeof VIEW_VISIBILITY]

/**
 * Ordered narrowest → widest. The tiers form a strictly widening ladder:
 * each reaches everyone the previous one reaches, plus more. Render them
 * in this order everywhere so the escalation is visually obvious.
 */
export const VISIBILITY_ORDER: readonly ViewVisibility[] = [
    VIEW_VISIBILITY.PRIVATE,
    VIEW_VISIBILITY.WORKSPACE,
    VIEW_VISIBILITY.ENTERPRISE,
    VIEW_VISIBILITY.PUBLIC,
] as const

export interface VisibilityMeta {
    /** Short label for badges, chips and menu items. */
    label: string
    /** One-line explanation of exactly who this reaches. */
    description: string
    /** Sentence used when confirming a change to this tier. */
    reach: string
    icon: LucideIcon
    /** Tailwind colour family for accent styling. */
    accent: 'slate' | 'sky' | 'indigo' | 'amber'
}

export const VISIBILITY_META: Record<ViewVisibility, VisibilityMeta> = {
    private: {
        label: 'Private',
        description: 'Only you, people you share it with, and workspace admins',
        reach: 'only you, anyone you share it with explicitly, and admins of its workspace',
        icon: Lock,
        accent: 'slate',
    },
    workspace: {
        label: 'Workspace',
        description: 'Everyone in this view’s workspace',
        reach: 'everyone with access to this view’s workspace',
        icon: Users,
        accent: 'sky',
    },
    enterprise: {
        label: 'Enterprise',
        description: 'Everyone in the organisation, in any workspace',
        reach: 'everyone in the organisation — including people who are not in this workspace',
        icon: Building2,
        accent: 'indigo',
    },
    public: {
        label: 'Public',
        description: 'Everyone signed in to the platform, workspace or not',
        reach: 'every signed-in account on the platform, including people with no workspace access at all',
        icon: Globe,
        accent: 'amber',
    },
}

/** Fallback for a legacy or unrecognised value read off the wire. */
export const DEFAULT_VISIBILITY: ViewVisibility = VIEW_VISIBILITY.PRIVATE

export function isViewVisibility(value: unknown): value is ViewVisibility {
    return typeof value === 'string'
        && (VISIBILITY_ORDER as readonly string[]).includes(value)
}

/**
 * Meta for a value that may be legacy, absent, or a tier this build
 * doesn't know about. Never throws — the badge must always render.
 */
export function visibilityMeta(value: unknown): VisibilityMeta {
    return VISIBILITY_META[isViewVisibility(value) ? value : DEFAULT_VISIBILITY]
}

/**
 * True when moving `from` → `to` exposes the view to more people. Drives
 * the confirmation step on bulk changes and the warning copy in the share
 * dialog: narrowing is safe, widening deserves a beat of friction.
 */
export function isWidening(from: unknown, to: unknown): boolean {
    const a = VISIBILITY_ORDER.indexOf(isViewVisibility(from) ? from : DEFAULT_VISIBILITY)
    const b = VISIBILITY_ORDER.indexOf(isViewVisibility(to) ? to : DEFAULT_VISIBILITY)
    return b > a
}

/**
 * Why a given caller can see a given view. Mirrors
 * `backend/app/services/view_access.py: ReadReason`, stamped per-caller on
 * `View.grantedBy`.
 *
 * This exists because nothing in the product could answer "why can I see
 * this view?" — which is why a visibility leak took a code audit to
 * diagnose rather than a glance at a tooltip.
 */
export const GRANTED_BY_COPY: Record<string, string> = {
    'creator': 'You created this view',
    'grant': 'Shared with you directly',
    'workspace-admin': 'You administer this view’s workspace',
    'system-admin': 'You’re a platform administrator',
    'tier:workspace': 'Shared with this view’s workspace',
    'tier:enterprise': 'Shared with the whole organisation',
    'tier:public': 'Shared with everyone on the platform',
}

/** Human sentence for a `grantedBy` value, or null when it's absent. */
export function grantedByCopy(reason: unknown): string | null {
    if (typeof reason !== 'string') return null
    return GRANTED_BY_COPY[reason] ?? null
}
