/** What each draft level means, in the words the UI uses wherever a level is shown or chosen. */
import type { DraftLevel } from '@/services/versioningApiService'

export const DRAFT_LEVEL_WORDS: Record<DraftLevel, { label: string; who: string }> = {
  public: { label: 'Public', who: 'Everyone who can see this data source sees it' },
  private: { label: 'Private', who: 'Only its owner, the people added to it and its reviewers see it' },
}
