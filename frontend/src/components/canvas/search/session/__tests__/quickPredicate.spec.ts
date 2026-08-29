/**
 * The quick-query model behind the canvas header search box: what a
 * typed word compiles to on the wire, and how the same word filters
 * already-loaded rows locally.
 *
 * Two things are load-bearing here:
 *   * the two-character floor — one letter matches most of a view, and
 *     the debounced lane would pay for a full scan on every keystroke.
 *     Enter opts out of it (``minLength: 1``), which is what makes
 *     "< 2 chars waits for Enter" true rather than "< 2 chars is
 *     unsearchable";
 *   * the scoped shape — an "inside ‹container›" chip has to produce the
 *     SAME predicate the builder produces for that row, because Refine
 *     opens on the committed draft and the panel must show the identical
 *     condition rows the header just ran.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_QUICK, buildQuickPredicate, matchesQuick, type QuickQuery } from '../quickPredicate'


function quick(partial: Partial<QuickQuery> = {}): QuickQuery {
    return { ...DEFAULT_QUICK, text: 'customer', ...partial }
}


describe('buildQuickPredicate — Look in', () => {
    it('"everything" targets `any` — a bare word matches name, path, description, tags and property values', () => {
        expect(buildQuickPredicate(quick())).toEqual({
            kind: 'text', target: 'any', value: 'customer', match: 'substring',
        })
    })

    it.each([
        ['name', 'name'],
        ['description', 'description'],
        ['tags', 'tags'],
    ] as const)('"%s" narrows the target to `%s`', (lookIn, target) => {
        expect(buildQuickPredicate(quick({ lookIn }))).toEqual({
            kind: 'text', target, value: 'customer', match: 'substring',
        })
    })

    it('a property key targets `property` and carries the key', () => {
        expect(buildQuickPredicate(quick({ lookIn: { property: 'logicalType' } }))).toEqual({
            kind: 'text', target: 'property', propertyKey: 'logicalType',
            value: 'customer', match: 'substring',
        })
    })
})


describe('buildQuickPredicate — Match', () => {
    it.each(['substring', 'prefix', 'suffix', 'exact'] as const)(
        '"%s" passes straight through as the wire match mode',
        (match) => {
            expect(buildQuickPredicate(quick({ match }))).toMatchObject({ match })
        },
    )
})


describe('buildQuickPredicate — length floor', () => {
    it('is null under two characters, so a debounced keystroke dispatches nothing', () => {
        expect(buildQuickPredicate(quick({ text: 'c' }))).toBeNull()
    })

    it('is null for whitespace that trims away to nothing', () => {
        expect(buildQuickPredicate(quick({ text: '   ' }))).toBeNull()
    })

    it('runs at exactly two characters', () => {
        expect(buildQuickPredicate(quick({ text: 'cu' }))).toMatchObject({ value: 'cu' })
    })

    it('trims the value it sends', () => {
        expect(buildQuickPredicate(quick({ text: '  customer  ' }))).toMatchObject({ value: 'customer' })
    })

    it('an explicit floor of 1 (what Enter passes) builds the single-character query', () => {
        expect(buildQuickPredicate(quick({ text: 'c' }), 1)).toEqual({
            kind: 'text', target: 'any', value: 'c', match: 'substring',
        })
    })

    it('is null for empty text even at a floor of 1 — Enter on an empty box runs nothing', () => {
        expect(buildQuickPredicate(quick({ text: '' }), 1)).toBeNull()
    })
})


describe('buildQuickPredicate — scope', () => {
    it('view scope is the bare leaf — the server resolves the view\'s own roots', () => {
        expect(buildQuickPredicate(quick())).toEqual({
            kind: 'text', target: 'any', value: 'customer', match: 'substring',
        })
    })

    it('a container scope ANDs a descendantOf row beside the leaf', () => {
        const predicate = buildQuickPredicate(
            quick({ scope: { insideUrn: 'urn:db:orders', label: 'Orders' } }),
        )
        expect(predicate).toEqual({
            kind: 'group',
            op: 'and',
            children: [
                { kind: 'text', target: 'any', value: 'customer', match: 'substring' },
                // 'any' is the FE-only hint that routes ConditionRow to the
                // any-node picker — a scoped container is usually deeper than
                // the view's top-level roots.
                { kind: 'descendantOf', urns: ['urn:db:orders'], uiScope: 'any' },
            ],
        })
    })

    it('the length floor still applies inside a scope', () => {
        expect(buildQuickPredicate(
            quick({ text: 'c', scope: { insideUrn: 'urn:db:orders', label: 'Orders' } }),
        )).toBeNull()
    })
})


describe('matchesQuick', () => {
    it.each([
        ['substring', 'Customer Orders', 'tomer', true],
        ['substring', 'Customer Orders', 'zzz', false],
        ['prefix', 'Customer Orders', 'cust', true],
        ['prefix', 'Customer Orders', 'orders', false],
        ['suffix', 'Customer Orders', 'orders', true],
        ['suffix', 'Customer Orders', 'customer', false],
        ['exact', 'Customer Orders', 'customer orders', true],
        ['exact', 'Customer Orders', 'customer', false],
    ] as const)('%s: %s vs "%s" → %s', (match, name, text, expected) => {
        expect(matchesQuick(name, quick({ match, text }))).toBe(expected)
    })

    it('is case-insensitive in both directions', () => {
        expect(matchesQuick('CUSTOMER', quick({ text: 'customer', match: 'exact' }))).toBe(true)
        expect(matchesQuick('customer', quick({ text: 'CUSTOMER', match: 'exact' }))).toBe(true)
    })

    it('an empty query matches everything — the row box shows all loaded children', () => {
        expect(matchesQuick('anything at all', quick({ text: '' }))).toBe(true)
        expect(matchesQuick('anything at all', quick({ text: '  ' }))).toBe(true)
    })

    it('matches on one character — the local filter has no length floor', () => {
        expect(matchesQuick('Customer', quick({ text: 'c', match: 'prefix' }))).toBe(true)
    })
})
