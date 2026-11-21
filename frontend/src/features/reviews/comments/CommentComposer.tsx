/**
 * CommentComposer — where a comment is written: a textarea that grows with it, `@` to mention
 * someone (from the `mentionSource` it is given, asked as someone types), ⌘↵ to post.
 *
 * Posting is optimistic: the comment shows at once, sending; if it fails it stays, with Retry and
 * Edit, so nothing written is lost. Each comment carries a key of its own, and Retry sends the
 * same key again — a post that did arrive, though its answer did not, is not written twice.
 * Editing an existing comment keeps the text until it is saved.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, RotateCcw, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useAuthStore } from '@/store/auth'
import { matchMentionCandidates, mentionAt, mentionsIn, type MentionCandidate } from './mentions'

const MAX_BODY = 10_000
const MAX_SUGGESTIONS = 6

/** Where the people to mention come from: a review's people, those who can read a view… */
export interface MentionSource {
  /** Where the answers are kept; the query typed is added to it. */
  queryKey: readonly unknown[]
  /** The people matching what follows the `@` ('' right after it). */
  load: (q: string) => Promise<MentionCandidate[]>
}

/** A comment on its way: what it says, whom it mentions, and the key it is sent with. */
interface Payload { body: string; mentions: string[]; picked: Map<string, string>; clientKey: string }

