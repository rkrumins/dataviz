/**
 * The fields of an entity's type a publish judges (`lib/fieldRules`), handed to the property
 * editor's rows: each row of one of them offers its allowed values and warns of a value publishing
 * would refuse. Absent, nothing is governed.
 */
import { createContext } from 'react'
import type { EntityFieldDefinition } from '@/types/schema'

export interface GovernedFields {
  /** By property key. */
  fields: ReadonlyMap<string, EntityFieldDefinition>
  /** The entity's type, as the warnings name it ("Table"). */
  typeLabel: string
}

export const GovernedFieldsContext = createContext<GovernedFields | null>(null)
