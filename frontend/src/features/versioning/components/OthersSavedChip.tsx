/**
 * OthersSavedChip — someone else saved into the draft you're on (the freshness poll's `savedSince`):
 * who, and how much. While you have unsaved edits it offers Refresh, so what you see changes only
 * when you say; with nothing unsaved it shows their changes at once, and says so.
 */
import { useEffect, useRef } from 'react'
import { RefreshCw, Users } from 'lucide-react'
import { ownerName } from '../model/branchVocab'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function who(by: string[], userNames?: Record<string, string>): string {
  const first = by.slice(0, 2).map((a) => ownerName(a, userNames))
  if (by.length <= 2) return first.join(' and ')
  return `${first[0]} and ${by.length - 1} others`
}

export function OthersSavedChip({ savedSince, userNames, unsavedCount, onRefresh }: {
  savedSince?: { commits: number; changes: number; by: string[]; capped: boolean } | null
  userNames?: Record<string, string>
  unsavedCount: number
  onRefresh: () => void
}) {
  const news = !!savedSince && savedSince.commits > 0
  const auto = news && unsavedCount === 0
  // Once per piece of news: the refresh moves the reader's baseline, and the next poll clears it.
  const refreshedFor = useRef<string | null>(null)
  const key = news ? `${savedSince.by.join(',')}:${savedSince.commits}:${savedSince.changes}` : null
  useEffect(() => {
    if (!auto || refreshedFor.current === key) return
    refreshedFor.current = key
    onRefresh()
  }, [auto, key, onRefresh])

  if (!news) return null
  const changes = `${savedSince.capped ? 'at least ' : ''}${plural(savedSince.changes, 'change')}`
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 text-[11px] font-medium">
      <Users className="w-3 h-3 shrink-0" />
      <span>{who(savedSince.by, userNames)} saved {changes}</span>
      {auto ? (
        <span className="text-sky-600/70 dark:text-sky-400/70">· showing them now</span>
      ) : (
        <>
          <span aria-hidden>·</span>
          <button onClick={onRefresh} className="inline-flex items-center gap-1 font-semibold hover:underline">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </>
      )}
    </span>
  )
}
