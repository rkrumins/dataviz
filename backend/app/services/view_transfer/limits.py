"""The caps an exported or imported view file is held to.

An imported file is untrusted input. These bound the work one request can ask the server to
do, and each is well above what a real view reaches (the wizard itself refuses to draw views
anywhere near them).
"""

#: Views in one bundle. A whole workspace fits; a whole estate does not have to.
MAX_VIEWS_PER_BUNDLE = 200

#: Bytes in one uploaded bundle (the request body).
MAX_BUNDLE_BYTES = 64 * 1024 * 1024

#: Assignments across every view in one bundle.
MAX_ASSIGNMENTS_PER_BUNDLE = 250_000

#: Entries kept in a view's carried history. The oldest are dropped first.
MAX_HISTORY_ENTRIES = 500

#: JSON nesting depth accepted in a definition. Logical nodes and predicate trees nest; nothing
#: legitimate comes close to this.
MAX_JSON_DEPTH = 64

#: Longest string accepted for a name.
MAX_NAME_LENGTH = 500
