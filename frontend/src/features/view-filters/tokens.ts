/**
 * Smart search tokens — filters typed into the search box.
 *
 * `by:ada is:versioned updated:<30d tag:pii` reads the way a person thinks a
 * filter, and is quicker than four menus for someone who knows what they want. A
 * complete token becomes the same filter its menu would set (and the same chip),
 * so there is one filter state however it was chosen; whatever isn't a token stays
 * ordinary search text.
 *
 * Grammar: `key:value` or `key:"a quoted value"`, anywhere in the text.
 *   by:            created or edited it          created-by:  edited-by:  published-by:
 *   is:            versioned external private workspace enterprise mine fav shared
 *                  attention deleted recent
 *   type: tag: ws: source: vis:
 *   created: updated:   <7d (within the past 7 days), >30d (older than 30 days),
 *                       today, 2026-09, 2025, 2026-09-01..2026-09-15, this-month,
 *                       visit (since your last visit)…
 */
import { addDays, isValidRule } from './dateFilter'
import { ME, type ContributorRole, type ViewFilterState } from './model'

export type TokenKey =
  | 'by' | 'created-by' | 'edited-by' | 'published-by' | 'is'
  | 'type' | 'tag' | 'ws' | 'source' | 'vis' | 'created' | 'updated'

const KEYS: Record<string, TokenKey> = {
  by: 'by', 'created-by': 'created-by', 'edited-by': 'edited-by', 'updated-by': 'edited-by',
  'published-by': 'published-by', is: 'is', type: 'type', tag: 'tag', ws: 'ws',
  workspace: 'ws', source: 'source', src: 'source', vis: 'vis', visibility: 'vis',
  created: 'created', updated: 'updated',
}

export interface ParsedToken {
  key: TokenKey
  value: string
  /** The token as typed, e.g. `by:"Ada Lovelace"`. */
  raw: string
  start: number
  end: number
}

const TOKEN_RE = /(^|\s)([a-z][a-z-]*):(?:"([^"]*)"|(\S+))/gi

export function canonicalKey(key: string): TokenKey | null {
  return KEYS[key.toLowerCase()] ?? null
}

/** Every complete-looking token in the text, and the text with them taken out. */
export function parseTokens(input: string): { tokens: ParsedToken[]; text: string } {
  const tokens: ParsedToken[] = []
  let text = ''
  let last = 0
  for (const m of input.matchAll(TOKEN_RE)) {
    const key = canonicalKey(m[2])
    if (!key) continue
    const start = (m.index ?? 0) + m[1].length
    const end = (m.index ?? 0) + m[0].length
    tokens.push({ key, value: (m[3] ?? m[4] ?? '').trim(), raw: input.slice(start, end), start, end })
    text += input.slice(last, start)
    last = end
  }
  text += input.slice(last)
  return { tokens, text: text.replace(/\s+/g, ' ').trim() }
}

const BARE_KEY_RE = /(^|\s)([a-z][a-z-]*):("[^"]*)?(?=\s|$)/gi

/**
 * What the box searches for: its text without tokens, finished or still being
 * typed. Halfway through `by:al` the list must not go looking for the literal
 * text "by:al" — it would flash an empty result on every keystroke — and a token
 * that named nothing is a hint to fix, not words to search for.
 */
export function searchTextOf(input: string): string {
  return parseTokens(input).text
    .replace(BARE_KEY_RE, (m, lead: string, key: string) => (canonicalKey(key) ? lead : m))
    .replace(/\s+/g, ' ')
    .trim()
}

/** How token values become ids: names, emails and labels are matched against what
 *  the reader can see. Each returns `null` for no single match. */
export interface TokenResolver {
  person: (q: string) => string | null
  viewType: (q: string) => string | null
  tag: (q: string) => string | null
  workspace: (q: string) => string | null
  dataSource: (q: string) => string | null
}

const ROLE_OF: Partial<Record<TokenKey, ContributorRole | null>> = {
  by: null, 'created-by': 'created', 'edited-by': 'edited', 'published-by': 'published',
}

const IS_VALUES: Record<string, Partial<ViewFilterState>> = {
  versioned: { sourceKind: 'versioned' },
  external: { sourceKind: 'external' },
  private: { visibility: 'private' },
  workspace: { visibility: 'workspace' },
  enterprise: { visibility: 'enterprise' },
  mine: { category: 'my-views' },
  fav: { category: 'my-favourites' },
  favorite: { category: 'my-favourites' },
  favourite: { category: 'my-favourites' },
  shared: { category: 'shared-with-me' },
  attention: { category: 'needs-attention' },
  deleted: { category: 'deleted' },
  recent: { category: 'recently-added' },
}

export const IS_CHOICES = Object.keys(IS_VALUES)

/** `is:` values that pick a category (My views, Favorites…) rather than a filter —
 *  which a surface without the category pills has no way to show. */
export const IS_CATEGORY_VALUES: ReadonlySet<string> = new Set(
  Object.entries(IS_VALUES).filter(([, patch]) => 'category' in patch).map(([value]) => value),
)

/**
 * A date token's value as a date rule. `<7d` is "within the past 7 days" (the
 * rule `7d`); `>30d` is "older than 30 days", everything before the past 30 days.
 * Anything the date rules already understand passes through.
 */
