/**
 * The rules for one IdP group, together.
 *
 * The table this replaces had one row per mapping sorted by nothing in
 * particular, so the three rules attached to `engineering` were scattered
 * among the rules for everything else. But the question an operator asks
 * is always "what does *this group* get?" — a person complains, you find
 * out which groups they are in, and you look those up.
 *
 * So the group name is the heading and its rules are the contents. That
 * also makes the answer to "what happens if I remove someone from
 * engineering" a single card rather than a scan.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Trash2, Users } from 'lucide-react'

import type { IdpGroupMapping, IdpProvider } from '@/services/ssoAdminService'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { GroupResponse } from '@/services/groupsService'
import { roleVisualFor } from '@/lib/roleVisual'
import { cn } from '@/lib/utils'

export interface MappingGroup {
    idpGroup: string
    rows: IdpGroupMapping[]
}

/** One card per IdP group, rules inside, stable order. */
export function groupMappings(rows: IdpGroupMapping[]): MappingGroup[] {
    const byGroup = new Map<string, IdpGroupMapping[]>()
    for (const r of rows) {
        const list = byGroup.get(r.idpGroup) ?? []
        list.push(r)
        byGroup.set(r.idpGroup, list)
    }
    return [...byGroup.entries()]
        .map(([idpGroup, rs]) => ({ idpGroup, rows: rs }))
        .sort((a, b) => a.idpGroup.localeCompare(b.idpGroup))
}

export function MappingGroupCard({
    group, providers, workspaces, groups, busy, index, onDelete,
}: {
    group: MappingGroup
    providers: IdpProvider[]
    workspaces: WorkspaceResponse[]
    groups: GroupResponse[]
    busy: boolean
    index: number
    onDelete: (id: string) => void
}) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, delay: Math.min(index, 6) * 0.04 }}
            className="rounded-2xl border-2 border-black/[0.08] dark:border-white/[0.10] overflow-hidden"
        >
            <div className="flex items-center gap-2 px-4 py-2.5 bg-black/[0.02] dark:bg-white/[0.03] border-b border-black/[0.06] dark:border-white/[0.08]">
                <Users className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                <span className="font-mono text-xs font-semibold text-ink truncate">
                    {group.idpGroup}
                </span>
                <span className="text-[10px] text-ink-muted">
                    {group.rows.length} rule{group.rows.length === 1 ? '' : 's'}
                </span>
            </div>

            <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.08]">
                {group.rows.map(row => (
                    <li
                        key={row.id}
                        className="flex items-center gap-3 px-4 py-3 group/row"
                    >
                        <span className="text-[11px] text-ink-muted shrink-0 w-28 truncate">
                            {providerLabel(row, providers)}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                        <span className="min-w-0 flex-1">
                            <Target row={row} workspaces={workspaces} groups={groups} />
                        </span>
                        <DeleteRule
                            busy={busy}
                            label={group.idpGroup}
                            onConfirm={() => onDelete(row.id)}
                        />
                    </li>
                ))}
            </ul>
        </motion.div>
    )
}

function providerLabel(row: IdpGroupMapping, providers: IdpProvider[]): string {
    if (!row.providerId) return 'any connection'
    const p = providers.find(x => x.id === row.providerId)
    return p ? (p.displayName || p.slug) : row.providerId
}

function Target({
    row, workspaces, groups,
}: {
    row: IdpGroupMapping
    workspaces: WorkspaceResponse[]
    groups: GroupResponse[]
}) {
    if (row.targetType === 'role_binding') {
        const visual = roleVisualFor(row.roleName ?? '')
        // Resolve the id to the name it was chosen by. Falling back to the
        // raw id keeps a deleted workspace legible rather than blank.
        const where = row.scopeType === 'workspace'
            ? workspaces.find(w => w.id === row.scopeId)?.name ?? row.scopeId
            : null
        return (
            <span className="flex items-center gap-1.5 flex-wrap">
                <span className={cn(
                    'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border',
                    visual.badge,
                )}>
                    {visual.label}
                </span>
                <span className="text-[11px] text-ink-muted">
                    {where ? `in ${where}` : 'across the organization'}
                </span>
            </span>
        )
    }
    const g = groups.find(x => x.id === row.targetGroupId)
    return (
        <span className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-black/[0.06] dark:bg-white/[0.10] text-ink-secondary">
                <Users className="w-2.5 h-2.5" />
                {g?.name ?? row.targetGroupId}
            </span>
            <span className="text-[11px] text-ink-muted">membership</span>
        </span>
    )
}

/**
 * Deleting a rule takes access away from everyone it covers, so it asks —
 * but in place, and only twice-clicked rather than typed. A `confirm()`
 * here was both unstyleable and, on a page of near-identical rows, gave no
 * clue which one you were about to remove.
 */
function DeleteRule({
    busy, label, onConfirm,
}: {
    busy: boolean
    label: string
    onConfirm: () => void
}) {
    const [armed, setArmed] = useState(false)

    if (armed) {
        return (
            <span className="flex items-center gap-1.5 shrink-0">
                <button
                    type="button"
                    disabled={busy}
                    onClick={onConfirm}
                    className="px-2 py-1 rounded-lg bg-red-500 text-white text-[11px] font-medium hover:bg-red-600 disabled:opacity-50"
                >
                    Remove
                </button>
                <button
                    type="button"
                    onClick={() => setArmed(false)}
                    className="px-2 py-1 rounded-lg text-[11px] text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                >
                    Keep
                </button>
            </span>
        )
    }

    return (
        <button
            type="button"
            disabled={busy}
            aria-label={`Remove this rule for ${label}`}
            onClick={() => setArmed(true)}
            className="shrink-0 p-1.5 rounded-lg text-ink-muted opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:bg-red-500/10 hover:text-red-500 transition-opacity"
        >
            <Trash2 className="w-3.5 h-3.5" />
        </button>
    )
}
