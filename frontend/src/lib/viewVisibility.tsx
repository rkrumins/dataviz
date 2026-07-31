/**
 * The single source of truth for view visibility: the union type, the
 * icon map, ONE plain-language description set, the option builder
 * (with publish gating), and literal Tailwind accent classes.
 *
 * History: eight surfaces (ShareViewDialog, ViewTitleMenu,
 * ExplorerViewCard, ExplorerListRow, ExplorerPreviewDrawer,
 * BasicsStep, ExplorerBulkActions, EditDetailsPanel) each carried
 * their own copy of this data with three conflicting description
 * strings — and the share dialog built its accent classes by string
 * interpolation, which Tailwind's JIT can't see, so selected tiles
 * never actually got their colors. Everything visibility-flavored
 * imports from here now; the accent classes are literals on purpose.
 */
import type { LucideIcon } from 'lucide-react'
import { Globe, Lock, Users } from 'lucide-react'

export type ViewVisibility = 'private' | 'workspace' | 'enterprise'

/** Narrow → broad; every picker renders in this order. */
export const VISIBILITY_ORDER: readonly ViewVisibility[] = [
    'private', 'workspace', 'enterprise',
] as const

export const VISIBILITY_ICON: Record<ViewVisibility, LucideIcon> = {
    private: Lock,
    workspace: Users,
    enterprise: Globe,
}

const LABEL: Record<ViewVisibility, string> = {
    private: 'Private',
    workspace: 'Workspace',
    enterprise: 'Enterprise',
}

export function visibilityLabel(visibility: ViewVisibility): string {
    return LABEL[visibility]
}

/**
 * The one plain-language sentence per tier. Brand- and workspace-aware
 * via options so surfaces with context read naturally ("Everyone in
 * Finance") and surfaces without still make sense.
 */
export function visibilityDescription(
    visibility: ViewVisibility,
    opts?: { appName?: string; workspaceName?: string },
): string {
    switch (visibility) {
        case 'private':
            return "Only you, people it's shared with, and workspace admins"
        case 'workspace':
            return `Everyone in ${opts?.workspaceName ?? "this view's workspace"}`
        case 'enterprise':
            return (
                `Anyone signed in to ${opts?.appName ?? 'the platform'} — ` +
                "read-only outside the view's workspace"
            )
    }
}

export interface VisibilityOption {
    id: ViewVisibility
    label: string
    description: string
    icon: LucideIcon
    disabled: boolean
    disabledReason?: string
}

/**
 * Options for a visibility picker, honoring the publish rule: any
 * transition to OR from `enterprise` needs the publish permission, so
 * without it the enterprise tile is disabled — and on an already-
 * published view the two lower tiles are, symmetrically.
 */
export function buildVisibilityOptions(args: {
    /** The view's current tier; undefined for mixed/bulk selections. */
    current?: ViewVisibility
    canPublish: boolean
    appName?: string
    workspaceName?: string
}): VisibilityOption[] {
    const { current, canPublish, appName, workspaceName } = args
    return VISIBILITY_ORDER.map(id => {
        let disabled = false
        let disabledReason: string | undefined
        if (!canPublish) {
            if (id === 'enterprise' && current !== 'enterprise') {
                disabled = true
                disabledReason =
                    'Publishing to everyone needs the "Publish views" ' +
                    'permission — ask a workspace admin.'
            } else if (current === 'enterprise' && id !== 'enterprise') {
                disabled = true
                disabledReason =
                    'Unpublishing needs the "Publish views" permission — ' +
                    'ask a workspace admin.'
            }
        }
        return {
            id,
            label: visibilityLabel(id),
            description: visibilityDescription(id, { appName, workspaceName }),
            icon: VISIBILITY_ICON[id],
            disabled,
            disabledReason,
        }
    })
}

export interface VisibilityAccent {
    /** Selected-tile border, e.g. the share dialog's picker cards. */
    tileBorder: string
    /** Selected-tile wash. */
    tileBg: string
    /** Icon tint. */
    iconText: string
    /** Small chip/badge background. */
    chipBg: string
    /** Small chip/badge border. */
    chipBorder: string
    /** Selected checkmark tint. */
    check: string
}

/**
 * LITERAL class strings only — never build these by interpolation;
 * Tailwind's JIT scans source text and can't emit classes it can't
 * read. (lib/__tests__/viewVisibility.test.ts pins this.)
 */
export const VISIBILITY_ACCENT: Record<ViewVisibility, VisibilityAccent> = {
    private: {
        tileBorder: 'border-indigo-500',
        tileBg: 'bg-indigo-500/5',
        iconText: 'text-indigo-400',
        chipBg: 'bg-indigo-500/10',
        chipBorder: 'border-indigo-500/30',
        check: 'text-indigo-400',
    },
    workspace: {
        tileBorder: 'border-sky-500',
        tileBg: 'bg-sky-500/5',
        iconText: 'text-sky-400',
        chipBg: 'bg-sky-500/10',
        chipBorder: 'border-sky-500/30',
        check: 'text-sky-400',
    },
    enterprise: {
        tileBorder: 'border-amber-500',
        tileBg: 'bg-amber-500/5',
        iconText: 'text-amber-400',
        chipBg: 'bg-amber-500/10',
        chipBorder: 'border-amber-500/30',
        check: 'text-amber-400',
    },
}
