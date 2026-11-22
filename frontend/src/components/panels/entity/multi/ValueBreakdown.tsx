/**
 * ValueBreakdown — where a property differs: each value it holds, what share of them hold it and
 * how many (and which), and the entities that hold none. A value can be applied to all of them in
 * one click; the ones missing it can be filled. Values and members are drawn a page at a time, so
 * a property with thousands of distinct values opens as fast as one with two.
 *
 * Members are named as people find them; a list opened on them adds each one's ID beneath.
 */
import { useState } from 'react'
import { ArrowRight, ChevronRight, Crosshair, PencilLine } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, IconButton } from '@/components/ui/Button'
import type { SharedField, ValueGroup } from '@/components/canvas/context-view/bulkEdit'
import { RichValue } from '../../property/RichValue'
import { CopyableId } from '../../shell/EntityRef'
import { toneOf } from './tones'

const GROUPS_PAGE = 20
const MEMBERS_PAGE = 50

/** One of the entities compared: its name, and its entity type where the drawer knows it. `ident`
 *  is its ID, shown where a list opens on it — left out where it would repeat the name. One not
 *  loaded is named "Not loaded" (never by its ID), and can't be opened. */
export interface Member { id: string; name: string; type?: string; ident?: string; notLoaded?: boolean }

export function ValueBreakdown({
  field, missing, memberOf, editable, onApply, onFill, onFocusNode, onOpenNode,
}: {
  field: SharedField
  /** The entities that hold no value for it. */
  missing: () => string[]
  memberOf: (id: string) => Member
  editable: boolean
  /** Set this value on all of them. */
  onApply?: (value: unknown) => void
  /** Give the ones without a value one. */
  onFill?: () => void
  onFocusNode?: (id: string) => void
  onOpenNode?: (id: string) => void
}) {
  const [shown, setShown] = useState(GROUPS_PAGE)
  const [open, setOpen] = useState<string | null>(null)
  const none = field.total - field.has
  const groups = field.groups.slice(0, shown)

  return (
    <div className="mt-2.5 space-y-1" role="list" aria-label={`Values of ${field.key}`}>
      {groups.map((g, i) => (
        <GroupRow
          key={g.id}
          group={g}
          tone={toneOf(i)}
          total={field.total}
          fieldKey={field.key}
          open={open === g.id}
          onToggle={() => setOpen((o) => (o === g.id ? null : g.id))}
          members={() => g.nodeIds}
          memberOf={memberOf}
          onApply={editable && onApply && g.nodeIds.length < field.total ? () => onApply(g.value) : undefined}
          onFocusNode={onFocusNode}
          onOpenNode={onOpenNode}
        />
      ))}
      {field.groups.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + GROUPS_PAGE)}
          className="ml-8 text-xs font-semibold text-accent-lineage hover:underline">
          Show {Math.min(GROUPS_PAGE, field.groups.length - shown).toLocaleString()} more of {field.groups.length.toLocaleString()} values
        </button>
      )}
      {none > 0 && (
        <GroupRow
          group={null}
          tone=""
          total={field.total}
          count={none}
          fieldKey={field.key}
          open={open === '∅'}
          onToggle={() => setOpen((o) => (o === '∅' ? null : '∅'))}
          members={missing}
          memberOf={memberOf}
          onFill={editable ? onFill : undefined}
          onFocusNode={onFocusNode}
          onOpenNode={onOpenNode}
        />
      )}
    </div>
  )
}

