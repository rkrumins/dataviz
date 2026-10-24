/**
 * lineWords — the words a sentence line says, apart from how they are
 * shown: the Sentence builder makes them tokens to click, the Ask bar's
 * preview prints them as it reads a question back.
 */
import type { Predicate } from '@/types/search'

import { refName } from '../relations'
import { reachSegments, relationVerb, viaSegments, type Segment, type Slot } from '../vocabulary/sentenceGrammar'

import type { SentenceLine } from './clauseModel'


export interface Run {
    slot?: Slot
    text: string
    tone?: 'value' | 'phrase' | 'gap' | 'em' | 'note' | 'cond'
    predicate?: Predicate
}

/** Separators that keep a list one token: "#PII, #GDPR", "10 and 20". */
const SEPARATORS = new Set([', ', ' / ', ' and '])

/** A clause's segments as runs: each slot one run, its list kept whole. */
export function toRuns(segments: Segment[]): Run[] {
    const runs: Run[] = []
    let sep = ''
    let open: Run | null = null
    const flushSep = () => { if (sep) { runs.push({ text: sep }); sep = '' } }
    for (const seg of segments) {
        const slot = seg.t === 'text' || seg.t === 'value' || seg.t === 'gap' ? seg.slot : undefined
        if (slot) {
            const text = seg.t === 'gap' ? 'pick…' : seg.t === 'value' && seg.quoted ? `“${seg.text}”` : seg.t === 'text' || seg.t === 'value' ? seg.text : ''
            if (open && open.slot === slot && sep) {
                open.text += sep + text
                sep = ''
                continue
            }
            flushSep()
            open = { slot, text, tone: seg.t === 'gap' ? 'gap' : seg.t === 'value' ? 'value' : 'phrase' }
            runs.push(open)
            continue
        }
        if (seg.t === 'text' && open && SEPARATORS.has(seg.text)) { sep = seg.text; continue }
        flushSep()
        open = null
        if (seg.t === 'text') runs.push({ text: seg.text })
        else if (seg.t === 'em') runs.push({ text: seg.text, tone: 'em' })
        else if (seg.t === 'note') runs.push({ text: seg.text, tone: 'note' })
        else if (seg.t === 'cond') runs.push({ text: 'anything that…', tone: 'cond', predicate: seg.predicate })
    }
    flushSep()
    return runs
}


export interface RelationWords {
    /** "feed", "feed no", "only feed", "feed at least 2". */
    verb: string
    /** "a Chart", "Charts", "Finance", "something". */
    relative: string
    /** "within 1–3 hops" — nothing when it is one step and not lineage. */
    reach: string | null
    /** The edges walked: "mode is stream". */
    via: string
}

/** What a relationship line says, word by word. */
export function relationWords(line: Extract<SentenceLine, { kind: 'relation' }>,
    typeName: (type: string, plural?: boolean) => string): RelationWords {
    const p = line.predicate
    const relative = line.relative
    const several = p.count ? p.count.value !== 1 : p.quantifier === 'all'
    const bare = relative.kind === 'something' && !p.count
    // "feed something" / "feed nothing": an unnamed relative carries the
    // quantifier itself.
    const verb = bare
        ? relationVerb({ ...p, quantifier: undefined }, line.many)
        : `${relationVerb(p, line.many)}${p.count ? ` ${p.count.value}` : ''}`

    let label: string
    if (relative.kind === 'types') {
        const names = relative.types.map((t) => typeName(t, several))
        const list = names.join(' or ')
        label = several || p.quantifier === 'none' ? list : `${/^[aeiou]/i.test(names[0] ?? '') ? 'an' : 'a'} ${list}`
    } else if (relative.kind === 'names') {
        const names = relative.refs.map(refName).join(', ')
        label = relative.orInside ? `${names} or anything inside it` : names
    } else {
        label = p.count ? (p.count.value === 1 ? 'entity' : 'entities')
            : p.quantifier === 'none' ? 'nothing' : 'something'
    }

    const reach = reachSegments(p).find((s) => s.t === 'text' && s.slot === 'hops')
    const via = viaSegments(p)
    return {
        verb,
        relative: label,
        reach: reach && reach.t === 'text' ? reach.text : null,
        via: via.length
            ? via.map((s) => (s.t === 'text' || s.t === 'value' || s.t === 'em' ? s.text : '')).join('')
                .replace(/^,? through edges where /, '')
            : '',
    }
}