export function dateTokenRule(value: string, today: string): string | null {
  const within = /^<(\d{1,4})d$/.exec(value)
  if (within) return isValidRule(`${within[1]}d`) ? `${within[1]}d` : null
  const older = /^>(\d{1,4})d$/.exec(value)
  if (older) return `..${addDays(today, -Number(older[1]))}`
  return isValidRule(value) ? value : null
}

function addUnique(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id]
}

/**
 * Apply tokens to a filter state. A token that names nothing the reader can see
 * comes back in `unresolved`, to stay in the box as text with a hint, rather than
 * becoming a filter that silently matches nothing. One role applies to everyone in
 * People, so a role token sets the role for all of them.
 */
export function applyTokens(
  state: ViewFilterState,
  tokens: readonly ParsedToken[],
  resolve: TokenResolver,
  today: string,
): { state: ViewFilterState; unresolved: ParsedToken[] } {
  let s = state
  const unresolved: ParsedToken[] = []
  for (const t of tokens) {
    const v = t.value
    let ok = true
    switch (t.key) {
      case 'by': case 'created-by': case 'edited-by': case 'published-by': {
        const id = v.toLowerCase() === 'me' ? ME : resolve.person(v)
        if (id) s = { ...s, contributorIds: addUnique(s.contributorIds, id), contributorRole: ROLE_OF[t.key] ?? null }
        else ok = false
        break
      }
      case 'is': {
        const patch = IS_VALUES[v.toLowerCase()]
        if (patch) s = { ...s, ...patch }
        else ok = false
        break
      }
      case 'type': {
        const id = resolve.viewType(v)
        if (id) s = { ...s, viewTypes: addUnique(s.viewTypes, id) }
        else ok = false
        break
      }
      case 'tag': {
        const id = resolve.tag(v)
        if (id) s = { ...s, tags: addUnique(s.tags, id) }
        else ok = false
        break
      }
      case 'ws': {
        const id = resolve.workspace(v)
        if (id) s = { ...s, workspaceIds: addUnique(s.workspaceIds, id) }
        else ok = false
        break
      }
      case 'source': {
        const id = resolve.dataSource(v)
        if (id) s = { ...s, dataSourceId: id }
        else ok = false
        break
      }
      case 'vis': {
        const vis = v.toLowerCase()
        if (vis === 'private' || vis === 'workspace' || vis === 'enterprise') s = { ...s, visibility: vis }
        else ok = false
        break
      }
      case 'created': case 'updated': {
        const rule = dateTokenRule(v, today)
        if (rule) s = { ...s, [t.key]: rule }
        else ok = false
        break
      }
    }
    if (!ok) unresolved.push(t)
  }
  return { state: s, unresolved }
}

/**
 * Match a typed value against named things: an exact (case-insensitive) name or
 * secondary key (an email) wins; otherwise a single name that starts with it, or
 * failing that a single name that contains it. Two candidates is ambiguous — no
 * match — rather than a guess.
 */
export function matchOne<T>(
  items: readonly T[],
  q: string,
  name: (t: T) => string,
  other?: (t: T) => string | null | undefined,
): T | null {
  const needle = q.trim().toLowerCase()
  if (!needle) return null
  const exact = items.filter(t => name(t).toLowerCase() === needle || other?.(t)?.toLowerCase() === needle)
  if (exact.length === 1) return exact[0]
  const prefix = items.filter(t => name(t).toLowerCase().startsWith(needle))
  if (prefix.length === 1) return prefix[0]
  const within = items.filter(t => name(t).toLowerCase().includes(needle))
  return within.length === 1 ? within[0] : null
}

// ── Completion: the token being typed, and finishing it ───────────────────

const PARTIAL_RE = /(^|\s)([a-z][a-z-]*):("?)([^"\s]*)$/i

/** The token being typed at the caret — `by:al|` — or null when the caret isn't
 *  in one. `start` is where the token begins, so a suggestion can replace it. */
export function tokenAtCaret(
  text: string, caret: number,
): { key: TokenKey; partial: string; start: number; end: number } | null {
  const before = text.slice(0, caret)
  const m = PARTIAL_RE.exec(before)
  if (!m) return null
  const key = canonicalKey(m[2])
  if (!key) return null
  return { key, partial: m[4], start: (m.index ?? 0) + m[1].length, end: caret }
}

/** Replace the token being typed with a finished one, quoted when it holds a
 *  space, and followed by a space — which is what turns it into a filter. */
export function insertToken(
  text: string, at: { start: number; end: number }, key: TokenKey, value: string,
): string {
  const v = /\s/.test(value) ? `"${value}"` : value
  const rest = text.slice(at.end).replace(/^\S*/, '').trimStart()
  return `${text.slice(0, at.start)}${key}:${v} ${rest}`
}

/** The date values offered after `created:` and `updated:`. */
export const DATE_TOKEN_CHOICES: readonly { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '<7d', label: 'Past 7 days' },
  { value: '<30d', label: 'Past 30 days' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-year', label: 'This year' },
  { value: '>90d', label: 'Older than 90 days' },
  { value: 'visit', label: 'Since your last visit' },
]

/** Examples shown in an empty search box — one of each kind worth knowing. */
export const TOKEN_EXAMPLES: readonly { token: string; hint: string }[] = [
  { token: 'by:me', hint: 'views you made or edited' },
  { token: 'is:versioned', hint: 'on a versioned graph' },
  { token: 'updated:<7d', hint: 'changed this week' },
  { token: 'tag:', hint: 'with a tag' },
]
