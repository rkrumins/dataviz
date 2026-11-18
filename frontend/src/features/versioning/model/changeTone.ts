/**
 * One colour language for change, everywhere a change is shown — taken from the tree
 * (`FlatTreeItem`'s row tints), so a change reads the same on a tree row, a canvas card, a change
 * list, a property and a badge:
 *
 * - **Added** green, **Modified** orange, **Removed** rose.
 * - **Unsaved** (staged) is the saturated form with a dashed halo; **saved in the draft** the lighter,
 *   solid form (`frame`).
 *
 * Plain class strings only, every opacity on the configured scale (the alpha guard compiles them).
 */
import type { ChangeStatus } from './changeModel'

export interface ChangeTone {
  label: string
  /** The status in words, as a verb's past ("Added", "Edited", "Removed"). */
  verb: string
  /** Coloured text. */
  text: string
  /** A soft background behind a row or a card. */
  soft: string
  /** A small pill: background and text. */
  chip: string
  /** A solid bar or dot. */
  bar: string
  border: string
  ring: string
  /** A left accent (`border-l-2` + this). */
  accent: string
}

export const CHANGE_TONE: Record<ChangeStatus, ChangeTone> = {
  added: {
    label: 'Added', verb: 'Added',
    text: 'text-green-600 dark:text-green-400',
    soft: 'bg-green-500/5',
    chip: 'bg-green-500/12 text-green-700 dark:text-green-300',
    bar: 'bg-green-500',
    border: 'border-green-500/30',
    ring: 'ring-green-500/60',
    accent: 'border-l-green-500',
  },
  modified: {
    label: 'Modified', verb: 'Edited',
    text: 'text-orange-600 dark:text-orange-400',
    soft: 'bg-orange-500/5',
    chip: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
    bar: 'bg-orange-500',
    border: 'border-orange-500/30',
    ring: 'ring-orange-500/60',
    accent: 'border-l-orange-500',
  },
  removed: {
    label: 'Removed', verb: 'Removed',
    text: 'text-rose-600 dark:text-rose-400',
    soft: 'bg-rose-500/5',
    chip: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
    bar: 'bg-rose-500',
    border: 'border-rose-500/30',
    ring: 'ring-rose-500/60',
    accent: 'border-l-rose-500',
  },
}

/** A field's change (`added` / `changed` / `removed`) in the same colours as its entity's. */
export function fieldTone(kind: 'added' | 'changed' | 'removed'): ChangeTone {
  return CHANGE_TONE[kind === 'changed' ? 'modified' : kind]
}

/** Unsaved (staged) or saved in the draft — as the tree frames them: dashed, or solid. */
export type ChangeState = 'unsaved' | 'saved'

/** A small marker for the state: a hollow dashed dot (unsaved) or a solid one (saved). */
export const STATE_DOT: Record<ChangeState, string> = {
  unsaved: 'border border-dashed border-current bg-transparent',
  saved: 'bg-current',
}

export const STATE_LABEL: Record<ChangeState, string> = {
  unsaved: 'Not saved yet',
  saved: 'Saved in this draft',
}
