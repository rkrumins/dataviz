/**
 * cypherLanguage — what each piece of a Cypher statement is coloured as,
 * and where an engine's error message says the error is.
 */
import { describe, expect, it } from 'vitest'

import { cypherRanges, errorOffset } from '../cypherLanguage'


/** Each piece of ``text`` with the role it is coloured as. */
function roles(text: string): [string, string][] {
    return cypherRanges(text).map((r) => [text.slice(r.from, r.to), r.role])
}


describe('cypherRanges', () => {
    it('colours a statement by what each word is', () => {
        const pieces = roles(
            "MATCH (n:Dataset)-[r:TRANSFORMS]->(m) WHERE n.name = 'it''s' AND n.rows > 10 " +
            'RETURN count(m) AS c, $p1',
        )
        expect(pieces).toEqual(expect.arrayContaining([
            ['MATCH', 'keyword'],
            ['Dataset', 'label'],
            ['TRANSFORMS', 'label'],
            ['WHERE', 'keyword'],
            ['name', 'field'],
            ['rows', 'field'],
            ['10', 'number'],
            ['count', 'function'],
            ['AS', 'keyword'],
            ['$p1', 'param'],
            ['(', 'punct'],
            ['=', 'operator'],
        ]))
        expect(pieces.filter(([, role]) => role === 'value').map(([t]) => t)).toEqual(["'it'", "'s'"])
    })

    it('keeps a string, comment or backtick name whole, whatever is inside it', () => {
        expect(roles('RETURN "MATCH // not a comment" // MATCH here is a comment\n')).toEqual([
            ['RETURN', 'keyword'],
            ['"MATCH // not a comment"', 'value'],
            ['// MATCH here is a comment', 'comment'],
        ])
        expect(roles('MATCH (n:`My Label`) /* a\nblock */ RETURN n.`odd key`')).toEqual(expect.arrayContaining([
            ['`My Label`', 'label'],
            ['/* a\nblock */', 'comment'],
            ['`odd key`', 'text'],
        ]))
    })

    it('colours a keyword in any case, and a namespaced function as one', () => {
        expect(roles('match (n) return date.truncate("day", n.at)')).toEqual(expect.arrayContaining([
            ['match', 'keyword'],
            ['return', 'keyword'],
            ['date', 'function'],
            ['truncate', 'function'],
            ['at', 'field'],
        ]))
    })

    it('runs to the end of text it cannot close', () => {
        expect(roles("RETURN 'open")).toEqual([['RETURN', 'keyword'], ["'open", 'value']])
        expect(roles('RETURN 1 /* open')).toEqual([['RETURN', 'keyword'], ['1', 'number'], ['/* open', 'comment']])
    })
})


describe('errorOffset', () => {
    const query = 'MATCH (n)\nRETRUN n'

    it('reads the offset an engine names', () => {
        // Neo4j, then FalkorDB.
        expect(errorOffset("Invalid input 'RETRUN': expected … (line 2, column 1 (offset: 10))", query)).toBe(10)
        expect(errorOffset("errMsg: Invalid input 'R': expected … line: 2, column: 1, offset: 10", query)).toBe(10)
    })

    it('counts the line and column when only those are named', () => {
        expect(errorOffset('Syntax error at line: 2, column: 3', query)).toBe(12)
    })

    it('stays inside the text, and is null when no place is named', () => {
        expect(errorOffset('offset: 999', query)).toBe(query.length)
        expect(errorOffset('Query timed out', query)).toBeNull()
    })
})
