/**
 * Who can use a layout template, in one vocabulary for every surface: the
 * library's tabs and badges, the studio's audience step, the share dialog.
 *
 * Stored like a view's visibility (private / workspace / enterprise) plus the
 * product's own built-ins, so the icons come from `lib/viewVisibility` — a
 * Workspace template and a Workspace view wear the same badge.
 */
import type { LucideIcon } from 'lucide-react'
import { Package } from 'lucide-react'
import { VISIBILITY_ICON } from '@/lib/viewVisibility'
import type { LayoutTemplate, TemplateVisibility } from '@/services/layoutTemplateService'

export type TemplateAudience = 'builtin' | 'organization' | 'workspace' | 'personal'

export function audienceOf(t: Pick<LayoutTemplate, 'builtIn' | 'visibility'>): TemplateAudience {
    if (t.builtIn) return 'builtin'
    if (t.visibility === 'enterprise') return 'organization'
    if (t.visibility === 'workspace') return 'workspace'
    return 'personal'
}

/** The audience a person can choose, narrow → broad. */
export const CHOOSABLE: readonly { visibility: TemplateVisibility; audience: TemplateAudience }[] = [
    { visibility: 'private', audience: 'personal' },
    { visibility: 'workspace', audience: 'workspace' },
    { visibility: 'enterprise', audience: 'organization' },
]

/** Literal classes on purpose: Tailwind cannot see interpolated ones. */
export const AUDIENCE: Record<TemplateAudience, { label: string; icon: LucideIcon; badge: string; tile: string }> = {
    builtin: {
        label: 'Built-in',
        icon: Package,
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20',
        tile: 'border-slate-400 bg-slate-500/[0.06]',
    },
    organization: {
        label: 'Organization',
        icon: VISIBILITY_ICON.enterprise,
        badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
        tile: 'border-emerald-500 bg-emerald-500/[0.06]',
    },
    workspace: {
        label: 'Workspace',
        icon: VISIBILITY_ICON.workspace,
        badge: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20',
        tile: 'border-blue-500 bg-blue-500/[0.06]',
    },
    personal: {
        label: 'Personal',
        icon: VISIBILITY_ICON.private,
        badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
        tile: 'border-amber-500 bg-amber-500/[0.06]',
    },
}

/** One sentence per audience: who can use a template kept there. */
export function audienceDescription(
    audience: TemplateAudience,
    opts?: { workspaceName?: string | null; appName?: string },
): string {
    switch (audience) {
        case 'builtin':
            return 'Ships with the product. Everyone can use it; duplicate it to make it your own.'
        case 'organization':
            return `Everyone signed in to ${opts?.appName ?? 'the platform'}. Template managers keep it current.`
        case 'workspace':
            return `Everyone in ${opts?.workspaceName || 'its workspace'}, plus anyone you share it with.`
        case 'personal':
            return 'Only you, and the people and teams you share it with.'
    }
}

export type LibraryTab = 'all' | 'favourites' | 'mine' | 'shared' | 'workspace' | 'organization' | 'builtin'

export const LIBRARY_TABS: readonly { id: LibraryTab; label: string; match: (t: LayoutTemplate) => boolean }[] = [
    { id: 'all', label: 'All', match: () => true },
    { id: 'favourites', label: 'Favorites', match: t => !!t.isFavourite },
    { id: 'mine', label: 'Mine', match: t => t.access.via === 'owner' },
    { id: 'shared', label: 'Shared with me', match: t => t.access.via === 'grant' },
    { id: 'workspace', label: 'Workspace', match: t => audienceOf(t) === 'workspace' },
    { id: 'organization', label: 'Organization', match: t => audienceOf(t) === 'organization' },
    { id: 'builtin', label: 'Built-in', match: t => t.builtIn },
]

/** "data-engineering" → "Data engineering". */
export function categoryLabel(category: string): string {
    const words = category.replace(/[-_]+/g, ' ').trim()
    return words.charAt(0).toUpperCase() + words.slice(1)
}

/** What a person can do with a template, beyond reading it. */
export type TemplateAction =
    | 'use' | 'edit' | 'duplicate' | 'export' | 'share' | 'request' | 'withdraw' | 'feature' | 'unfeature'
    | 'default' | 'hide' | 'show' | 'delete'

/** The menu's actions, in order, as `access` allows them. Duplicating and
 *  exporting are always open: a Personal copy, or a file, of something the
 *  caller can read.
 *  `canSetDefault`: the caller administers a workspace it could start from. */
export function menuActions(
    t: LayoutTemplate, opts: { canSetDefault?: boolean } = {},
): Exclude<TemplateAction, 'use'>[] {
    const out: Exclude<TemplateAction, 'use'>[] = []
    if (t.access.canEdit) out.push('edit')
    out.push('duplicate', 'export')
    if (t.access.canShare) out.push('share')
    if (t.access.canRequestPromotion) out.push('request')
    if (t.promotionRequest && !t.access.canDecidePromotion) out.push('withdraw')
    if (t.access.canFeature) out.push(t.featured ? 'unfeature' : 'feature')
    if (opts.canSetDefault) out.push('default')
    if (t.access.canHide) out.push(t.hidden ? 'show' : 'hide')
    if (t.access.canDelete) out.push('delete')
    return out
}

/** Whether new views in `workspaceId` may start from `t`: every member must be
 *  able to use it. The server's rule (`template_access.can_be_workspace_default`). */
export function canBeWorkspaceDefault(t: LayoutTemplate, workspaceId: string): boolean {
    if (t.builtIn) return !t.hidden
    return t.visibility === 'enterprise' || (t.visibility === 'workspace' && t.workspaceId === workspaceId)
}
