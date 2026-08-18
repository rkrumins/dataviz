import { describe, it, expect } from 'vitest'
import {
    flowRanks,
    flowOrder,
    assignLanes,
    gutterWidth,
    MAX_LANES,
    LANE_W,
    LANE_GAP,
    type InternalEdgeRef,
} from '../frame-flow'

const e = (source: string, target: string): InternalEdgeRef => ({ id: `${source}>${target}`, source, target })

describe('frame-flow — flowRanks', () => {
    it('ranks a straight chain so every wire runs one way down the stack', () => {
        const rank = flowRanks(['c', 'a', 'b'], [e('a', 'b'), e('b', 'c')])
        expect(rank.get('a')).toBe(0)
        expect(rank.get('b')).toBe(1)
        expect(rank.get('c')).toBe(2)
    })

    it('LONGEST path, not shortest — a consumer sits below its LAST producer', () => {
        // a -> b -> c and a -> c: the direct wire must not pull c up to
        // rank 1, or it would run backwards over b, which also feeds it.
        const rank = flowRanks(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c'), e('a', 'c')])
        expect(rank.get('c')).toBe(2)
    })

    it('rows with no internal lineage all rank 0 and keep their incoming order', () => {
        const rows = ['x', 'y', 'z']
        expect(flowOrder(rows, [])).toEqual(rows)
        const rank = flowRanks(rows, [])
        expect([...rank.values()]).toEqual([0, 0, 0])
    })

    it('a cycle does not throw and breaks at the row the caller put FIRST', () => {
        // m -> n -> o -> m, every row blocked. Both orders must resolve
        // to their own first row as the source — the choice is a pure
        // function of the incoming order, never of iteration order.
        const one = flowRanks(['m', 'n', 'o'], [e('m', 'n'), e('n', 'o'), e('o', 'm')])
        expect(one.get('m')).toBe(0)
        expect(one.get('n')).toBe(1)
        expect(one.get('o')).toBe(2)

        const two = flowRanks(['o', 'm', 'n'], [e('m', 'n'), e('n', 'o'), e('o', 'm')])
        expect(two.get('o')).toBe(0)
        expect(two.get('m')).toBe(1)
        expect(two.get('n')).toBe(2)
    })

    it('ignores self-hops and wires to things outside the frame', () => {
        const rank = flowRanks(['a', 'b'], [e('a', 'a'), e('a', 'outside'), e('outside', 'b')])
        expect(rank.get('a')).toBe(0)
        expect(rank.get('b')).toBe(0)
    })
})

describe('frame-flow — flowOrder', () => {
    it('puts producers above consumers — the reported GOLD shape', () => {
        // dim_customer123 feeds fact_orders and fact_product_usage, but
        // arrived third; today it draws below both of them and its wires
        // travel back up across every card between.
        const rows = ['fact_orders', 'fact_pipeline', 'fact_support', 'dim_customer123', 'fact_product_usage']
        const out = flowOrder(rows, [e('dim_customer123', 'fact_orders'), e('dim_customer123', 'fact_product_usage')])
        expect(out.indexOf('dim_customer123')).toBeLessThan(out.indexOf('fact_orders'))
        expect(out.indexOf('dim_customer123')).toBeLessThan(out.indexOf('fact_product_usage'))
    })

    it('preserves the caller\'s own ranking WITHIN a rank', () => {
        // b and c are both fed by a and neither feeds the other, so they
        // share a rank and must stay in the order they arrived in.
        const out = flowOrder(['a', 'b', 'c'], [e('a', 'b'), e('a', 'c')])
        expect(out).toEqual(['a', 'b', 'c'])
        const flipped = flowOrder(['a', 'c', 'b'], [e('a', 'b'), e('a', 'c')])
        expect(flipped).toEqual(['a', 'c', 'b'])
    })

    it('is identity when there is nothing to arrange', () => {
        const rows = ['only']
        expect(flowOrder(rows, [e('only', 'only')])).toEqual(rows)
    })
})

describe('frame-flow — assignLanes', () => {
    const order = ['r0', 'r1', 'r2', 'r3', 'r4']

    it('two overlapping runs never share a lane', () => {
        const lanes = assignLanes(order, [e('r0', 'r3'), e('r1', 'r4')])
        expect(lanes.get('r0>r3')).not.toBe(lanes.get('r1>r4'))
    })

    it('disjoint runs REUSE the innermost lane', () => {
        const lanes = assignLanes(order, [e('r0', 'r1'), e('r2', 'r3')])
        expect(lanes.get('r0>r1')).toBe(0)
        expect(lanes.get('r2>r3')).toBe(0)
    })

    it('short runs hug the rows; the long one sits outside them', () => {
        const lanes = assignLanes(order, [e('r0', 'r4'), e('r1', 'r2')])
        expect(lanes.get('r1>r2')).toBe(0)
        expect(lanes.get('r0>r4')).toBe(1)
    })

    it('a run that touches at a shared endpoint may share a lane — they never overlap', () => {
        const lanes = assignLanes(order, [e('r0', 'r1'), e('r1', 'r2')])
        expect(lanes.get('r0>r1')).toBe(0)
        expect(lanes.get('r1>r2')).toBe(0)
    })

    it('past MAX_LANES a wire gets NO lane rather than one the gutter cannot draw', () => {
        const wide = Array.from({ length: MAX_LANES + 3 }, (_, i) => `w${i}`)
        const rowsWide = ['top', ...wide, 'bottom']
        // Every wire spans the whole list, so none of them can share.
        const edges = wide.map(w => e('top', w))
        const lanes = assignLanes(rowsWide, edges)
        expect(lanes.size).toBe(MAX_LANES)
        expect(new Set(lanes.values()).size).toBe(MAX_LANES)
    })

    it('ignores a wire whose ends are not both rows of this frame', () => {
        const lanes = assignLanes(order, [e('r0', 'elsewhere'), e('r0', 'r0')])
        expect(lanes.size).toBe(0)
    })
})

describe('frame-flow — gutterWidth', () => {
    it('costs nothing when there is nothing to route', () => {
        expect(gutterWidth(0)).toBe(0)
    })

    it('grows a lane at a time and stops at MAX_LANES', () => {
        expect(gutterWidth(1)).toBe(LANE_W + LANE_GAP)
        expect(gutterWidth(3)).toBe(LANE_W * 3 + LANE_GAP)
        expect(gutterWidth(MAX_LANES + 10)).toBe(gutterWidth(MAX_LANES))
    })
})
