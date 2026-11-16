/**
 * The settings kit: one way to show, explain, stage, review and save a versioned-graph setting,
 * wherever it is set (the platform, a workspace, a graph). Built against the registry's schema
 * (`types.ts`, held to the generated catalogue by `catalogue.ts`) and the resolver's answer per
 * key; `__fixtures__` holds the served schema and resolved values at three scopes.
 */
export * from './types'
export { CATALOGUE } from './catalogue'

export { SettingRow, type SettingRowProps } from './SettingRow'
export { SettingControl, type SettingControlProps } from './SettingControl'
export { ChoiceCards, type ChoiceCardsProps } from './ChoiceCards'
export { ProvenanceTrail } from './ProvenanceTrail'
export { ScopeBadge } from './ScopeBadge'
export { StatusBadge } from './StatusBadge'
export { ImpactChips } from './ImpactChips'
export { GuidancePanel, type GuidancePanelProps } from './GuidancePanel'
export { WhyBanner } from './WhyBanner'
export { ChangeReviewDialog, type ChangeReviewDialogProps, type ReviewWarning } from './ChangeReviewDialog'
export { StickySaveBar } from './StickySaveBar'
export { SettingsSearch } from './SettingsSearch'
export { LensSwitch } from './LensSwitch'
export { ProfilePicker, type ProfilePickerProps } from './ProfilePicker'

export { TradeoffCompass } from './visuals/TradeoffCompass'
export { ReadTimeline } from './visuals/ReadTimeline'
export { WriteRhythm, type Rhythm } from './visuals/WriteRhythm'
export { MemoryMarks, type MemoryMarksProps } from './visuals/MemoryMarks'
export { CopyRoomBar } from './visuals/CopyRoomBar'
export { RetentionTimeline, IdleTimeline } from './visuals/RetentionTimeline'
export { GuardMeter, type GuardLimits } from './visuals/GuardMeter'
export { SymptomFinder } from './visuals/SymptomFinder'
export { SettingVisual } from './visuals/SettingVisual'

export { useStagedChanges, diffStaged, type PatchItem, type StagedChange, type StagedChanges } from './useStagedChanges'
export { useLens, lensFor, orderForLens, type Lens } from './lens'
export {
    formatValue, settingAnchor, describeFix, inheritedAt, ownValue, boundsAt, lockedFor, limitsFor, sameValue,
    SCOPE_LABEL, SCOPE_HERE, FEATURE_NAMES,
} from './format'
export { STATUS_META, SCOPE_ICON, VERDICT_META, RISK_META } from './meta'
export { searchSettings, symptomIndex, normalize, type SearchHit, type MatchField } from './search'
export { compassScores, compassMoves, scoreWords, type CompassPoint, type CompassDriver } from './compass'
export { choiceImpacts, changeImpacts, type Impact } from './impacts'
export { reviewItems, type ReviewItem } from './review'
export { validateValue, validateStaged, type ValidationContext } from './validate'
export { applyProfile, skipWords, type ProfilePlan, type SkipReason } from './profiles'
