/** Helpers for `ActivityCalendar`, kept apart so the component file exports only components. */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function describeDay(iso: string): string {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    })
}

/** The year by month, for the card's table twin. */
export function calendarByMonth(days: string[], actions: number[]): { rows: string[]; values: number[]; active: number[] } {
    const order: string[] = []
    const totals = new Map<string, number>()
    const active = new Map<string, number>()
    days.forEach((d, i) => {
        const key = d.slice(0, 7)
        if (!totals.has(key)) { order.push(key); totals.set(key, 0); active.set(key, 0) }
        totals.set(key, (totals.get(key) ?? 0) + (actions[i] ?? 0))
        if ((actions[i] ?? 0) > 0) active.set(key, (active.get(key) ?? 0) + 1)
    })
    return {
        rows: order.map((k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`),
        values: order.map((k) => totals.get(k) ?? 0),
        active: order.map((k) => active.get(k) ?? 0),
    }
}
