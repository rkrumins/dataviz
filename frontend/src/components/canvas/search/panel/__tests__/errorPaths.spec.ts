import { describe, expect, it } from 'vitest'

import { describeQueryPath, humanizeQueryPaths, readableSearchError } from '../errorPaths'


describe('errorPaths — a server message in the panel’s words', () => {
    it.each([
        ['$', 'the query'],
        ['$.predicate', 'the query'],
        ['$.children[1].where', 'filter 2 › its condition'],
        ['$.children[0].sourceWhere.refs[0]', 'filter 1 › where it starts › name 1'],
        ['$.children[2].targetRefs[1]', 'filter 3 › where it ends › name 2'],
        ['$.children[0].edge.children[1]', 'filter 1 › its edge filter › condition 2'],
        ['$.children[0].children[3].edgePredicate', 'filter 1 › condition 4 › its edge filter'],
        ['$.items[1].predicate.children[0]', 'rule 2 › condition 1'],
    ])('reads %s', (path, words) => {
        expect(describeQueryPath(path)).toBe(words)
    })

    it('rewrites only the paths in a message', () => {
        expect(humanizeQueryPaths('relationship at $.children[1].where nests relationships more than 3 deep'))
            .toBe('relationship at filter 2 › its condition nests relationships more than 3 deep')
        expect(humanizeQueryPaths('$.predicate has 70 leaves (max 64)')).toBe('the query has 70 leaves (max 64)')
        expect(humanizeQueryPaths('OR group at $.children[0]: too wide.')).toBe('OR group at filter 1: too wide.')
        // A parameter or a price isn't a path.
        expect(humanizeQueryPaths('bad value for $p0 or US$5')).toBe('bad value for $p0 or US$5')
    })
})


describe('readableSearchError — a failed request in plain words', () => {
    it('unwraps the detail of an API error and names its positions', () => {
        expect(readableSearchError(
            'API Error 400: {"detail":"relationship at $.children[1].where nests relationships more than 3 deep"}',
        )).toBe('relationship at filter 2 › its condition nests relationships more than 3 deep')
    })

    it('reads a structured detail by its message', () => {
        expect(readableSearchError(
            'API Error 403: {"detail":{"error":"missing_permission","message":"Missing permission: workspace:datasource:read"}}',
        )).toBe('Missing permission: workspace:datasource:read')
    })

    it('reads FastAPI validation entries as positions', () => {
        expect(readableSearchError(
            'API Error 422: {"detail":[{"loc":["body","predicate","children",0,"value"],"msg":"Field required","type":"missing"},'
            + '{"loc":["body","options"],"msg":"Input should be an object"}]}',
        )).toBe('filter 1 › value: Field required; options: Input should be an object')
    })

    it('says something useful when the body does not', () => {
        expect(readableSearchError('API Error 502: <html><body>Bad gateway</body></html>'))
            .toBe("The server couldn't answer right now. Try again.")
        expect(readableSearchError('API Error 429: {}')).toBe('Too many requests. Try again in a moment.')
        expect(readableSearchError('API Error 418: ')).toBe('The request failed (418).')
    })

    it('keeps a plain-text body, and a message that is not an API error', () => {
        expect(readableSearchError('API Error 400: query too wide')).toBe('query too wide')
        expect(readableSearchError('Request timed out')).toBe('Request timed out')
        expect(readableSearchError('bad $.children[0]')).toBe('bad filter 1')
    })
})
