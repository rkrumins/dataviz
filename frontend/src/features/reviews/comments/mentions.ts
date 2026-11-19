/**
 * Mentions in a comment, as written: `@Ana Silva` in the text, the person's id beside it. The text
 * stays plain (a notification quotes it as is); which ids it mentions is sent with it, and kept
 * only while their `@name` is still in the text.
 */

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
