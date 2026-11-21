/** One of an answer's cards, by its type. A type this panel doesn't know is left out. */
import type { Block } from '../api/types'
import { ClarificationCard, type ClarificationChoice } from './blocks/ClarificationCard'
import { DocCitationList } from './blocks/DocCitationList'
import { EntityCard } from './blocks/EntityCard'
import { ImpactReportCard } from './blocks/ImpactReportCard'
import { NoticeCallout } from './blocks/NoticeCallout'
import { QueryBlock } from './blocks/QueryBlock'
import { ResultSummaryCard } from './blocks/ResultSummaryCard'
import { ViewSuggestionCard } from './blocks/ViewSuggestionCard'
import { ContextCard } from './ContextCard'

export function BlockView({ block, anchorPrefix, onClarify, onOther, onAsk, busy }: {
    block: Block
    anchorPrefix: string
    onClarify: (clarificationId: string, choice: ClarificationChoice) => void
    onOther: (clarificationId: string, text: string) => void
    onAsk: (question: string) => void
    busy: boolean
}) {
    switch (block.type) {
        case 'results': return <ResultSummaryCard data={block.data} />
        case 'impact': return <ImpactReportCard data={block.data} />
        case 'query': return <QueryBlock data={block.data} />
        case 'views': return <ViewSuggestionCard data={block.data} />
        case 'citations': return <DocCitationList data={block.data} anchorPrefix={anchorPrefix} />
        case 'entity': return <EntityCard data={block.data} />
        case 'notice': return <NoticeCallout data={block.data} />
        case 'context': return <ContextCard variant="block" brief={block.data} onAsk={onAsk} disabled={busy} />
        case 'clarify':
            return (
                <ClarificationCard
                    data={block.data}
                    disabled={busy}
                    onAnswer={(choice) => onClarify(block.id, choice)}
                    onOther={block.data.allowOther ? (text) => onOther(block.id, text) : undefined}
                />
            )
        default:
            return null
    }
}
