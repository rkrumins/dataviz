/**
 * cypherLanguage — enough of Cypher to colour it: keywords, functions,
 * labels and relationship types, properties, strings, numbers, parameters,
 * comments. A small tokenizer of our own (no grammar package), feeding the
 * same role highlighting the query language uses (``roleHighlighting``).
 *
 * It only colours: whether a query is valid Cypher, and safe to run, is the
 * server's to say.
 */
import type { RoleRange } from './codeMirrorBase'


const KEYWORDS = new Set([
    'MATCH', 'OPTIONAL', 'WHERE', 'WITH', 'RETURN', 'ORDER', 'BY', 'SKIP', 'LIMIT', 'UNWIND',
    'AS', 'AND', 'OR', 'XOR', 'NOT', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE', 'DISTINCT', 'CASE',
    'WHEN', 'THEN', 'ELSE', 'END', 'CALL', 'YIELD', 'UNION', 'ALL', 'EXISTS', 'STARTS', 'ENDS',
    'CONTAINS', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING', 'CREATE', 'MERGE', 'SET', 'DELETE',
    'DETACH', 'REMOVE', 'FOREACH', 'LOAD', 'CSV', 'FROM', 'USE', 'ON', 'COUNT', 'ANY', 'NONE',
    'SINGLE', 'REDUCE', 'SHORTESTPATH', 'ALLSHORTESTPATHS',
])
/** Keywords that are called like functions: ``count(n)``, ``all(x IN …)``. */
const CALLABLE = new Set([
    'COUNT', 'EXISTS', 'ANY', 'NONE', 'SINGLE', 'ALL', 'REDUCE', 'SHORTESTPATH', 'ALLSHORTESTPATHS',
])

const WORD = /[A-Za-z_][A-Za-z0-9_]*/y
const NUMBER = /(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/y


/** The ranges to colour in ``text``. */
export function cypherRanges(text: string): RoleRange[] {
    const out: RoleRange[] = []
    let i = 0
    let previous = ''          // the last character that isn't a space
    while (i < text.length) {
        const c = text[i]
        const start = i
        if (/\s/.test(c)) { i += 1; continue }
        if (text.startsWith('//', i)) {
            const end = text.indexOf('\n', i)
            i = end === -1 ? text.length : end
            out.push({ from: start, to: i, role: 'comment' })
            continue
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2)
            i = end === -1 ? text.length : end + 2
            out.push({ from: start, to: i, role: 'comment' })
            continue
        }
        if (c === '"' || c === "'") {
            i += 1
            while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
            i = Math.min(i + 1, text.length)
            out.push({ from: start, to: i, role: 'value' })
            previous = c
            continue
        }
        if (c === '`') {
            const end = text.indexOf('`', i + 1)
            i = end === -1 ? text.length : end + 1
            out.push({ from: start, to: i, role: previous === ':' ? 'label' : 'text' })
            previous = '`'
            continue
        }
        if (c === '$') {
            WORD.lastIndex = i + 1
            const m = WORD.exec(text) ?? /\d+/y.exec(text.slice(i + 1))
            i += 1 + (m ? m[0].length : 0)
            out.push({ from: start, to: i, role: 'param' })
            previous = 'p'
            continue
        }
        NUMBER.lastIndex = i
        const number = /[\d]/.test(c) ? NUMBER.exec(text) : null
        if (number) {
            i += number[0].length
            out.push({ from: start, to: i, role: 'number' })
            previous = '0'
            continue
        }
        WORD.lastIndex = i
        const word = /[A-Za-z_]/.test(c) ? WORD.exec(text) : null
        if (word) {
            i += word[0].length
            const after = text.slice(i).match(/^\s*(\(|\.)/)?.[1]
            const upper = word[0].toUpperCase()
            const role = previous === ':' ? 'label'
                : previous === '.' ? (after === '(' ? 'function' : 'field')
                    : KEYWORDS.has(upper) && !(after === '(' && CALLABLE.has(upper)) ? 'keyword'
                        : after === '(' ? 'function'
                            : after === '.' && /^[a-z]/.test(word[0]) && /^\s*\.\s*[a-zA-Z]+\s*\(/.test(text.slice(i))
                                ? 'function'
                                : 'text'
            out.push({ from: start, to: i, role })
            previous = 'a'
            continue
        }
        out.push({ from: start, to: start + 1, role: /[()[\]{},;]/.test(c) ? 'punct' : 'operator' })
        previous = c
        i += 1
    }
    return out
}


/** Where an engine's error message says it is, as a character offset in
 *  ``text`` — "(line 1, column 5 (offset: 4))" or "line: 1, column: 5,
 *  offset: 4" — or null when it says nothing. */
export function errorOffset(message: string, text: string): number | null {
    const offset = /offset:\s*(\d+)/i.exec(message)
    if (offset) return Math.min(Number(offset[1]), text.length)
    const lineCol = /line:?\s*(\d+),\s*column:?\s*(\d+)/i.exec(message)
    if (!lineCol) return null
    const lines = text.split('\n')
    const line = Math.max(1, Number(lineCol[1]))
    const before = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    return Math.min(before + Math.max(0, Number(lineCol[2]) - 1), text.length)
}
