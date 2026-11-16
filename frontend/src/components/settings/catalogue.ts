/**
 * The registry's catalogue, held to the kit's types at compile time.
 *
 * `src/generated/versionedGraphSettings.json` is generated from
 * `backend/app/config/versioned_graph_settings.py` (`export_settings_reference.py`). If the
 * registry renames, drops or retypes a field the UI reads, or adds one the types don't describe,
 * `tsc` fails here and names it, instead of the app finding out at run time.
 *
 * Two checks, because a JSON import is typed with `string` where the types have word lists:
 * - `satisfies Widen<SettingsSchema>`: every field the types promise is there, with the right
 *   shape (arrays, objects, numbers, strings, nulls). The word lists themselves (kinds, dimensions,
 *   verdicts…) are checked by `__tests__/catalogue.test.ts`.
 * - `CatalogueFieldsKnown`: no object in the catalogue carries a field the types don't know.
 */
import catalogue from '@/generated/versionedGraphSettings.json'
import type {
    Cap, Category, Choice, DefaultSpec, DeploymentFact, Effect, Frame, Guidance, Legacy, Recommended, Requirement,
    Retired, Rule, Setting, SettingsSchema, TakesEffect, Term, WhyText,
} from './types'

/** A type with its word lists widened to `string` (and tuples to arrays), as a JSON import types them. */
type Widen<T> = T extends string ? string
    : T extends number ? number
        : T extends boolean ? boolean
            : T extends readonly (infer U)[] ? Widen<U>[]
                : T extends object ? { [K in keyof T]: Widen<T[K]> }
                    : T

/** Every key of every member of a union (`keyof` of a union keeps only the shared ones). */
type AllKeys<T> = T extends unknown ? keyof T : never
type Known<J, T> = [Exclude<AllKeys<J>, keyof T>] extends [never] ? true : { unknownFields: Exclude<AllKeys<J>, keyof T> }
type Assert<T extends true> = T

type Json = typeof catalogue
type JsonSetting = Json['settings'][number]
type JsonChoice = JsonSetting['choices'][number]

/** Fails to compile, naming the field, when the catalogue carries a field the types don't describe. */
export type CatalogueFieldsKnown = [
    Assert<Known<Json, SettingsSchema>>,
    Assert<Known<Json['categories'][number], Category>>,
    Assert<Known<JsonSetting, Setting>>,
    Assert<Known<JsonSetting['default'], DefaultSpec>>,
    Assert<Known<JsonSetting['takesEffect'], TakesEffect>>,
    Assert<Known<JsonSetting['guidance'], Guidance>>,
    Assert<Known<JsonSetting['guidance']['effects'][number], Effect>>,
    Assert<Known<JsonSetting['guidance']['recommended'], Recommended>>,
    Assert<Known<JsonChoice, Choice>>,
    Assert<Known<JsonChoice['frames'][number], Frame>>,
    Assert<Known<JsonSetting['requires'][number], Requirement>>,
    Assert<Known<JsonSetting['caps'][number], Cap>>,
    Assert<Known<JsonSetting['rules'][number], Rule>>,
    Assert<Known<NonNullable<JsonSetting['legacy']>, Legacy>>,
    Assert<Known<Json['glossary'][number], Term>>,
    Assert<Known<Json['why'][keyof Json['why']], WhyText>>,
    Assert<Known<Json['deployment'][number], DeploymentFact>>,
    Assert<Known<Json['retired'][number], Retired>>,
]

/** The catalogue as the app ships it: every field the kit reads is there, in its shape. */
export const CATALOGUE = (catalogue satisfies Widen<SettingsSchema>) as unknown as SettingsSchema
