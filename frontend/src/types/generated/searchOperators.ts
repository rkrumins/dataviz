/**
 * AUTO-GENERATED FROM THE PROPERTY-OPERATOR TABLE — DO NOT EDIT BY HAND.
 *
 * Source : backend/common/schema/searchoperators.v1.json
 *          (backend/common/search_semantics.py OPERATOR_TABLE)
 * Run    : `pnpm gen:search-schema` (from the frontend tree)
 *
 * `arity` is the value an operator takes (none | one | many | pair |
 * duration); `types` the value types it compares as (one type: it always
 * compares as that); `negative` marks the operators that match by absence.
 */
export const OPERATOR_TABLE = {
    between: { arity: 'pair', types: ['number', 'date', 'string'], negative: false },
    contains: { arity: 'one', types: ['string'], negative: false },
    containsAll: { arity: 'many', types: ['string', 'number', 'boolean'], negative: false },
    endsWith: { arity: 'one', types: ['string'], negative: false },
    eq: { arity: 'one', types: ['string', 'number', 'boolean', 'date'], negative: false },
    gt: { arity: 'one', types: ['number', 'date', 'string'], negative: false },
    gte: { arity: 'one', types: ['number', 'date', 'string'], negative: false },
    in: { arity: 'many', types: ['string', 'number', 'boolean'], negative: false },
    isEmpty: { arity: 'none', types: [], negative: false },
    isNotEmpty: { arity: 'none', types: [], negative: false },
    isNotSet: { arity: 'none', types: [], negative: false },
    isSet: { arity: 'none', types: [], negative: false },
    lt: { arity: 'one', types: ['number', 'date', 'string'], negative: false },
    lte: { arity: 'one', types: ['number', 'date', 'string'], negative: false },
    neq: { arity: 'one', types: ['string', 'number', 'boolean', 'date'], negative: true },
    notContains: { arity: 'one', types: ['string'], negative: true },
    notIn: { arity: 'many', types: ['string', 'number', 'boolean'], negative: true },
    startsWith: { arity: 'one', types: ['string'], negative: false },
    withinLast: { arity: 'duration', types: ['date'], negative: false },
} as const

export type PropertyOperator = keyof typeof OPERATOR_TABLE
export type OperatorArity = (typeof OPERATOR_TABLE)[PropertyOperator]['arity']
export type ComparisonType = (typeof OPERATOR_TABLE)[PropertyOperator]['types'][number]
