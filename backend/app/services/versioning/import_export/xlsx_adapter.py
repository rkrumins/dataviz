"""xlsx FormatAdapter — a real Excel workbook with a **Nodes** sheet + **Edges** sheet, locked
identity columns, an Instructions sheet, and an ``_op`` dropdown.

This is the strategic fix for flat-CSV fragility (a hand-added column or a trimmed trailing cell
silently shifts a value into the wrong column, e.g. a property landing in ``_op``): in Excel each
column is a named header and the kind comes from the SHEET, not a ``kind`` column, so adding a
property means typing under a ``prop.<name>`` header — nothing shifts. Reading needs openpyxl, so
it lives in its own module and registers lazily in :data:`formats._ADAPTERS` (a missing lib never
breaks the other formats). Writing streams the workbook's XML straight into the zip, a page of rows
at a time, so an export of any size is written in flat memory.
"""
from __future__ import annotations

import asyncio
import io
import math
import re
import zipfile
from typing import Any, AsyncIterator, Dict, List, Sequence

from .rowmodel import cell_text, parse_list_cells

# Identity / system columns — greyed in the header so users know not to touch them.
_LOCKED = {"entity_id", "urn", "baseVersion", "source_entity_id", "target_entity_id"}
_NODE_SHEET = "Nodes"
_EDGE_SHEET = "Edges"
_INSTRUCTIONS = "Instructions"


class XlsxAdapter:
    fmt = "xlsx"

    async def parse(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[Dict[str, Any]]:
        import openpyxl  # lazy — only when xlsx is actually used

        buf = bytearray()   # amortized appends; `bytes +=` re-copied the whole buffer per chunk
        async for chunk in chunks:
            buf += chunk
        wb = openpyxl.load_workbook(io.BytesIO(buf), read_only=True, data_only=True)
        del buf   # BytesIO copied it (only exact bytes are shared): don't hold the upload twice
        try:
            for sheet_name, kind in ((_NODE_SHEET, "node"), (_EDGE_SHEET, "edge")):
                ws = _find_sheet(wb, sheet_name)
                if ws is None:
                    continue
                for rec in _read_sheet(ws):
                    rec["kind"] = kind          # kind is the SHEET, not a column
                    yield rec
        finally:
            wb.close()

    async def write(
        self, records: AsyncIterator[Dict[str, Any]], *, columns: Sequence[str]
    ) -> AsyncIterator[bytes]:
        """Records -> workbook, for small in-memory sets (templates); an export streams pages
        through :meth:`write_pages` with the sheet columns its first pass found."""
        node_recs: List[Dict[str, Any]] = []
        edge_recs: List[Dict[str, Any]] = []
        async for rec in records:
            (edge_recs if rec.get("kind") == "edge" else node_recs).append(rec)
        sheets = {"node": sheet_columns(node_recs, columns), "edge": sheet_columns(edge_recs, columns)}
        async for chunk in self.write_pages(_one_page(node_recs + edge_recs), sheets=sheets):
            yield chunk

    async def write_pages(
        self, pages: AsyncIterator[List[Dict[str, Any]]], *, sheets: Dict[str, List[str]]
    ) -> AsyncIterator[bytes]:
        """Stream a workbook: node pages then edge pages, each row written into the zip as it
        comes. Memory stays flat whatever the size (openpyxl, even write-only, keeps every distinct
        string in memory for its shared-string table; here strings are written inline)."""
        sink = _Sink()
        book = zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED)
        await asyncio.to_thread(_write_static_parts, book)
        yield sink.take()
        writers = {"node": _SheetWriter(book, "xl/worksheets/sheet2.xml", sheets["node"]),
                   "edge": _SheetWriter(book, "xl/worksheets/sheet3.xml", sheets["edge"])}
        current = "node"
        await asyncio.to_thread(writers[current].open)
        async for page in pages:
            for kind in ("node", "edge"):
                rows = [r for r in page if (r.get("kind") == "edge") == (kind == "edge")]
                if not rows:
                    continue
                if kind != current:
                    if kind == "node":
                        raise ValueError("xlsx pages must hold every node before any edge")
                    await asyncio.to_thread(writers[current].close)
                    current = kind
                    await asyncio.to_thread(writers[current].open)
                await asyncio.to_thread(writers[current].write, rows)
                yield sink.take()
        await asyncio.to_thread(writers[current].close)
        if current == "node":                    # no edges: still a usable, empty Edges sheet
            await asyncio.to_thread(writers["edge"].open)
            await asyncio.to_thread(writers["edge"].close)
        await asyncio.to_thread(book.close)
        yield sink.take()


