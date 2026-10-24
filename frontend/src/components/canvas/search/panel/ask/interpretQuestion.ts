/**
 * interpretQuestion — a question in plain words, read into a query. No
 * model: rules over a small grammar and the view's own words.
 *
 *   "datasets that feed finance dashboards within 2 hops"
 *     → type:dataset AND downstream*..2(type:dashboard AND tag:Finance)
 *
 * It reads what it finds (types, merged when joined: "tables and views"),
 * tags, lineage shapes ("dead ends"), documentation, property comparisons
 * ("more than 1M rows", "owned by …", "updated in the last 7 days"),
 * relationships ("feed", "fed by", "linked to", "containing", "inside"),
 * their reach ("directly", "within 2 hops") and quantity ("no", "only",
 * "at least 2"), negation, and "and" / "or" — "and" binding tighter.
 * A relationship's relative is described by the words after its verb:
 * "that feed finance dashboards" is a dashboard tagged Finance.
 *
 * Words it can't place are read as a name to search for, and said so; a
 * word with several readings (a tag, a container's name, a name) is read
 * one way and offers the others. Pure and synchronous: the same question
 * with the same picks always reads the same.
 */
import type { NodeRef, Predicate, RelatedPredicate } from '@/types/search'

import { axisMeta, maxHopsFor, RELATION_DEPTH_MAX, RELATION_MAX_HOPS, type RelationAxis } from '../relations'
import { FILTER_CATEGORIES } from '../vocabulary/filterKinds'

import { phraseKey, type AskMeaning, type AskVocabulary } from './askVocabulary'


// ---------------------------------------------------------------------------
// What it returns
// ---------------------------------------------------------------------------

/** One way to read a word. */
export type AskReading = 'type' | 'tag' | 'value' | 'layer' | 'inside' | 'name'

export interface AskAmbiguity {
    /** Stable while the word stays where it is: its offset and text. */
    id: string
    /** The word(s) as typed. */
    text: string
    choices: Array<{ id: AskReading; label: string }>
    picked: AskReading
}

/** A name the question points at, to be looked up in the view. */
export interface AskName {
    text: string
    ref: NodeRef
}

export interface AskPicks {
    /** A reading picked for an ambiguity, by its id. */
    choices?: Readonly<Record<string, string>>
    /** The entity picked for a name, by the name as typed. */
    names?: Readonly<Record<string, NodeRef>>
}

export interface Interpretation {
    predicate: Predicate | null
    /** "and …" adds to the query; anything else replaces it. */
    mode: 'replace' | 'add'
    ambiguities: AskAmbiguity[]
    /** Words read as a name to search for — said back, as a guess. */
    unrecognized: string[]
    names: AskName[]
}


// ---------------------------------------------------------------------------
// The grammar's own words
// ---------------------------------------------------------------------------

type CmpOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith' | 'endsWith'

type Unit =
    | { u: 'filler' }
    | { u: 'and' } | { u: 'or' } | { u: 'also' }
    | { u: 'not' } | { u: 'no' } | { u: 'only' } | { u: 'has' }
    | { u: 'tagged' } | { u: 'named' } | { u: 'ownedBy' }
    | { u: 'rel'; axis: RelationAxis; cmp?: CmpOp }
    | { u: 'inside'; axis: 'ancestor'; cmp?: CmpOp }
    | { u: 'within' } | { u: 'topLevel' } | { u: 'directly' }
    | { u: 'cmp'; op: CmpOp } | { u: 'is' } | { u: 'isNot' } | { u: 'between' }
    | { u: 'last' } | { u: 'unit'; iso: (n: number) => string } | { u: 'hop' } | { u: 'layerWord' }
    | { u: 'doc'; predicate: Predicate }

const HAS_DESCRIPTION: Predicate = { kind: 'hasProperty', key: 'description', negate: false }
const NO_DESCRIPTION: Predicate = { kind: 'hasProperty', key: 'description', negate: true }
const NO_OWNER: Predicate = { kind: 'hasProperty', key: 'owner', negate: true }

