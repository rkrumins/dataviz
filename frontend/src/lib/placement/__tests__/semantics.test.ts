import { describe, expect, it } from 'vitest'
import { evaluate, foldCase, resolveRuleComparison, RULE_OPERATORS, SemanticsError } from '../semantics'

/** Does `stored` satisfy the rule condition `operator value`? */
const holds = (stored: unknown, operator: string, value?: unknown) =>
  evaluate(stored, resolveRuleComparison(operator, value))

describe('foldCase (search_semantics.fold_case)', () => {
  it('lowers one character at a time', () => {
    expect(foldCase('ΑΣ')).toBe('ασ')           // no final sigma
    expect(foldCase('İstanbul')).toBe('istanbul') // not 'i̇stanbul'
    expect(foldCase('ÉCOLE')).toBe('école')
    expect(foldCase('Dataset')).toBe('dataset')
  })

  it('does not trim', () => {
    expect(foldCase(' A ')).toBe(' a ')
  })
})

describe('resolveRuleComparison', () => {
  it('maps the six rule operators onto the shared table', () => {
    expect(RULE_OPERATORS).toEqual({
      equals: 'eq', notEquals: 'neq', contains: 'contains', startsWith: 'startsWith', endsWith: 'endsWith', exists: 'isSet',
    })
  })

  it('types a value the way value_type auto does, folding text', () => {
    expect(resolveRuleComparison('equals', 'Finance')).toEqual({ op: 'eq', type: 'string', value: 'finance' })
    expect(resolveRuleComparison('equals', 15)).toEqual({ op: 'eq', type: 'number', value: 15 })
    expect(resolveRuleComparison('notEquals', true)).toEqual({ op: 'neq', type: 'boolean', value: true })
    expect(resolveRuleComparison('contains', 74)).toEqual({ op: 'contains', type: 'string', value: '74' })
    expect(resolveRuleComparison('exists', undefined)).toEqual({ op: 'isSet', type: null })
    expect(resolveRuleComparison('equals', ['x'])).toEqual({ op: 'eq', type: 'string', value: 'x' })
  })

  it('compares a number past the 64-bit integers, which reached the canvas as a float', () => {
    expect(resolveRuleComparison('notEquals', 1e21)).toEqual({ op: 'neq', type: 'number', value: 1e21 })
  })

  it('accepts empty text for equals, which has more than one type', () => {
    expect(holds('', 'equals', '')).toBe(true)
    expect(holds('a', 'equals', '')).toBe(false)
  })

  it.each([
    ['unknown', 'x', "unknown operator 'unknown'"],
    ['gt', 1, "unknown operator 'gt'"],
    ['toString', 'x', "unknown operator 'toString'"],
    ['equals', null, 'enter a value'],
    ['equals', undefined, 'enter a value'],
    ['equals', [1, 2], '[1,2] is not a single value'],
    ['equals', [], '[] is not a single value'],
    ['equals', { a: 1 }, '{"a":1} is not a single value'],
    ['contains', '', 'type some text to look for'],
    ['startsWith', [''], 'type some text to look for'],
  ])('refuses %s %j', (operator, value, message) => {
    expect(() => resolveRuleComparison(operator, value)).toThrow(SemanticsError)
    expect(() => resolveRuleComparison(operator, value)).toThrow(message)
  })
})

describe('evaluate (search_semantics.evaluate, rule slice)', () => {
  it('exists: anything but null or missing', () => {
    expect(holds(undefined, 'exists')).toBe(false)
    expect(holds(null, 'exists')).toBe(false)
    for (const v of ['', 0, false, []]) expect(holds(v, 'exists')).toBe(true)
  })

  it('text compares case-insensitively', () => {
    expect(holds('FINANCE', 'equals', 'finance')).toBe(true)
    expect(holds('Sales Orders', 'contains', 'ORDERS')).toBe(true)
    expect(holds('Sales Orders', 'startsWith', 'sa')).toBe(true)
    expect(holds('Sales Orders', 'endsWith', 'Sales')).toBe(false)
    expect(holds('İSTANBUL', 'equals', 'istanbul')).toBe(true)
  })

  it('reads a stored number or boolean as text for a text value', () => {
    expect(holds(15, 'equals', '15')).toBe(true)
    expect(holds(1749, 'contains', 74)).toBe(true)
    expect(holds(true, 'equals', 'TRUE')).toBe(true)
  })

  it('prints the float -0.0 as -0 and the integer 0 as 0', () => {
    expect(holds(-0, 'equals', '-0')).toBe(true)
    expect(holds(0, 'equals', '-0')).toBe(false)
  })

  it.each([
    [1.5, '1.5'],
    [0.1, '0.1'],
    [1 / 3, '0.333333333333333'],
    [1e-5, '1e-05'],
    [0.000123, '0.000123'],
    [1e20, '1e+20'],
    [1e16, '1e+16'],  // an integer past 2^53 reaches the canvas as text, so this was a float
    [123456789012345.6, '123456789012346'],
    [99999999999999.95, '100000000000000'],
    [999999999999999.5, '1e+15'],
    [2 ** -22, '2.38418579101562e-07'],  // an exact tie, rounded to even
    [100000000000000.5, '100000000000000'],
    [-2.5, '-2.5'],
    [5e-324, '4.94065645841247e-324'],
  ])('prints the float %s as %s, to 15 significant digits', (stored, text) => {
    expect(holds(stored, 'equals', text)).toBe(true)
  })

  it('reads stored text as a number for a number value', () => {
    expect(holds('015', 'equals', 15)).toBe(true)
    expect(holds(' 15', 'equals', 15)).toBe(true)
    expect(holds('+15', 'equals', 15)).toBe(true)
    expect(holds('12.5', 'equals', 12.5)).toBe(true)
    expect(holds('-.5', 'equals', -0.5)).toBe(true)
    expect(holds('5.', 'equals', 5)).toBe(true)
    for (const s of ['15 ', '1e3', '0x10', '1.2.3', '.', 'n/a']) expect(holds(s, 'equals', Number(s) || 15)).toBe(false)
    expect(holds(true, 'equals', 1)).toBe(false)
  })

  it('reads stored text as a boolean for a boolean value', () => {
    expect(holds('TRUE', 'equals', true)).toBe(true)
    expect(holds('False', 'equals', false)).toBe(true)
    expect(holds('yes', 'equals', true)).toBe(false)
    expect(holds(1, 'equals', true)).toBe(false)
  })

  it('notEquals: a missing value never matches', () => {
    expect(holds(undefined, 'notEquals', 'x')).toBe(false)
    expect(holds(null, 'notEquals', 'x')).toBe(false)
    expect(holds('y', 'notEquals', 'x')).toBe(true)
    expect(holds('X', 'notEquals', 'x')).toBe(false)
  })

  it('a stored list matches when any element does, notEquals when none does', () => {
    expect(holds(['a', 'B'], 'equals', 'b')).toBe(true)
    expect(holds(['a', 'B'], 'notEquals', 'b')).toBe(false)
    expect(holds(['a', 'B'], 'notEquals', 'c')).toBe(true)
    expect(holds([], 'equals', 'a')).toBe(false)
    expect(holds([], 'notEquals', 'a')).toBe(true)
    expect(holds([null, 'a'], 'equals', 'a')).toBe(true)
  })

  it('a nested list or an object has no text', () => {
    expect(holds([['a']], 'equals', 'a')).toBe(false)
    expect(holds({ a: 1 }, 'equals', 'a')).toBe(false)
    expect(holds({ a: 1 }, 'notEquals', 'a')).toBe(true)
  })
})
