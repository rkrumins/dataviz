/**
 * askVocabulary — the words a view's data answers to, for reading a
 * question: its types (by name, plural and id), tags, property keys,
 * sampled values and layers. Each is filed under its phrase as people
 * type it — lowercase, plural or not, an identifier's words apart — so
 * "data platforms", "row count" and "rows" find `dataPlatform` and
 * `rowCount`.
 *
 * Pure: built from what discovery and the schema already hold.
 */


export type AskMeaning =
    | { kind: 'type'; type: string }
    | { kind: 'tag'; tag: string }
    | { kind: 'key'; key: string }
    | { kind: 'value'; key: string; value: string }
    | { kind: 'layer'; value: string; label: string }

export interface AskVocabulary {
    /** Phrase → what it can mean. */
    phrases: ReadonlyMap<string, readonly AskMeaning[]>
    /** The longest phrase, in words. */
    longest: number
    tags: readonly string[]
    keys: readonly string[]
}

export interface AskVocabularyInput {
    entityTypes: ReadonlyArray<{ id: string; name?: string | null; pluralName?: string | null }>
    tagValues: readonly string[]
    propertyKeys: readonly string[]
    valueSamples: ReadonlyArray<{ key: string; value: string }>
    layers: ReadonlyArray<{ value: string; label: string }>
}


/** One word as phrases are filed: lowercase, and one rather than several
 *  ("datasets" → "dataset", "entries" → "entry", "classes" → "class"). */
export function normalWord(word: string): string {
    const w = word.toLowerCase().replace(/['’]s$/, '')
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
    if (/(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2)
    if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1)
    return w
}

/** An identifier's words: "rowCount" → row, count; "updated_at" → updated, at. */
export function identifierWords(text: string): string[] {
    return text
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_\-.]+/)
        .filter(Boolean)
}

/** A phrase's key: its words, each normal, one space apart. */
export function phraseKey(words: readonly string[]): string {
    return words.map(normalWord).join(' ')
}

/** Suffixes a key's last word may carry that people leave off: "rows"
 *  for rowCount, "updated" for updatedAt. */
const KEY_SUFFIX = /^(?:count|num|number|total|at|on|date|time|ts|timestamp)$/i


export function buildAskVocabulary(input: AskVocabularyInput): AskVocabulary {
    const phrases = new Map<string, AskMeaning[]>()
    let longest = 1
    const file = (words: readonly string[], meaning: AskMeaning) => {
        if (!words.length) return
        const key = phraseKey(words)
        const list = phrases.get(key) ?? []
        if (!list.some((m) => JSON.stringify(m) === JSON.stringify(meaning))) list.push(meaning)
        phrases.set(key, list)
        longest = Math.max(longest, words.length)
    }
    const fileText = (text: string, meaning: AskMeaning) => {
        file(text.trim().split(/\s+/), meaning)
        const split = identifierWords(text)
        if (split.length > 1) file(split, meaning)
    }

    for (const t of input.entityTypes) {
        const meaning: AskMeaning = { kind: 'type', type: t.id }
        fileText(t.id, meaning)
        if (t.name) fileText(t.name, meaning)
        if (t.pluralName) fileText(t.pluralName, meaning)
    }
    for (const tag of input.tagValues) fileText(tag, { kind: 'tag', tag })
    for (const key of input.propertyKeys) {
        const meaning: AskMeaning = { kind: 'key', key }
        fileText(key, meaning)
        const words = identifierWords(key)
        if (words.length > 1 && KEY_SUFFIX.test(words[words.length - 1])) file(words.slice(0, -1), meaning)
    }
    for (const { key, value } of input.valueSamples) {
        if (value.trim()) file(value.trim().split(/\s+/), { kind: 'value', key, value })
    }
    for (const { value, label } of input.layers) {
        const meaning: AskMeaning = { kind: 'layer', value, label }
        fileText(label, meaning)
        file([...label.trim().split(/\s+/), 'layer'], meaning)
    }

    return { phrases, longest, tags: input.tagValues, keys: input.propertyKeys }
}