const WORDS: Array<[Unit, string[]]> = [
    [{ u: 'filler' }, ['show me', 'show', 'find me', 'find', 'give me', 'list', 'get me', 'get', 'search for',
        'search', 'look for', 'i want', 'i need', 'what are', 'which are', 'which', 'what', 'where are',
        'are there any', 'are there', 'any', 'all', 'every', 'each', 'the', 'a', 'an', 'that', 'who', 'whose',
        'where', 'be', 'been', 'do', 'does', 'did', 'of', 'to', 'for', 'me', 'please', 'thing', 'entity',
        'node', 'item', 'one', 'something', 'anything', 'it', 'them', 'they', 'those', 'these', 'this',
        'there', 'either', 'everything']],
    [{ u: 'and' }, ['and', 'but', 'plus', 'as well as']],
    [{ u: 'or' }, ['or']],
    [{ u: 'also' }, ['also', 'and also', 'but also']],
    [{ u: 'not' }, ['not', "don't", "doesn't", 'do not', 'does not', "aren't", 'are not', "haven't", "hasn't",
        'never']],
    [{ u: 'isNot' }, ['is not', "isn't"]],
    [{ u: 'no' }, ['no', 'without', 'missing', 'lacking', 'none', 'not any', 'nothing']],
    [{ u: 'only' }, ['only', 'exclusively', 'solely']],
    [{ u: 'has' }, ['with', 'has', 'have', 'having', 'carrying']],
    [{ u: 'tagged' }, ['tagged', 'tagged with', 'tagged as', 'with tag', 'with the tag', 'having tag', 'labelled',
        'labeled', 'labelled as', 'labeled as', 'marked', 'marked as', 'flagged', 'flagged as']],
    [{ u: 'named' }, ['named', 'called', 'titled', 'whose name is', 'with name']],
    [{ u: 'ownedBy' }, ['owned by', 'owner is', 'whose owner is']],
    [{ u: 'rel', axis: 'downstream' }, ['feed', 'feeding', 'feed into', 'feeding into', 'flow into',
        'flowing into', 'flow to', 'write to', 'writing to', 'load into', 'loading into', 'populate',
        'populating', 'upstream of', 'source of', 'source for', 'downstream']],
    [{ u: 'rel', axis: 'upstream' }, ['fed by', 'fed from', 'read from', 'reading from', 'depend on',
        'depending on', 'downstream of', 'derived from', 'come from', 'coming from', 'built from', 'built on',
        'sourced from', 'consume', 'consuming', 'use', 'using', 'draw from', 'drawing from', 'upstream']],
    [{ u: 'rel', axis: 'neighbor' }, ['linked to', 'linked with', 'connected to', 'connected with',
        'related to', 'associated with', 'adjacent to']],
    [{ u: 'rel', axis: 'descendant', cmp: 'contains' }, ['contain', 'containing', 'hold', 'holding',
        'ancestor of']],
    [{ u: 'rel', axis: 'child' }, ['directly contain', 'directly containing', 'parent of']],
    [{ u: 'rel', axis: 'parent' }, ['whose parent is', 'with parent', 'child of', 'directly inside',
        'directly in', 'directly under', 'directly within']],
    [{ u: 'inside', axis: 'ancestor' }, ['inside', 'in', 'from', 'part of', 'belong to', 'belonging to',
        'inside of', 'located in', 'stored in']],
    [{ u: 'inside', axis: 'ancestor', cmp: 'lt' }, ['under', 'beneath']],
    [{ u: 'within' }, ['within', 'up to']],
    [{ u: 'topLevel' }, ['top-level', 'top level', 'at the top', 'root-level', 'root level', 'no parent',
        'without a parent', 'without parent', 'parentless']],
    [{ u: 'directly' }, ['directly', 'immediately', 'direct']],
    [{ u: 'cmp', op: 'gt' }, ['over', 'above', 'more than', 'greater than', 'bigger than', 'larger than',
        'higher than', 'exceeding', 'longer than']],
    [{ u: 'cmp', op: 'gte' }, ['at least', 'no less than', 'no fewer than', 'minimum of']],
    [{ u: 'cmp', op: 'lt' }, ['below', 'less than', 'fewer than', 'smaller than', 'lower than', 'shorter than']],
    [{ u: 'cmp', op: 'lte' }, ['at most', 'no more than', 'maximum of']],
    [{ u: 'cmp', op: 'eq' }, ['exactly', 'equal to', 'equals']],
    [{ u: 'cmp', op: 'contains' }, ['include', 'including', 'like']],
    [{ u: 'cmp', op: 'startsWith' }, ['start with', 'starting with', 'begin with', 'beginning with',
        'prefixed with']],
    [{ u: 'cmp', op: 'endsWith' }, ['end with', 'ending with', 'suffixed with']],
    [{ u: 'is' }, ['is', 'are', 'was', 'were']],
    [{ u: 'between' }, ['between']],
    [{ u: 'last' }, ['in the last', 'within the last', 'over the last', 'during the last', 'in the past',
        'within the past', 'over the past', 'in last', 'past', 'last']],
    [{ u: 'unit', iso: (n) => `P${n}D` }, ['day']],
    [{ u: 'unit', iso: (n) => `P${n * 7}D` }, ['week']],
    [{ u: 'unit', iso: (n) => `P${n}M` }, ['month']],
    [{ u: 'unit', iso: (n) => `P${n}Y` }, ['year']],
    [{ u: 'unit', iso: (n) => `PT${n}H` }, ['hour']],
    [{ u: 'hop' }, ['hop', 'hop away', 'step', 'step away']],
    [{ u: 'layerWord' }, ['layer']],
    [{ u: 'doc', predicate: HAS_DESCRIPTION }, ['documented', 'described', 'with a description',
        'with description', 'has a description']],
    [{ u: 'doc', predicate: NO_DESCRIPTION }, ['undocumented', 'undescribed', 'no description',
        'without description', 'without a description', 'missing description', 'missing a description',
        'lacking a description']],
    [{ u: 'doc', predicate: NO_OWNER }, ['unowned', 'ownerless', 'no owner', 'without owner',
        'without an owner', 'missing owner', 'missing an owner']],
]

