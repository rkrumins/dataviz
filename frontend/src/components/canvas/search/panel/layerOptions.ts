/**
 * Layer options surfaced in the filter palette + LayerEditor picker.
 *
 *  - ``value``  is the string actually stored on ``n.layerAssignment``
 *               and used in the compiled Cypher equality. Pickers emit
 *               this; templates seed predicates with it.
 *  - ``label``  is the human-readable display name. When the value
 *               matches a known layer in the view's reference-layout
 *               config (by ``id`` or ``name``), the layer's
 *               ``name`` is used. Otherwise the value itself.
 */
export interface LayerOption {
    value: string
    label: string
}
