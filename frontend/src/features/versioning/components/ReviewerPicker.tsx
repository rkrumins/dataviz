/**
 * ReviewerPicker — choose who must approve a review before it can merge. The candidates are the
 * workspace's members who can approve; the server leaves out the caller, who is the review's author.
 * Like the share dialog's picker, it loads them only once opened.
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, UserPlus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { listReviewerCandidates, type ReviewerCandidate } from '@/services/versioningApiService'

export function ReviewerPicker({ wsId, value, onChange }: {
  wsId: string
  value: string[]
  onChange: (userIds: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<ReviewerCandidate[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open || people) return
    let cancelled = false
    listReviewerCandidates(wsId).then(
      (r) => { if (!cancelled) setPeople(r) },
      () => { if (!cancelled) { setFailed(true); setPeople([]) } },
    )
    return () => { cancelled = true }
  }, [open, people, wsId])

  const name = (id: string) => people?.find((p) => p.userId === id)?.displayName || id
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {value.map((id) => (
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
        <div className="rounded-lg border border-glass-border max-h-40 overflow-y-auto">
          {people === null ? (
            <p className="p-3 text-center text-xs text-ink-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" /> Loading people…
            </p>
          ) : people.length === 0 ? (
            <p className="p-3 text-center text-xs text-ink-muted">
              {failed ? 'Couldn’t load who can review.' : 'No one else in this workspace can approve.'}
            </p>
          ) : (
            people.map((p) => {
              const picked = value.includes(p.userId)
              return (
                <button
                  key={p.userId}
                  onClick={() => toggle(p.userId)}
                  aria-pressed={picked}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
                    picked && 'text-accent-lineage',
                  )}
                >
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
      )}
    </div>
  )
}