/** A key for one comment, sent with it and again on Retry. */
function newClientKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `ck_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export interface CommentComposerProps {
  mentionSource: MentionSource
  placeholder?: string
  submitLabel?: string
  autoFocus?: boolean
  /** Editing: the comment as it reads now, and whom it mentions (id → name). */
  initial?: { body: string; mentions: Record<string, string> }
  /** Sends it; resolves once it is written (and the discussion read again). `clientKey` is the
   *  same on every Retry of one comment. */
  onSubmit: (body: string, mentions: string[], clientKey: string) => Promise<unknown>
  onCancel?: () => void
  className?: string
}

export function CommentComposer({
  mentionSource, placeholder = 'Leave a comment…', submitLabel = 'Comment', autoFocus, initial, onSubmit, onCancel, className,
}: CommentComposerProps) {
  const editing = !!initial
  const me = useAuthStore((s) => s.user)
  const [text, setText] = useState(initial?.body ?? '')
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map(Object.entries(initial?.mentions ?? {})))
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  /** A comment on its way (posting), or one that did not make it. */
  const [sending, setSending] = useState<Payload & { error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the text, up to a point.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  const at = mentionAt(text, caret)
  const mentioning = !!at && closedAt !== at.start
  // Asked as the name is typed, a pause at a time; the first answer right after the `@`.
  const typed = mentioning ? at!.query : null
  const settled = useDebouncedValue(typed, 150)
  const q = settled ?? typed ?? ''
  const peopleQ = useQuery({
    queryKey: [...mentionSource.queryKey, q],
    queryFn: () => mentionSource.load(q),
    enabled: mentioning,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  const fresh = !peopleQ.isPlaceholderData && q === typed
  const suggestions = useMemo(() => {
    if (!mentioning || !peopleQ.data) return []
    // An answer to an earlier query, while the next is on its way: narrowed to what is typed now.
    const people = fresh ? peopleQ.data : matchMentionCandidates(peopleQ.data, typed ?? '')
    return people.filter((p) => p.id !== me?.id).slice(0, MAX_SUGGESTIONS)
  }, [mentioning, peopleQ.data, fresh, typed, me?.id])
  const open = mentioning && (suggestions.length > 0 || peopleQ.isLoading)
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1))

  const pick = (p: MentionCandidate) => {
    if (!at) return
    const name = p.name
    const next = `${text.slice(0, at.start)}@${name} ${text.slice(caret)}`
    const pos = at.start + name.length + 2
    setText(next)
    setCaret(pos)
    setPicked((prev) => new Map(prev).set(p.id, name))
    setActive(0)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  const body = text.trim()
  const tooLong = body.length > MAX_BODY

  const send = async (payload: Payload) => {
    setSending(payload)
    try {
      await onSubmit(payload.body, payload.mentions, payload.clientKey)
      setSending(null)
    } catch (e) {
      setSending({ ...payload, error: (e as Error).message || 'Couldn’t post this comment.' })
    }
  }

  const submit = async () => {
    if (!body || tooLong || saving || (sending && !sending.error)) return
    const mentions = mentionsIn(body, picked)
    if (editing) {
      setSaving(true)
      setEditError(null)
      try {
        await onSubmit(body, mentions, newClientKey())
      } catch (e) {
        setEditError((e as Error).message || 'Couldn’t save this comment.')
      } finally {
        setSaving(false)
      }
      return
    }
    // Shown at once; the box is free for the next one.
    const payload = { body, mentions, picked, clientKey: newClientKey() }
    setText('')
    setPicked(new Map())
    void send(payload)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); return }
    if (open && suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIndex + 1) % suggestions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIndex - 1 + suggestions.length) % suggestions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[activeIndex]); return }
    }
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosedAt(at!.start); return }
    if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel() }
  }

  const listId = `mention-${useId().replace(/:/g, '')}`
  const myName = me?.displayName || [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.email || 'You'

  return (
    <div className={cn('space-y-2', className)}>
      {sending && (
        <div className={cn('flex items-start gap-2 rounded-xl px-2.5 py-2 border',
          sending.error ? 'border-rose-500/30 bg-rose-500/[0.05]' : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.03] opacity-75')}
          aria-live="polite">
          <UserAvatar userId={me?.id} name={myName} className="w-6 h-6 text-[10px] shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-ink whitespace-pre-wrap break-words">{sending.body}</p>
            {sending.error ? (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-rose-600 dark:text-rose-300">
                <AlertCircle className="w-3.5 h-3.5" aria-hidden />{sending.error}
                <button type="button" onClick={() => void send(sending)} className="inline-flex items-center gap-1 font-semibold hover:underline">
                  <RotateCcw className="w-3 h-3" aria-hidden />Retry
                </button>
                <button type="button" className="font-semibold hover:underline" onClick={() => {
                  setText(sending.body); setPicked(sending.picked); setSending(null); ref.current?.focus()
                }}>Edit</button>
              </p>
            ) : (
              <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-muted"><Loader2 className="w-3 h-3 animate-spin" aria-hidden />Sending…</p>
            )}
          </div>
        </div>
      )}
      <div className="relative">
        <div className="rounded-xl border border-glass-border bg-canvas focus-within:ring-2 focus-within:ring-accent-lineage/40 transition-shadow">
          <textarea
            ref={ref}
            value={text}
            rows={editing ? 2 : 1}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setClosedAt(null) }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={editing ? 'Edit comment' : placeholder}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && suggestions.length ? `${listId}-${activeIndex}` : undefined}
            className="block w-full resize-none bg-transparent px-3 pt-2 pb-1 text-[13px] leading-relaxed text-ink placeholder:text-ink-muted/60 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <span className={cn('text-[10.5px] tabular-nums', tooLong ? 'text-rose-600 dark:text-rose-300' : 'text-ink-muted/70')}>
              {tooLong ? `${(body.length - MAX_BODY).toLocaleString()} characters too long` : (body ? <><kbd className="font-sans">⌘↵</kbd> to {editing ? 'save' : 'post'} · @ to mention</> : '@ to mention someone')}
            </span>
            <span className="flex-1" />
            {onCancel && (
              <button type="button" onClick={onCancel}
                className="px-2 h-7 rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                Cancel
              </button>
            )}
            <button type="button" onClick={() => void submit()} disabled={!body || tooLong || saving || (!!sending && !sending.error)}
              className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-[12px] font-semibold text-white bg-accent-lineage hover:bg-accent-lineage/90 disabled:opacity-40 disabled:pointer-events-none">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Send className="w-3.5 h-3.5" aria-hidden />}
              {editing ? 'Save' : submitLabel}
            </button>
          </div>
        </div>
        {open && (
          <ul id={listId} role="listbox" aria-label="People to mention"
            className="absolute left-0 top-full mt-1 z-20 w-72 max-w-full rounded-xl border border-glass-border bg-canvas-elevated shadow-glass-lg py-1">
            {suggestions.length === 0 ? (
              <li className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-muted"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />Finding people…</li>
            ) : suggestions.map((p, i) => (
              <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === activeIndex}
                onMouseDown={(e) => { e.preventDefault(); pick(p) }}
                onMouseEnter={() => setActive(i)}
                className={cn('flex items-center gap-2 px-2.5 py-1.5 mx-1 rounded-lg cursor-pointer', i === activeIndex && 'bg-accent-lineage/10')}>
                <UserAvatar userId={p.id} name={p.name} avatarId={p.avatarId} hasImage={p.hasImage} className="w-6 h-6 text-[10px] shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-ink truncate">{p.name}</span>
                  {p.email && p.email !== p.name && <span className="block text-[10.5px] text-ink-muted truncate">{p.email}</span>}
                </span>
                {p.hint && (
                  <span className="shrink-0 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-1.5 py-px text-[9.5px] font-semibold text-ink-secondary">
                    {p.hint}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editError && <p className="text-[11px] text-rose-600 dark:text-rose-300">{editError}</p>}
    </div>
  )
}
