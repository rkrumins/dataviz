"""Large JSON responses, encoded off the event loop.

FastAPI turns a returned dict into JSON on the event loop: ``jsonable_encoder`` walks it in
Python, then ``json.dumps`` writes it. A view's design runs to tens of megabytes at the limits
(250,000 placements: about 1.5 s, then 0.4 s), and meanwhile every other request this worker is
serving waits. Routes that return designs hand back the same response, built in a worker thread.
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse


async def json_response(payload: Any) -> JSONResponse:
    """``payload`` exactly as FastAPI would have sent it, encoded in a worker thread."""
    return await asyncio.to_thread(lambda: JSONResponse(jsonable_encoder(payload)))