const GRAMMAR = new Map<string, Unit>()
for (const [unit, phrases] of WORDS) for (const p of phrases) GRAMMAR.set(phraseKey(p.split(' ')), unit)

/** The lineage shapes, by the words people use for them (the catalog's own). */
const SHAPES = new Map<string, Predicate>()
for (const entry of FILTER_CATEGORIES.flatMap((c) => c.entries)) {
    if (!entry.build) continue
    for (const words of entry.examples ?? []) SHAPES.set(phraseKey(words.split(' ')), entry.build())
}

const LONGEST = Math.max(4, ...[...GRAMMAR.keys(), ...SHAPES.keys()].map((k) => k.split(' ').length))


// ---------------------------------------------------------------------------
// Words → tokens
// ---------------------------------------------------------------------------

interface Tok {
    kind: 'grammar' | 'vocab' | 'shape' | 'word' | 'quoted' | 'hashtag' | 'number' | 'cmpSign' | 'comma'
    text: string
    start: number
    unit?: Unit
    meanings?: readonly AskMeaning[]
    predicate?: Predicate
    value?: number
    op?: CmpOp
}

const LEX = new RegExp([
    /"([^"]*)"|“([^”]*)”|'([^']*)'(?=[\s,.!?]|$)/.source,
    /#([\p{L}\p{N}_\-./:]+)/u.source,
    /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|m|b|thousand|million|billion)\b)?/.source,
    /(>=|<=|!=|=|>|<)/.source,
    /(,)/.source,
    /([\p{L}\p{N}](?:[\p{L}\p{N}_\-.@/:'’]*[\p{L}\p{N}])?)/u.source,
].join('|'), 'giu')

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }
const SIGN: Record<string, CmpOp> = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '=': 'eq', '!=': 'neq' }

function lex(text: string): Tok[] {
    const out: Tok[] = []
    for (const m of text.matchAll(LEX)) {
        const start = m.index ?? 0
        const quoted = m[1] ?? m[2] ?? m[3]
        if (quoted !== undefined) {
            if (quoted.trim()) out.push({ kind: 'quoted', text: quoted.trim(), start })
        } else if (m[4]) out.push({ kind: 'hashtag', text: m[4], start })
        else if (m[5]) {
            const value = Number(m[5].replace(/,/g, '')) * (m[6] ? SCALE[m[6].toLowerCase()] : 1)
            out.push({ kind: 'number', text: m[0], start, value })
        } else if (m[7]) out.push({ kind: 'cmpSign', text: m[7], start, op: SIGN[m[7]] })
        else if (m[8]) out.push({ kind: 'comma', text: ',', start })
        else if (m[9]) out.push({ kind: 'word', text: m[9], start })
    }
    return out
}

/** Each run of words read as the longest phrase it holds: the grammar's
 *  own words first (but never over the view's words with mere filler),
 *  then the view's, then the lineage shapes. */
