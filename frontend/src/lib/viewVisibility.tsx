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
    /** Selectable, but picking it files a request instead of applying the
     *  change. Only ever set on `enterprise`. */
    requiresApproval?: boolean
    /** Plain-language explanation to render alongside a `requiresApproval` tile. */
    approvalHint?: string
}

/**
 * Options for a visibility picker, honoring the publish rule: any
 * transition to OR from `enterprise` needs the publish permission, so
 * without it the enterprise tile is disabled — and on an already-
 * published view the two lower tiles are, symmetrically.
 *
 * `canRequestPublish` is the escape hatch: a caller who owns the view's
 * sharing settings but not the permission gets a LIVE enterprise tile
 * that files a request rather than a greyed-out dead end.
 */
export function buildVisibilityOptions(args: {
    /**
     * The tier the view is SAVED at — not whatever tile is selected in a
     * form. Undefined for an unsaved view (the create wizard) or a mixed
     * bulk selection. The distinction matters: the un-publish lock below
     * asks "is this view published?", and answering it with a draft
     * selection froze the wizard the instant someone picked Enterprise,
     * with no way back to Private.
     */
    saved?: ViewVisibility
    canPublish: boolean
    /** May ask a publish-permission holder to publish this view. */
    canRequestPublish?: boolean
    /** The block comes from the SOURCE being restricted rather than from
     *  the workspace's policy — worth saying, because in an open
     *  workspace the same person publishes other views without asking. */
    restrictedSource?: boolean
    appName?: string
    workspaceName?: string
}): VisibilityOption[] {
    const {
        saved, canPublish, canRequestPublish, restrictedSource,
        appName, workspaceName,
    } = args
    return VISIBILITY_ORDER.map(id => {
        let disabled = false
        let disabledReason: string | undefined
        let requiresApproval = false
        let approvalHint: string | undefined
        if (!canPublish) {
            if (id === 'enterprise' && saved !== 'enterprise') {
                if (canRequestPublish) {
                    requiresApproval = true
                    approvalHint = restrictedSource
                        ? 'Needs approval — this data source is restricted, '
                            + 'so a workspace admin publishes views over it'
                        : 'Needs approval — ask a workspace admin to publish'
                } else {
                    disabled = true
                    disabledReason =
                        'Publishing to everyone needs the "Publish views" ' +
                        'permission — ask a workspace admin.'
                }
            } else if (saved === 'enterprise' && id !== 'enterprise') {
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
            requiresApproval,
            approvalHint,
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
