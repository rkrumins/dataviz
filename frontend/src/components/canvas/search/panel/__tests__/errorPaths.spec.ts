import { describe, expect, it } from 'vitest'

import { describeQueryPath, humanizeQueryPaths } from '../errorPaths'


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
