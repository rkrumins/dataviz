import { describe, expect, it } from 'vitest'
import { csvCell, csvLine } from '../csv'

describe('csv', () => {
  it('never writes a cell a spreadsheet would run', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('quotes what needs it and reads values as they are', () => {
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(['pii', 'gdpr'])).toBe('pii; gdpr')
    expect(csvCell(true)).toBe('Yes')
    expect(csvCell(null)).toBe('')
    expect(csvLine(['a', 1, { b: 2 }])).toBe('a,1,"{""b"":2}"\r\n')
  })
})