function classify(raw: Tok[], vocab: AskVocabulary): Tok[] {
    const out: Tok[] = []
    const longest = Math.max(LONGEST, vocab.longest)
    for (let i = 0; i < raw.length;) {
        const t = raw[i]
        if (t.kind !== 'word') { out.push(t); i += 1; continue }
        let found: Tok | null = null
        let run = 0
        while (i + run < raw.length && raw[i + run].kind === 'word') run += 1
        for (let len = Math.min(longest, run); len >= 1 && !found; len -= 1) {
            const words = raw.slice(i, i + len)
            const key = phraseKey(words.map((w) => w.text))
            const text = words.map((w) => w.text).join(' ')
            const g = GRAMMAR.get(key)
            const v = vocab.phrases.get(key)
            const s = SHAPES.get(key)
            if (g && g.u !== 'filler') found = { kind: 'grammar', text, start: t.start, unit: g }
            else if (v) found = { kind: 'vocab', text, start: t.start, meanings: v }
            else if (s) found = { kind: 'shape', text, start: t.start, predicate: s }
            else if (g) found = { kind: 'grammar', text, start: t.start, unit: g }
            if (found) { out.push(found); i += len }
        }
        if (!found) { out.push(t); i += 1 }
    }
    return out
}


// ---------------------------------------------------------------------------
// Tokens → a query
// ---------------------------------------------------------------------------

/** What a relationship's relative is — or, at the top, what the query
 *  finds: its types, and its conditions as "or" of "and"s. */
interface Frame {
    parent: Frame | null
    rel: RelatedPredicate | null
    depth: number
    types: string[]
    groups: Predicate[][]
    /** The last relationship this frame closed — trailing "within 2 hops"
     *  reaches back to it. */
    lastRel: RelatedPredicate | null
}

const MAX_CONDITIONS = 64

/** The key "in the last 7 days" means when no key is named: when things
 *  were last changed, else made, else any time the view records. */
function timeKey(keys: readonly string[]): string | null {
    return keys.find((k) => /updat|modif|chang/i.test(k))
        ?? keys.find((k) => /creat/i.test(k))
        ?? keys.find((k) => /(?:At|Date|Time|_at|_date|_time)$/.test(k))
        ?? null
}

const and = (ps: Predicate[]): Predicate | null =>
    ps.length === 0 ? null : ps.length === 1 ? ps[0] : { kind: 'group', op: 'and', children: ps }

function negated(p: Predicate): Predicate {
    if (p.kind === 'related' && !p.count) return { ...p, quantifier: p.quantifier === 'none' ? undefined : 'none' }
    if (p.kind === 'hasProperty') return { ...p, negate: !p.negate }
    return { kind: 'group', op: 'not', children: [p] }
}

const nameText = (value: string): Predicate =>
    ({ kind: 'text', value, target: 'name', match: 'substring', caseSensitive: false, boost: 1 } as Predicate)

/** The meaning a word reads as with no other cue, in that order. */
const READING_OF: Record<AskMeaning['kind'], AskReading | null> = {
    type: 'type', layer: 'layer', tag: 'tag', value: 'value', key: null,
}

const READING_LABEL: Record<AskReading, string> = {
    type: 'a type', tag: 'a tag', value: 'a value', layer: 'a layer',
    inside: 'inside a container', name: 'a name',
}