# --------------------------------------------------------------------------- #
def _find_sheet(wb, name: str):
    for ws in wb.worksheets:
        if str(ws.title or "").strip().lower() == name.lower():
            return ws
    return None


def _read_sheet(ws) -> List[Dict[str, Any]]:
    rows = ws.iter_rows(values_only=True)
    try:
        header_row = next(rows)
    except StopIteration:
        return []
    header = [str(h).strip() if h is not None else "" for h in header_row]
    out: List[Dict[str, Any]] = []
    for row in rows:
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue                             # blank row
        rec: Dict[str, Any] = {}
        for i, val in enumerate(row):
            if i < len(header) and header[i] and val is not None and str(val).strip() != "":
                rec[header[i]] = val             # empty cells dropped (PATCH semantics)
        if rec:
            out.append(parse_list_cells(rec))
    return out


def sheet_columns(records: List[Dict[str, Any]], columns: Sequence[str]) -> List[str]:
    """Per-sheet columns: the unified export order, minus ``kind`` (it's the sheet), filtered to
    what this kind actually uses (so edge-only columns don't clutter the Nodes sheet). An empty
    sheet falls back to all non-``kind`` columns so it's still a usable blank template."""
    present = {k for r in records for k in r}
    if not present:
        return [c for c in columns if c != "kind"]
    return [c for c in columns if c != "kind" and c in present]


#: Data rows a sheet holds: Excel's 1,048,576 rows, less the header.
EXCEL_MAX_ROWS = 1_048_575

