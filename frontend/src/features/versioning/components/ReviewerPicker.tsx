/**
 * ReviewerPicker — choose who must approve a review before it can merge: people, and — where the
 * caller takes them (`onGroupsChange`) — groups, any of whose members answers for the group. The
 * people are the workspace's members who can approve; the server leaves out the caller, who opens
 * the review, where the data source's policy has someone else approve it. The groups are those that
 * may review here, each with how many people are in it. A search narrows both. Like the share
 * dialog's picker, it loads them only once opened.
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, UserPlus, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  listReviewerCandidates, listReviewerGroups, type ReviewerCandidate, type ReviewerGroup,
} from '@/services/versioningApiService'

const ROW = 'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
const NOTE = 'px-3 py-2 text-center text-xs text-ink-muted'

export function ReviewerPicker({ wsId, dataSourceId, value, onChange, groups = [], onGroupsChange, showChosen = true }: {
  wsId: string
  /** The review's data source, whose policy says whether its opener may approve it. */
  dataSourceId?: string | null
  value: string[]
  onChange: (userIds: string[]) => void
  /** The groups chosen; groups are offered only with `onGroupsChange`. */
  groups?: string[]
  onGroupsChange?: (groupIds: string[]) => void
  /** Off where those chosen are listed already (a review's reviewers). */
  showChosen?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState<ReviewerCandidate[] | null>(null)
  const [failed, setFailed] = useState(false)
  const withGroups = !!onGroupsChange
  const [groupList, setGroupList] = useState<ReviewerGroup[] | null>(null)
  const [groupsFailed, setGroupsFailed] = useState(false)

  useEffect(() => {
    if (!open || people) return
    let cancelled = false
    listReviewerCandidates(wsId, dataSourceId).then(
      (r) => { if (!cancelled) setPeople(r) },
      () => { if (!cancelled) { setFailed(true); setPeople([]) } },
    )
    return () => { cancelled = true }
  }, [open, people, wsId, dataSourceId])

  useEffect(() => {
    if (!open || !withGroups || groupList) return
    let cancelled = false
    listReviewerGroups(wsId).then(
      (r) => { if (!cancelled) setGroupList(r) },
      () => { if (!cancelled) { setGroupsFailed(true); setGroupList([]) } },
    )
    return () => { cancelled = true }
  }, [open, withGroups, groupList, wsId])

  const name = (id: string) => people?.find((p) => p.userId === id)?.displayName || id
  const groupName = (id: string) => groupList?.find((g) => g.groupId === id)?.name || id
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  const toggleGroup = (id: string) => onGroupsChange?.(groups.includes(id) ? groups.filter((g) => g !== id) : [...groups, id])

  const needle = query.trim().toLowerCase()
  const matches = (...texts: Array<string | null | undefined>) => !needle || texts.some((t) => t?.toLowerCase().includes(needle))
  const shownPeople = people?.filter((p) => matches(p.displayName, p.email, p.userId)) ?? null
  const shownGroups = groupList?.filter((g) => matches(g.name, g.description)) ?? null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {showChosen && groups.map((id) => (
          <Badge key={`g:${id}`} tone="accent" size="md">
            <Users className="w-3 h-3" aria-hidden />
            {groupName(id)}
            <button onClick={() => toggleGroup(id)} aria-label={`Remove ${groupName(id)}`} className="hover:text-ink">
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
        {showChosen && value.map((id) => (
          <Badge key={id} tone="accent" size="md">
            {name(id)}
            <button onClick={() => toggle(id)} aria-label={`Remove ${name(id)}`} className="hover:text-ink">
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
        <Button variant="ghost" size="sm" leftIcon={UserPlus} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Add reviewers
        </Button>
      </div>
      {open && (
        <div className="rounded-lg border border-glass-border">
          <div className="p-1.5 border-b border-glass-border/60">
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
              aria-label={withGroups ? 'Search people and groups' : 'Search people'}
              placeholder={withGroups ? 'Search people and groups…' : 'Search people…'}
              className="w-full h-7 rounded-md bg-transparent px-2 text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40" />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {withGroups && (
              <>
                <p className="px-3 pt-2 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">Groups</p>
                {shownGroups === null ? (
                  <p className={NOTE}><Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" /> Loading groups…</p>
                ) : shownGroups.length === 0 ? (
                  <p className={NOTE}>
                    {groupsFailed ? 'Couldn’t load the groups.' : needle ? 'No group matches.' : 'No group can review here.'}
                  </p>
                ) : (
                  shownGroups.map((g) => {
                    const picked = groups.includes(g.groupId)
                    return (
                      <button key={g.groupId} onClick={() => toggleGroup(g.groupId)} aria-pressed={picked}
                        className={cn(ROW, picked && 'text-accent-lineage')}>
                        <Users className="w-3.5 h-3.5 shrink-0 text-ink-muted" aria-hidden />
                        <span className="flex-1 min-w-0 truncate">
                          {g.name}
                          <span className="ml-1.5 text-[11px] text-ink-muted tabular-nums">
                            {g.memberCount.toLocaleString()} member{g.memberCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        {picked && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                    )
                  })
                )}
                <p className="px-3 pt-2 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">People</p>
              </>
            )}
            {shownPeople === null ? (
              <p className={NOTE}><Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" /> Loading people…</p>
            ) : shownPeople.length === 0 ? (
              <p className={NOTE}>
                {failed ? 'Couldn’t load who can review.' : needle ? 'No one matches.' : 'No one else in this workspace can approve.'}
              </p>
            ) : (
              shownPeople.map((p) => {
                const picked = value.includes(p.userId)
                return (
                  <button key={p.userId} onClick={() => toggle(p.userId)} aria-pressed={picked}
                    className={cn(ROW, picked && 'text-accent-lineage')}>
                    <span className="flex-1 min-w-0 truncate">
                      {p.displayName || p.userId}
                      {p.email && <span className="ml-1.5 text-[11px] text-ink-muted">{p.email}</span>}
                    </span>
                    {picked && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
