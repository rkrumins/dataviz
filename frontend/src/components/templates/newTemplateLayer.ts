import { LAYER_COLORS } from '@/components/views/ViewWizard/steps/LayoutStep'
import { generateId } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

/** A fresh, empty layer for a template — the palette the wizard uses, so
 *  colours never drift between the two places layers are made. */
export function newTemplateLayer(index: number): ViewLayerConfig {
    return {
        id: generateId(),
        name: `Layer ${index + 1}`,
        description: '',
        color: LAYER_COLORS[index % LAYER_COLORS.length],
        entityTypes: [],
        order: index,
    }
}