_NS = ('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
       'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
# Characters XML 1.0 can't carry (C0 controls other than tab, newline and carriage return). They
# are dropped from cells: openpyxl, which reads the file back on import, refuses them too.
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
# Cell styles, indexes into styles.xml's cellXfs: plain, header, locked header, title.
_PLAIN, _HEADER, _LOCKED_HEADER, _TITLE = 0, 1, 2, 3


class _Sink:
    """A write-only, unseekable file for :class:`zipfile.ZipFile`; what it collects is taken as it
    is written (zipfile then writes each entry's sizes after its data)."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def write(self, data: bytes) -> int:
        self._buf += data
        return len(data)

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out


async def _one_page(records: List[Dict[str, Any]]) -> AsyncIterator[List[Dict[str, Any]]]:
    yield records


def _column_letter(index: int) -> str:
    """1 -> A, 27 -> AA."""
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def _text(value: str) -> str:
    return (_ILLEGAL.sub("", value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _cell_xml(ref: str, value: Any, style: int = _PLAIN) -> str:
    s = f' s="{style}"' if style else ""
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return f'<c r="{ref}"{s} t="b"><v>{int(value)}</v></c>'
    if isinstance(value, (int, float)) and math.isfinite(value):
        return f'<c r="{ref}"{s}><v>{value!r}</v></c>'
    text = value if isinstance(value, str) else cell_text(value)
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{_text(text)}</t></is></c>'


class _SheetWriter:
    """One worksheet's XML, written into the open zip a page of rows at a time."""

    def __init__(self, book: zipfile.ZipFile, name: str, columns: List[str]) -> None:
        self._book = book
        self._name = name
        self._cols = columns
        self._letters = [_column_letter(i) for i in range(1, len(columns) + 1)]
        self._rows = 0
        self._part = None

    def _put(self, xml: str) -> None:
        self._part.write(xml.encode("utf-8"))

    def open(self) -> None:
        self._part = self._book.open(self._name, "w")
        widths = "".join(f'<col min="{i}" max="{i}" width="{max(12, min(40, len(c) + 4))}" customWidth="1"/>'
                         for i, c in enumerate(self._cols, start=1))
        header = "".join(_cell_xml(f"{self._letters[i]}1", c, _LOCKED_HEADER if c in _LOCKED else _HEADER)
                         for i, c in enumerate(self._cols))
        self._put(f'{_XML}<worksheet {_NS}><sheetViews><sheetView workbookViewId="0">'
                  '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                  '<selection pane="bottomLeft"/></sheetView></sheetViews>'
                  f'<sheetFormatPr defaultRowHeight="15"/><cols>{widths}</cols>'
                  f'<sheetData><row r="1">{header}</row>')

    def write(self, records: List[Dict[str, Any]]) -> None:
        if self._rows + len(records) > EXCEL_MAX_ROWS:
            raise ValueError(f"an Excel sheet holds at most {EXCEL_MAX_ROWS:,} rows")
        out = []
        for rec in records:
            self._rows += 1
            n = self._rows + 1
            cells = "".join(_cell_xml(f"{letter}{n}", rec.get(c)) for letter, c in zip(self._letters, self._cols))
            out.append(f'<row r="{n}">{cells}</row>')
        self._put("".join(out))

    def close(self) -> None:
        tail = "</sheetData>"
        if "_op" in self._cols and self._rows:
            letter = self._letters[self._cols.index("_op")]
            tail += ('<dataValidations count="1"><dataValidation type="list" allowBlank="1" '
                     f'sqref="{letter}2:{letter}{self._rows + 1}"><formula1>"upsert,delete"</formula1>'
                     '</dataValidation></dataValidations>')
        self._put(tail + "</worksheet>")
        self._part.close()


_INSTRUCTION_LINES = [
    ("How to edit this workbook", _TITLE),
    ("", _PLAIN),
    ("• The Nodes and Edges sheets hold your data — one entity per row, and EACH PROPERTY IS ITS"
     " OWN COLUMN (prop.<name>). Edit a cell to change a value.", _PLAIN),
    ("• Greyed columns (entity_id, urn, baseVersion, source/target_entity_id) are the identity"
     " — leave them exactly as-is so your edits match the right item.", _PLAIN),
    ("• You only need the ROWS and COLUMNS you're changing. Deleting rows or columns from this"
     " file changes nothing — untouched entities and fields are left exactly as they are.", _PLAIN),
    ("• Add a NEW property = add a column named 'prop.<name>' (e.g. prop.owner) and fill only the"
     " rows it applies to. Add a new entity = a new row with entity_id/urn left blank.", _PLAIN),
    ("• DELETE a property value with the token \\N in its cell (or delete the whole row's entity"
     " by setting _op to 'delete').", _PLAIN),
    ("• Save as .xlsx and import — you'll review every change before anything is published.", _PLAIN),
]

_STYLES = (
    f'{_XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>'
    '<fills count="3"><fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8E8E8"/><bgColor indexed="64"/></patternFill></fill>'
    '</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')


def _write_static_parts(book: zipfile.ZipFile) -> None:
    """Everything but the two data sheets: the package plumbing, styles and the Instructions."""
    sheet_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    book.writestr("[Content_Types].xml", (
        f'{_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="{sheet_type}"/>'
                  for i in (1, 2, 3))
        + '</Types>'))
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    book.writestr("_rels/.rels", (
        f'{_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>'))
    names = (_INSTRUCTIONS, _NODE_SHEET, _EDGE_SHEET)
    book.writestr("xl/workbook.xml", (
        f'{_XML}<workbook {_NS}><bookViews><workbookView/></bookViews><sheets>'
        + "".join(f'<sheet name="{n}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(names, start=1))
        + '</sheets></workbook>'))
    book.writestr("xl/_rels/workbook.xml.rels", (
        f'{_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(f'<Relationship Id="rId{i}" Type="{rel}/worksheet" Target="worksheets/sheet{i}.xml"/>'
                  for i in (1, 2, 3))
        + f'<Relationship Id="rId4" Type="{rel}/styles" Target="styles.xml"/></Relationships>'))
    book.writestr("xl/styles.xml", _STYLES)
    rows = "".join(f'<row r="{n}">{_cell_xml(f"A{n}", text, style)}</row>'
                   for n, (text, style) in enumerate(_INSTRUCTION_LINES, start=1))
    book.writestr("xl/worksheets/sheet1.xml", (
        f'{_XML}<worksheet {_NS}><cols><col min="1" max="1" width="110" customWidth="1"/></cols>'
        f'<sheetData>{rows}</sheetData></worksheet>'))
