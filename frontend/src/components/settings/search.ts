/**
 * Finding a setting by any word someone would use for it: its label, the question it answers, the
 * words people search with (aliases), the problems it answers (symptoms), its env var or key.
 *
 * Every word typed must appear (as part of a word: "stal" finds "staleness"). A setting is listed
 * once, under the best field it matched, best first; the field is returned so the result can say
 * why it is there ("matches: Canvases are slow while an import lands").
 */
import type { Setting } from './types'

export type MatchField = 'label' | 'question' | 'alias' | 'symptom' | 'env' | 'key' | 'summary'

export interface SearchHit {
    setting: Setting
    field: MatchField
    /** The text that matched, as written. */
    text: string
    score: number
}

const FIELD_SCORE: Record<MatchField, number> = {
    label: 100, env: 90, key: 85, alias: 80, question: 70, symptom: 65, summary: 40,
}

/** Lower case, accents and punctuation gone, so "Read-mode" finds "read mode". */
export function normalize(text: string): string {
    return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9_.%]+/g, ' ').trim()
}

function candidates(s: Setting): Array<[MatchField, string]> {
    return [
        ['label', s.label] as [MatchField, string],
        ...(s.default.env ? [['env', s.default.env] as [MatchField, string]] : []),
        ['key', s.key],
        ...s.guidance.aliases.map((a) => ['alias', a] as [MatchField, string]),
        ...(s.question ? [['question', s.question] as [MatchField, string]] : []),
        ...s.guidance.symptoms.map((x) => ['symptom', x] as [MatchField, string]),
        ['summary', s.guidance.summary],
    ]
}

export function searchSettings(settings: Setting[], query: string, limit = 12): SearchHit[] {
    const q = normalize(query)
    if (!q) return []
    const words = q.split(' ')
    const hits: SearchHit[] = []
    settings.forEach((s, order) => {
        let best: SearchHit | null = null
        for (const [field, text] of candidates(s)) {
            const t = normalize(text)
            if (!words.every((w) => t.includes(w))) continue
            // Exact and starts-with matches rank above a match inside the text.
            const bonus = t === q ? 30 : t.startsWith(q) ? 15 : t.split(' ').some((w) => w.startsWith(words[0])) ? 5 : 0
            const score = FIELD_SCORE[field] + bonus - order / 1000
            if (!best || score > best.score) best = { setting: s, field, text, score }
        }
        if (best) hits.push(best)
    })
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Every symptom the settings answer, once each, with the settings that answer it. */
export function symptomIndex(settings: Setting[]): Array<{ symptom: string; settings: Setting[] }> {
    const by = new Map<string, { symptom: string; settings: Setting[] }>()
    for (const s of settings) {
        for (const symptom of s.guidance.symptoms) {
            const k = normalize(symptom)
            const entry = by.get(k) ?? { symptom, settings: [] }
            entry.settings.push(s)
            by.set(k, entry)
        }
    }
    return [...by.values()].sort((a, b) => b.settings.length - a.settings.length || a.symptom.localeCompare(b.symptom))
}
