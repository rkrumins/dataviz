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

/** Which control is holding publication back. The server resolves this
 *  (`publishBlockedBy` on the access envelope) so the UI never has to
 *  guess which of the three it is. */
export type PublishBlockedBy = 'platform' | 'workspace' | 'source' | null

/**
 * Why approval is needed, in the words of whoever is actually asking.
 *
 * "Ask a workspace admin" is wrong — actively misleading — when the
 * organisation set the rule, because the workspace admin cannot help
 * and the person is sent to the wrong door. And it reads as a bug when
 * the workspace is open and only THIS source is restricted.
 */
const APPROVAL_HINT: Record<'platform' | 'workspace' | 'source', string> = {
    platform:
        'Needs approval — your organisation reviews everything published ' +
        'to everyone',
    workspace:
        'Needs approval — ask a workspace admin to publish',
    source:
        'Needs approval — this data source is restricted, so a workspace ' +
        'admin publishes views over it',
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
    /**
     * Owns this view's sharing settings at all — creator or workspace
     * admin. This is the FIRST gate, before any publish rule: without
     * it no tier is reachable, and the reason has nothing to do with
     * the publish permission.
     *
     * Defaults to true so surfaces that only know about publishing keep
     * their existing behaviour. Pass the envelope's value wherever you
     * have it, or the picker tells a stranger to go and request a
     * permission that still would not let them touch the view.
     */
    canChangeVisibility?: boolean
    /** May ask a publish-permission holder to publish this view. */
    canRequestPublish?: boolean
    /** The block comes from the SOURCE being restricted rather than from
     *  the workspace's policy — worth saying, because in an open
     *  workspace the same person publishes other views without asking. */
    restrictedSource?: boolean
    /** Which control is holding publication back. Three greyed-out tiles
     *  that look identical mean three different things, and only one of
     *  them can be resolved by asking a workspace admin. */
    blockedBy?: PublishBlockedBy
    /** The deployment offers the enterprise tier at all. False DROPS the
     *  option rather than disabling it — a choice nobody here can ever
     *  make is noise, and a permanently grey tile invites people to keep
     *  asking why. */
    enterpriseAvailable?: boolean
    appName?: string
    workspaceName?: string
}): VisibilityOption[] {
    const {
        saved, canPublish, canChangeVisibility = true, canRequestPublish,
        restrictedSource, blockedBy,
        enterpriseAvailable = true, appName, workspaceName,
    } = args
    const tiers = enterpriseAvailable || saved === 'enterprise'
        ? VISIBILITY_ORDER
        : VISIBILITY_ORDER.filter(id => id !== 'enterprise')
    return tiers.map(id => {
        let disabled = false
        let disabledReason: string | undefined
        let requiresApproval = false
        let approvalHint: string | undefined
        if (!canChangeVisibility) {
            // The outer gate. Nothing below applies: the publish
            // permission would not help this person, and neither would
            // a request — asking to publish a view whose sharing you do
            // not own is not a thing the backend offers.
            disabled = id !== saved
            disabledReason = disabled
                ? 'Only the view’s creator or a workspace admin can '
                  + 'change who sees it.'
                : undefined
        } else if (!canPublish) {
            if (id === 'enterprise' && saved !== 'enterprise') {
                if (canRequestPublish) {
                    requiresApproval = true
                    approvalHint = APPROVAL_HINT[
                        blockedBy ?? (restrictedSource ? 'source' : 'workspace')
                    ]
                } else {
                    disabled = true
                    disabledReason = blockedBy === 'platform'
                        ? 'Your organisation does not allow views to be ' +
                          'published to everyone on this deployment.'
                        : 'Publishing to everyone needs the "Publish views" ' +
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

/**
 * What a tier actually grants, in the words a person would use.
 *
 * The tier NAMES are the least informative thing about them. "Enterprise"
 * does not tell you that a stranger gets read-only access to the whole
 * data source behind the view, and "Private" does not tell you that
 * workspace admins can still open it. Every surface that offers this
 * choice renders from here, so the answer to "what am I agreeing to?"
 * is the same everywhere it is asked.
 *
 * `cannot` is not padding. The fear that stops people sharing is that
 * publishing means losing control of the thing — saying plainly that
 * nobody else can change it, delete it, or reach the rest of the
 * workspace is what makes the choice safe to make.
 */
export interface VisibilityGrants {
    /** What the audience can do once they have it. */
    can: readonly string[]
    /** What they still cannot do — the reassurance half. */
    cannot: readonly string[]
}

export function visibilityGrants(
    visibility: ViewVisibility,
    opts?: { appName?: string; workspaceName?: string },
): VisibilityGrants {
    const workspace = opts?.workspaceName ?? 'the workspace'
    switch (visibility) {
        case 'private':
            return {
                can: [
                    'You can open, edit and delete it',
                    `Workspace admins in ${workspace} can open it`,
                    'Anyone you share it with directly can open it',
                ],
                cannot: [
                    'It stays out of Explorer, search and trending for everyone else',
                    'Nobody else in the workspace can find it',
                ],
            }
        case 'workspace':
            return {
                can: [
                    `Everyone in ${workspace} can open it`,
                    'They can explore, expand, trace lineage and search inside it',
                    'It appears in their Explorer and search results',
                ],
                cannot: [
                    'People outside the workspace cannot open it',
                    'Only you and workspace admins can change or delete it',
                ],
            }
        case 'enterprise':
            return {
                can: [
                    `Anyone signed in to ${opts?.appName ?? 'the platform'} can open it`,
                    'They can explore, expand, trace lineage and search inside it',
                    'They get read-only access to the data source behind it',
                ],
                cannot: [
                    'They cannot change this view, or edit any data',
                    'They cannot see other views, or anything else in the workspace',
                    'Only you and workspace admins can unpublish it',
                ],
            }
    }
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
