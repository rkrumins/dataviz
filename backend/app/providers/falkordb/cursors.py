"""Keyset pagination cursors: kernel re-exports under the old names.

Moved unchanged into ``backend.common.providers.cursors`` under public
names (the pre-class section of the former ``falkordb_provider.py``, lines
140-157 and 181-254 as of the package move); the aliases below bind the
old private names to the SAME objects so every existing
``from ...falkordb_provider import _decode_keyset_cursor`` (etc.) call
site keeps resolving to the shared implementation.
"""
from backend.common.providers.cursors import (
    CURSOR_PREFIX,
    CursorMismatchError,
    validate_sort_direction,
    encode_keyset_cursor,
    decode_keyset_cursor,
    keyset_sort_key,
    keyset_sort,
)

_CURSOR_PREFIX = CURSOR_PREFIX
_validate_sort_direction = validate_sort_direction
_encode_keyset_cursor = encode_keyset_cursor
_decode_keyset_cursor = decode_keyset_cursor
_keyset_sort_key = keyset_sort_key
_keyset_sort = keyset_sort