function GroupRow({
  group, tone, total, count, fieldKey, open, onToggle, members, memberOf, onApply, onFill, onFocusNode, onOpenNode,
}: {
  /** The value, or null for the entities that hold none. */
  group: ValueGroup | null
  tone: string
  total: number
  count?: number
  fieldKey: string
  open: boolean
  onToggle: () => void
  members: () => string[]
  memberOf: (id: string) => Member
  onApply?: () => void
  onFill?: () => void
  onFocusNode?: (id: string) => void
  onOpenNode?: (id: string) => void
}) {
  const n = group ? group.nodeIds.length : (count ?? 0)
  const share = total > 0 ? n / total : 0
  const bar = total > 0 ? Math.max(2, Math.round(share * 100)) : 0
  return (
    <div role="listitem" className="rounded-lg">
      <div className="group/value flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
        <button type="button" onClick={onToggle} aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the ${n.toLocaleString()} ${n === 1 ? 'entity' : 'entities'} ${group ? 'with this value' : 'without a value'}`}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
          <ChevronRight className={cn('w-3.5 h-3.5 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
        </button>
        <div className="flex-1 min-w-0 [&_.text-xs]:text-sm">
          {group ? <RichValue value={group.value} fieldKey={fieldKey} /> : <span className="text-sm italic text-ink-muted">Not set</span>}
        </div>
        <div className="w-16 h-2 rounded-full bg-black/[0.05] dark:bg-white/[0.08] overflow-hidden shrink-0" aria-hidden>
          <div className={cn('h-full rounded-full', group ? tone : 'bg-black/[0.15] dark:bg-white/[0.2]')} style={{ width: `${bar}%` }} />
        </div>
        <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-ink">
          {n > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`}
        </span>
        <span className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-ink-secondary">
          {n.toLocaleString()} <span className="text-ink-muted">of {total.toLocaleString()}</span>
        </span>
        {onApply && (
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-2xs opacity-0 group-hover/value:opacity-100 focus-visible:opacity-100"
            onClick={onApply} aria-label="Apply this value to all">
            Apply to all
          </Button>
        )}
        {onFill && (
          <Button size="sm" variant="ghost" leftIcon={PencilLine} onClick={onFill}>
            Fill these
          </Button>
        )}
      </div>
      {open && <MemberList ids={members()} memberOf={memberOf} onFocusNode={onFocusNode} onOpenNode={onOpenNode} />}
    </div>
  )
}

/** Who holds a value — a page at a time, each by name with its ID beneath; each can be shown on
 *  the canvas or opened. */
export function MemberList({ ids, memberOf, onFocusNode, onOpenNode, className }: {
  ids: readonly string[]
  memberOf: (id: string) => Member
  onFocusNode?: (id: string) => void
  onOpenNode?: (id: string) => void
  className?: string
}) {
  const [shown, setShown] = useState(MEMBERS_PAGE)
  return (
    <ul className={cn('ml-8 mt-0.5 mb-2 space-y-px', className)}>
      {ids.slice(0, shown).map((id) => {
        const m = memberOf(id)
        // The controls name one not loaded by its ID.
        const named = m.notLoaded ? (m.ident ?? id) : m.name
        return (
          <li key={id} className="group/member flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-md hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
            <span className="flex-1 min-w-0">
              <span className={cn('block truncate text-sm', m.notLoaded ? 'italic text-ink-muted' : 'text-ink')}>{m.name}</span>
              {m.ident && <CopyableId id={m.ident} className="-my-0.5" />}
            </span>
            {onFocusNode && (
              <IconButton icon={Crosshair} label={`Show ${named} on the canvas`} size="sm"
                className="opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100" onClick={() => onFocusNode(id)} />
            )}
            {onOpenNode && !m.notLoaded && (
              <IconButton icon={ArrowRight} label={`Open ${m.name}`} size="sm"
                className="opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100" onClick={() => onOpenNode(id)} />
            )}
          </li>
        )
      })}
      {ids.length > shown && (
        <li>
          <button type="button" onClick={() => setShown((n) => n + MEMBERS_PAGE)}
            className="pl-2.5 text-xs font-semibold text-accent-lineage hover:underline">
            Show {Math.min(MEMBERS_PAGE, ids.length - shown).toLocaleString()} more of {ids.length.toLocaleString()}
          </button>
        </li>
      )}
    </ul>
  )
}
