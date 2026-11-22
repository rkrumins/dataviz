/**
 * The keys a slider owes a keyboard user (WAI-ARIA slider pattern): ← ↓ and → ↑ take a step,
 * Page Up and Page Down a big step, Home and End go to the ends. Shared by Slider and the
 * two-thumb tracks in the settings explainers, so every slider in the app moves the same way.
 *
 * Returns the new value, or null for a key a slider doesn't use (let it through).
 */
export function sliderKeyValue(
    key: string,
    value: number,
    { min, max, step = 1, bigStep }: { min: number; max: number; step?: number; bigStep?: number },
): number | null {
    const big = bigStep ?? Math.max(step, (max - min) / 10)
    const next: Record<string, number> = {
        ArrowRight: value + step, ArrowUp: value + step,
        ArrowLeft: value - step, ArrowDown: value - step,
        PageUp: value + big, PageDown: value - big,
        Home: min, End: max,
    }
    if (!(key in next)) return null
    return snap(next[key], min, max, step)
}

/** A value on the slider's grid of steps, inside its ends. */
export function snap(value: number, min: number, max: number, step = 1): number {
    const stepped = Math.round((value - min) / step) * step + min
    const places = (String(step).split('.')[1] ?? '').length
    return Math.min(max, Math.max(min, Number(stepped.toFixed(places))))
}
