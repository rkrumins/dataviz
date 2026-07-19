import { useState } from 'react'
import { Pencil, ThumbsUp, ThumbsDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GITHUB_REPO } from './docMeta.generated'
import { recordEvent } from '@/services/telemetryService'

type Vote = 'yes' | 'no'

/**
 * Emit a documentation-feedback event. Best-effort and side-effect-light: it
 * dispatches a window CustomEvent (`docs:feedback`) that an app-level listener
 * can forward to telemetry, and remembers the vote locally so the reader isn't
 * asked twice. Wire the CustomEvent to a real analytics/endpoint sink to close
 * the loop (which pages help, and what's missing).
 */
function recordFeedback(pageKey: string, vote: Vote, note?: string) {
  try {
    localStorage.setItem(`docs-helpful:${pageKey}`, vote)
  } catch {
    /* private mode — the vote just won't persist */
  }
  try {
    window.dispatchEvent(new CustomEvent('docs:feedback', { detail: { pageKey, vote, note } }))
  } catch {
    /* no-op */
  }
  recordEvent('docs.feedback', { pageKey, vote, note })
}

function priorVote(pageKey: string): Vote | null {
  try {
    const v = localStorage.getItem(`docs-helpful:${pageKey}`)
    return v === 'yes' || v === 'no' ? v : null
  } catch {
    return null
  }
}

/**
 * Foot-of-page block: "Edit on GitHub" + a "Was this helpful?" widget. `path`
 * is the repo-relative source file; `pageKey` scopes the remembered vote.
 */
export function PageFeedback({ path, pageKey }: { path?: string; pageKey: string }) {
  const [vote, setVote] = useState<Vote | null>(() => priorVote(pageKey))
  const [note, setNote] = useState('')
  const [sent, setSent] = useState(false)

  const cast = (v: Vote) => {
    setVote(v)
    if (v === 'yes') recordFeedback(pageKey, v)
    // for "no" we wait for the optional note before recording
  }

  const submitNote = () => {
    recordFeedback(pageKey, 'no', note.trim() || undefined)
    setSent(true)
  }

  return (
    <div className="mt-12 flex flex-col gap-4 border-t border-glass-border pt-6 sm:flex-row sm:items-start sm:justify-between">
      {/* Was this helpful? */}
      <div className="min-w-0">
        {vote === null ? (
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-ink-secondary">Was this helpful?</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => cast('yes')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink hover:border-accent-lineage/30 hover:bg-accent-lineage/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <ThumbsUp className="w-3.5 h-3.5" /> Yes
              </button>
              <button
                onClick={() => cast('no')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink hover:border-accent-lineage/30 hover:bg-accent-lineage/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
              >
                <ThumbsDown className="w-3.5 h-3.5" /> No
              </button>
            </div>
          </div>
        ) : vote === 'yes' || sent ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
            <Check className="w-4 h-4" /> Thanks for the feedback!
          </p>
        ) : (
          <div className="max-w-sm">
            <label className="text-sm font-medium text-ink-secondary">
              Sorry about that — what were you looking for?
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Optional — tell us what was missing or unclear"
              className="input mt-2 w-full resize-none text-sm"
            />
            <button
              onClick={submitNote}
              className="btn btn-secondary btn-sm mt-2"
            >
              Send feedback
            </button>
          </div>
        )}
      </div>

      {/* Edit on GitHub */}
      {path && (
        <a
          href={`https://github.com/${GITHUB_REPO}/edit/main/${path}`}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-muted',
            'hover:text-ink transition-colors',
          )}
        >
          <Pencil className="w-3.5 h-3.5" /> Edit this page on GitHub
        </a>
      )}
    </div>
  )
}