export function interpretQuestion(text: string, vocab: AskVocabulary, picks: AskPicks = {}): Interpretation {
    const toks = classify(lex(text), vocab)
    const ambiguities: AskAmbiguity[] = []
    const unrecognized: string[] = []
    const names: AskName[] = []
    const wantHops = new Map<RelatedPredicate, number>()
    let conditions = 0

    let i = 0
    let mode: Interpretation['mode'] = 'replace'
    const isAddLead = (t: Tok | undefined) => t?.kind === 'grammar' && (t.unit?.u === 'and' || t.unit?.u === 'also')
    while (isAddLead(toks[i])) { mode = 'add'; i += 1 }

    const root: Frame = { parent: null, rel: null, depth: 0, types: [], groups: [[]], lastRel: null }
    let frame = root
    let lastAdded: 'type' | 'tag' | 'cond' | null = null
    let join: 'and' | 'or' | 'comma' | null = null
    const pend = {
        not: false, no: false, only: false, direct: false, tagged: false, named: false,
        cmp: null as CmpOp | null, number: null as number | null, key: null as string | null,
    }

    const unitOf = (t: Tok | undefined) => (t?.kind === 'grammar' ? t.unit : undefined)
    const isFiller = (t: Tok | undefined) => {
        const u = unitOf(t)?.u
        return u === 'filler' || u === 'is' || u === 'has'
    }
    /** The next token that says something, skipping filler. */
    const peek = (from = i): Tok | undefined => {
        let k = from
        while (k < toks.length && isFiller(toks[k])) k += 1
        return toks[k]
    }
    const typeOf = (t: Tok | undefined) => t?.meanings?.find((m) => m.kind === 'type')
    const tagOf = (t: Tok | undefined) => t?.kind === 'hashtag' || !!t?.meanings?.some((m) => m.kind === 'tag')
    const emptyTarget = (f: Frame) => !!f.rel && !f.types.length && f.groups.every((g) => !g.length) && !f.rel.where

    const ambiguity = (t: { text: string; start: number }, choices: AskReading[], fallback: AskReading) => {
        const id = `${t.start}:${t.text}`
        const want = picks.choices?.[id]
        const picked = choices.includes(want as AskReading) ? want as AskReading : fallback
        ambiguities.push({ id, text: t.text, choices: choices.map((c) => ({ id: c, label: READING_LABEL[c] })), picked })
        return picked
    }
    const nameRef = (text: string): NodeRef => {
        const ref = picks.names?.[text] ?? { path: ['**', text] }
        if (!names.some((n) => n.text === text)) names.push({ text, ref })
        return ref
    }
    const clearPending = () => {
        pend.not = false; pend.no = false; pend.only = false; pend.direct = false
        pend.named = false; pend.cmp = null; pend.number = null; pend.key = null
    }

    const add = (p: Predicate, as: 'tag' | 'cond' = 'cond') => {
        if (conditions >= MAX_CONDITIONS) return
        conditions += 1
        const group = frame.groups[frame.groups.length - 1]
        group.push(pend.not || pend.no ? negated(p) : p)
        lastAdded = as
        join = null
        clearPending()
    }
    const addTag = (tag: string) => {
        const group = frame.groups[frame.groups.length - 1]
        const last = group[group.length - 1]
        if (lastAdded === 'tag' && (join === 'or' || join === 'comma') && last?.kind === 'tag' && !pend.not) {
            group[group.length - 1] = { ...last, values: [...last.values, tag] }
            join = null
            return
        }
        add({ kind: 'tag', op: 'hasAny', values: [tag] }, 'tag')
    }
    const addType = (type: string) => {
        if (!frame.types.includes(type)) frame.types.push(type)
        lastAdded = 'type'
        join = null
        pend.no = false
    }
    const closeFrame = () => {
        const f = frame
        if (!f.parent || !f.rel) return
        const where = build(f)
        if (where && !f.rel.where) f.rel.where = where
        if (f.rel.quantifier === 'all' && !f.rel.where) delete f.rel.quantifier
        frame = f.parent
        frame.lastRel = f.rel
        lastAdded = 'cond'
    }
    const openRelation = (axis: RelationAxis) => {
        if (frame.depth + 1 > RELATION_DEPTH_MAX) return
        const rel: RelatedPredicate = { kind: 'related', axis }
        if (pend.not || pend.no) rel.quantifier = 'none'
        else if (pend.only) rel.quantifier = 'all'
        if (axisMeta(axis).lineage) {
            if (pend.direct) wantHops.set(rel, 1)
            else rel.maxHops = RELATION_MAX_HOPS
        }
        clearPending()
        add(rel)
        frame = { parent: frame, rel, depth: frame.depth + 1, types: [], groups: [[]], lastRel: null }
        lastAdded = null
    }
    /** "feeds CFO Revenue": the relative is named, and that's all it is. */
    const nameTarget = (text: string) => {
        if (frame.rel) frame.rel.where = { kind: 'is', refs: [nameRef(text)] }
        closeFrame()
    }
    const inside = (text: string, axis: 'ancestor' = 'ancestor') => {
        const negate = pend.not || pend.no
        clearPending()
        if (frame.depth + 1 > RELATION_DEPTH_MAX) return
        const rel: RelatedPredicate = { kind: 'related', axis, where: { kind: 'is', refs: [nameRef(text)] } }
        if (negate) rel.quantifier = 'none'
        add(rel)
        frame.lastRel = rel
    }
    /** A key named and nothing compared: it has the property (or not). */
    const flushKey = () => {
        if (!pend.key) return
        const key = pend.key
        pend.key = null
        add({ kind: 'hasProperty', key, negate: false })
    }
    const property = (op: CmpOp | 'between' | 'withinLast', value: unknown) => {
        const key = pend.key!
        pend.key = null
        add({ kind: 'property', key, op, value } as Predicate)
    }
    /** Consecutive words (and plain numbers) as one name. */
    const readPhrase = (): { text: string; start: number } => {
        const first = toks[i]
        const parts = [first.text]
        i += 1
        while (i < toks.length && (toks[i].kind === 'word'
            || (toks[i].kind === 'number' && unitOf(toks[i + 1])?.u !== 'hop'))) {
            parts.push(toks[i].text)
            i += 1
        }
        return { text: parts.join(' '), start: first.start }
    }
    /** A value compared with a key: a word, a quoted phrase, a number. */
    const valueText = (t: Tok): string => {
        const sample = t.meanings?.find((m) => m.kind === 'value' && m.key === pend.key)
        return sample?.kind === 'value' ? sample.value : t.text
    }

    while (i < toks.length) {
        const t = toks[i]
        const u = unitOf(t)

        // A property's comparison takes what follows it as its value.
        if (pend.key && pend.cmp && pend.cmp !== 'eq' && t.kind === 'number') {
            property(pend.cmp, t.value)
            i += 1
            continue
        }
        if (pend.key && pend.cmp && (t.kind === 'word' || t.kind === 'quoted' || t.kind === 'vocab'
            || t.kind === 'number' || t.kind === 'hashtag')) {
            property(pend.cmp, t.kind === 'number' ? t.value : valueText(t))
            i += 1
            continue
        }
        if (pend.key && !pend.cmp && (t.kind === 'quoted' || (t.kind === 'vocab'
            && t.meanings!.some((m) => m.kind === 'value' && m.key === pend.key)))) {
            property('eq', valueText(t))
            i += 1
            continue
        }
        if (pend.key && !(u?.u === 'is' || u?.u === 'isNot' || u?.u === 'cmp' || u?.u === 'between'
            || u?.u === 'last' || (u?.u === 'rel' && u.cmp) || t.kind === 'cmpSign')) flushKey()

        if (t.kind === 'comma') { onJoin('comma'); i += 1; continue }
        if (t.kind === 'cmpSign') { pend.cmp = t.op!; i += 1; continue }

        if (t.kind === 'number') {
            if (unitOf(peek(i + 1))?.u === 'hop') {
                const rel = frame.rel ?? frame.lastRel
                if (rel && axisMeta(rel.axis).lineage) wantHops.set(rel, t.value!)
                i = toks.indexOf(peek(i + 1)!) + 1
                pend.cmp = null
                continue
            }
            if (pend.cmp) { pend.number = t.value!; i += 1; continue }
            const phrase = readPhrase()
            onName(phrase)
            continue
        }

        if (t.kind === 'quoted') {
            i += 1
            if (pend.tagged) { addTag(t.text); continue }
            if (pend.named) { add(nameText(t.text)); continue }
            if (emptyTarget(frame)) { nameTarget(t.text); continue }
            add(nameText(t.text))
            continue
        }

        if (t.kind === 'hashtag') {
            i += 1
            const canon = vocab.tags.find((x) => x.toLowerCase() === t.text.toLowerCase())
            addTag(canon ?? t.text)
            continue
        }

        if (t.kind === 'shape') {
            i += 1
            // "with downstream dashboards": a relationship, its relative named next.
            const flow = t.predicate!.kind === 'hasOutgoing' ? 'downstream'
                : t.predicate!.kind === 'hasIncoming' ? 'upstream' : null
            if (flow && typeOf(peek())) { openRelation(flow); continue }
            add(t.predicate!)
            continue
        }

        if (t.kind === 'word') {
            onName(readPhrase())
            continue
        }

        if (t.kind === 'vocab') {
            i += 1
            const meanings = t.meanings!
            const key = meanings.find((m) => m.kind === 'key')
            const type = typeOf(t)
            if (pend.tagged) { addTag(meanings.find((m) => m.kind === 'tag')?.kind === 'tag'
                ? (meanings.find((m) => m.kind === 'tag') as { tag: string }).tag : t.text); continue }
            if (pend.named) { add(nameText(t.text)); continue }
            if (key?.kind === 'key' && !type) {
                // "more than 1M rows": the comparison came first.
                if (pend.cmp && pend.number !== null) {
                    pend.key = key.key
                    property(pend.cmp, pend.number)
                } else {
                    const no = pend.no
                    pend.key = key.key
                    pend.no = no
                    pend.cmp = null
                }
                continue
            }
            if (type?.kind === 'type') {
                // "more than 2 dashboards downstream": the relationship comes after.
                const after = unitOf(peek())
                if (!emptyTarget(frame) && pend.cmp && pend.number !== null && after?.u === 'rel') {
                    const { cmp, number } = pend
                    i = toks.indexOf(peek()!) + 1
                    pend.cmp = null
                    pend.number = null
                    openRelation(after.axis)
                    pend.cmp = cmp
                    pend.number = number
                }
                // "at least 2 dashboards": how many relatives.
                if (emptyTarget(frame) && pend.cmp && pend.number !== null && frame.rel) {
                    frame.rel.count = { op: pend.cmp === 'contains' ? 'gte' : pend.cmp, value: pend.number } as never
                    delete frame.rel.quantifier
                    pend.cmp = null
                    pend.number = null
                }
                if (emptyTarget(frame) && frame.rel) {
                    if (pend.no) frame.rel.quantifier = 'none'
                    else if (pend.only) frame.rel.quantifier = 'all'
                }
                pend.only = false
                addType(type.type)
                continue
            }
            const readings = meanings.map((m) => READING_OF[m.kind]).filter((r): r is AskReading => !!r)
            const fallback = readings[0] ?? 'name'
            if (emptyTarget(frame) && frame.rel && readings[0] !== 'tag' && !typeOf(peek())) {
                nameTarget(t.text)
                continue
            }
            // Every reading it has, a container's name for a tag or a layer, and a name.
            const container: AskReading[] = readings.some((r) => r === 'tag' || r === 'layer') ? ['inside'] : []
            const choices = [...new Set<AskReading>([...readings, ...container, 'name'])]
            const picked = ambiguity(t, choices, fallback)
            readAs(picked, t, meanings)
            continue
        }

        // The grammar's own words.
        i += 1
        switch (u?.u) {
            case 'filler': case 'has': case 'layerWord': case 'hop': case 'unit':
                break
            case 'is':
                if (pend.key && !pend.cmp) pend.cmp = 'eq'
                break
            case 'isNot':
                if (pend.key && !pend.cmp) pend.cmp = 'neq'
                else pend.not = true
                break
            case 'and': case 'also':
                onJoin('and')
                break
            case 'or':
                onJoin('or')
                break
            case 'not':
                pend.not = true
                break
            case 'no':
                if (emptyTarget(frame) && frame.rel) frame.rel.quantifier = 'none'
                else pend.no = true
                break
            case 'only':
                if (emptyTarget(frame) && frame.rel && !frame.rel.count) frame.rel.quantifier = 'all'
                else pend.only = true
                break
            case 'directly': {
                const rel = frame.rel ?? frame.lastRel
                if (rel && !emptyTarget(frame) && axisMeta(rel.axis).lineage) wantHops.set(rel, 1)
                else pend.direct = true
                break
            }
            case 'tagged':
                pend.tagged = true
                break
            case 'named':
                pend.named = true
                break
            case 'ownedBy':
                pend.key = 'owner'
                pend.cmp = 'eq'
                break
            case 'cmp':
                pend.cmp = u.op
                break
            case 'between': {
                const lo = toks[i]
                const mid = unitOf(toks[i + 1])?.u
                const hi = toks[i + 2]
                if (pend.key && lo?.kind === 'number' && mid === 'and' && hi?.kind === 'number') {
                    property('between', [lo.value, hi.value])
                    i += 3
                }
                break
            }
            case 'last': {
                const n = toks[i]
                const unit = unitOf(toks[i + 1])
                if (n?.kind === 'number' && unit?.u === 'unit') {
                    pend.key ??= timeKey(vocab.keys)
                    if (pend.key) property('withinLast', unit.iso(n.value!))
                    i += 2
                }
                break
            }
            case 'rel':
                if (pend.key && u.cmp) { pend.cmp = u.cmp; break }
                openRelation(u.axis)
                break
            case 'inside': {
                const next = toks[i]
                if (u.cmp && next?.kind === 'number') { pend.cmp = u.cmp; break }
                onInside()
                break
            }
            case 'within':
                if (toks[i]?.kind !== 'number') onInside()
                break
            case 'topLevel':
                add({ kind: 'related', axis: 'parent', quantifier: 'none' })
                break
            case 'doc':
                add(u.predicate)
                break
        }
        pend.tagged = pend.tagged && (u?.u === 'tagged' || u?.u === 'and' || u?.u === 'or')
    }
    flushKey()
    while (frame.parent) closeFrame()

    const predicate = build(root)
    if (predicate) clampHops(predicate)
    return { predicate, mode, ambiguities, unrecognized, names }


    // -- the readers the loop hands off to --------------------------------

    function onJoin(kind: 'and' | 'or' | 'comma') {
        const next = peek()
        // A list goes on in the same place: "dashboards or charts", "PII or GDPR".
        const list = (lastAdded === 'type' && !!typeOf(next)) || (lastAdded === 'tag' && tagOf(next))
            || (pend.tagged && next?.kind === 'word')
        if (!list && frame.rel) closeFrame()
        join = kind
        if (kind === 'or' && !list) frame.groups.push([])
    }

    /** What follows "inside": a layer, a type, or a container's name. */
    function onInside() {
        while (isFiller(toks[i])) i += 1
        const next = toks[i]
        if (!next) return
        const layer = next.meanings?.find((m) => m.kind === 'layer')
        if (layer?.kind === 'layer') {
            i += 1
            const picked = ambiguity(next, ['layer', 'inside'], 'layer')
            if (picked === 'inside') inside(next.text)
            else add({ kind: 'layer', layerAssignment: layer.value } as Predicate)
            return
        }
        if (typeOf(next)) { openRelation('ancestor'); return }
        if (next.kind === 'quoted' || next.kind === 'vocab' || next.kind === 'hashtag') {
            i += 1
            inside(next.text)
            return
        }
        if (next.kind === 'word') inside(readPhrase().text)
    }

    /** Words read as a name: a relative named, or a name to search for. */
    function onName(phrase: { text: string; start: number }) {
        if (pend.tagged) { addTag(phrase.text); return }
        if (pend.named) { add(nameText(phrase.text)); return }
        // "feeds the CFO dashboard": a dashboard by that name, not one named so.
        if (emptyTarget(frame) && !typeOf(peek())) { nameTarget(phrase.text); return }
        const picked = ambiguity(phrase, ['name', 'inside'], 'name')
        if (picked === 'inside') { inside(phrase.text); return }
        unrecognized.push(phrase.text)
        add(nameText(phrase.text))
    }

    /** A word of the view's read the way picked. */
    function readAs(reading: AskReading, t: Tok, meanings: readonly AskMeaning[]) {
        const m = meanings.find((x) => READING_OF[x.kind] === reading)
        if (reading === 'inside') inside(t.text)
        else if (reading === 'name') add(nameText(t.text))
        else if (m?.kind === 'tag') addTag(m.tag)
        else if (m?.kind === 'layer') add({ kind: 'layer', layerAssignment: m.value } as Predicate)
        else if (m?.kind === 'value') add({ kind: 'property', key: m.key, op: 'eq', value: m.value } as Predicate)
    }

    function build(f: Frame): Predicate | null {
        const groups = f.groups.filter((g) => g.length)
        const type: Predicate[] = f.types.length ? [{ kind: 'entityType', op: 'in', values: f.types }] : []
        if (groups.length <= 1) return and([...type, ...(groups[0] ?? [])])
        return and([...type, { kind: 'group', op: 'or', children: groups.map((g) => and(g)!) }])
    }

    /** Hops asked for, within what a search tests: further when the far
     *  end is named, at the top of the query. */
    function clampHops(p: Predicate) {
        const top = new Set(p.kind === 'group' && p.op === 'and' ? p.children : [p])
        const visit = (q: Predicate) => {
            if (q.kind === 'group') q.children.forEach(visit)
            if (q.kind !== 'related') return
            const want = wantHops.get(q)
            if (want !== undefined) {
                const most = maxHopsFor(q, { topLevel: top.has(q), rule: false })
                const hops = Math.max(1, Math.min(most, Math.round(want)))
                if (hops > 1) q.maxHops = hops
                else delete q.maxHops
            }
            if (q.where) visit(q.where)
        }
        visit(p)
    }
}
