/**
 * Mentions in a comment, as written: `@Ana Silva` in the text, the person's id beside it. The text
 * stays plain (a notification quotes it as is); which ids it mentions is sent with it, and kept
 * only while their `@name` is still in the text. Links are found in it the same way: plain text,
 * drawn as a link only when it is an http(s) address.
 */

/** Someone who can be mentioned: who, and what the composer's list says about them. */
export interface MentionCandidate {
  id: string
  name: string
  email?: string | null
  avatarId?: string | null
  hasImage?: boolean
  /** Why they are worth mentioning here — "View owner", "Data steward". */
  hint?: string | null
}

/** The people a `@query` matches: a word of the name, or the email, starting with it. */
export function matchMentionCandidates<T extends MentionCandidate>(people: readonly T[], query: string): T[] {
  const q = query.toLowerCase()
  if (!q) return [...people]
  return people.filter((p) => {
    const name = p.name.toLowerCase()
    return name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q)) || (p.email ?? '').toLowerCase().startsWith(q)
  })
}

/** The `@query` being typed just before the caret, if any: where it starts and what it says so far. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null
}

/** The ids picked whose `@name` the text still holds, in the order picked. */
export function mentionsIn(text: string, picked: ReadonlyMap<string, string>): string[] {
  return [...picked].filter(([, name]) => text.includes(`@${name}`)).map(([id]) => id)
}

export type BodyPart = { text: string; mention?: string }

/** A body split at each `@name` of someone it mentions — what a comment draws highlighted. */
export function splitMentions(body: string, mentions: readonly string[], names: Readonly<Record<string, string>>): BodyPart[] {
  const tokens = mentions.map((id) => ({ id, token: `@${names[id] ?? id}` }))
    .sort((a, b) => b.token.length - a.token.length)
  if (tokens.length === 0) return [{ text: body }]
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(tokens.map((t) => escape(t.token)).join('|'), 'g')
  const out: BodyPart[] = []
  let at = 0
  for (const m of body.matchAll(re)) {
    if (m.index > at) out.push({ text: body.slice(at, m.index) })
    out.push({ text: m[0], mention: tokens.find((t) => t.token === m[0])!.id })
    at = m.index + m[0].length
  }
  if (at < body.length) out.push({ text: body.slice(at) })
  return out
}

export type LinkPart = { text: string; href?: string }

/** Characters that end a sentence rather than an address. */
const TRAILING = /[.,;:!?'"\]}>]+$/

/**
 * Text split at each http(s) address in it — what a message draws as links. Nothing else is ever
 * a link: no other scheme (`javascript:`, `data:`) and no bare domain. Punctuation that ends a
 * sentence stays text, as does a closing parenthesis the address did not open.
 */
export function splitLinks(text: string): LinkPart[] {
  const out: LinkPart[] = []
  let at = 0
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"]+/gi)) {
    let raw = m[0].replace(TRAILING, '')
    while (raw.endsWith(')') && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) {
      raw = raw.slice(0, -1).replace(TRAILING, '')
    }
    let href: string | null = null
    try {
      const url = new URL(raw)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) href = url.href
    } catch { /* not an address after all: it stays text */ }
    if (!href) continue
    if (m.index > at) out.push({ text: text.slice(at, m.index) })
    out.push({ text: raw, href })
    at = m.index + raw.length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out.length ? out : [{ text }]
}
