"""Object store in an S3-compatible bucket: optional, used only with ``OBJECT_STORE_BACKEND=s3``.

Amazon S3, MinIO, or Google Cloud Storage through its XML API's S3 interoperability (HMAC keys and
``https://storage.googleapis.com``), behind the same :class:`ObjectStore` Protocol as the database
and LocalFs stores, so no caller changes. boto3 is not in the default image
(``requirements-s3.txt``): it is imported only when this store is built, so the default backends
never load it.

boto3 blocks, so every call runs in a worker thread (``asyncio.to_thread``) and the event loop never
waits on the bucket. Only what S3 and GCS's interoperability API both support is used: one delete
per object (GCS has no multi-object delete), ListObjects (v1), and checksums only where an operation
requires one (botocore otherwise sends CRC32 checksums by default, which GCS refuses).
"""
from __future__ import annotations

import asyncio
import contextlib
import functools
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator, Dict, List, Optional

from .object_store import _READ_CHUNK, ObjectStat, UploadTarget, _under

#: A put of up to this is one PutObject (a package part sent through the API is exactly this big);
#: a larger one goes up in parts of just over it, so memory stays at about one part whatever the
#: object's size. Multipart takes parts of at least 5 MiB and at most 10,000 of them, so this
#: reaches 160 GiB, beyond the 50 GiB export cap.
_PART_BYTES = 16 * 1024 * 1024
#: A presigned part upload is good for as long as an upload is kept (a day). A part changed after
#: the upload's check fails its import's checksum rather than importing as something else. A URL
#: signed with temporary credentials (a role: IRSA, an instance profile, STS) stops working when
#: they expire, whichever comes first; the browser then asks for freshly signed ones.
_UPLOAD_URL_SECONDS = 24 * 60 * 60
#: A presigned download is good for an hour (or until temporary credentials expire): the browser
#: follows it at once, and it grants the export to whoever holds it.
_DOWNLOAD_URL_SECONDS = 60 * 60


def _status(exc) -> Optional[int]:
    """The HTTP status of a botocore ``ClientError``."""
    return exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


class S3ObjectStore:
    """Objects in ``bucket`` under ``prefix``, which must be the store's own: the sweep deletes
    whatever under it is old."""

    def __init__(self, bucket: str, *, prefix: str = "", endpoint_url: Optional[str] = None,
                 region: Optional[str] = None, addressing: str = "auto", presign: bool = False) -> None:
        try:
            import boto3.session
            import botocore.exceptions
            from botocore.config import Config
        except ImportError as exc:
            raise RuntimeError(
                "OBJECT_STORE_BACKEND=s3 needs boto3, which the default image leaves out: "
                "pip install -r backend/requirements-s3.txt") from exc
        self._errors = botocore.exceptions
        self._bucket = bucket
        self._prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self._presign = presign
        # A session of its own: boto3's default one is process-wide state, and not thread-safe.
        session = boto3.session.Session()
        self._client = session.client("s3", endpoint_url=endpoint_url, region_name=region, config=Config(
            signature_version="s3v4",
            retries={"mode": "standard", "max_attempts": 5},
            s3={"addressing_style": addressing},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            # One connection per thread of the default executor, which runs every call.
            max_pool_connections=32,
        ))

    def _key(self, key: str) -> str:
        """``key`` in the bucket: under the prefix, which no key may climb out of."""
        if key.startswith("/") or any(part in (".", "..") for part in key.split("/")):
            raise ValueError(f"key escapes the store's prefix: {key!r}")
        return self._prefix + key

    async def _call(self, method: str, **params):
        return await asyncio.to_thread(getattr(self._client, method), Bucket=self._bucket, **params)

    async def put_stream(self, key: str, chunks: AsyncIterator[bytes]) -> ObjectStat:
        """Write ``key``. Readers get the previous object, whole, until the put completes; a put
        that fails before its last call leaves no part of itself behind. One cancelled DURING that
        call (the PutObject, or the multipart upload's completion) may still land: the call goes on
        in its thread.

        The chunks are held as they come and joined once per part, the only copy: a 16 MiB part
        holds about twice that, briefly, then one part's worth while it is sent."""
        full = self._key(key)
        held: List[bytes] = []
        size = held_bytes = 0
        upload_id, creating, parts = None, None, []
        try:
            async for chunk in chunks:
                held.append(chunk)
                held_bytes += len(chunk)
                size += len(chunk)
                if held_bytes > _PART_BYTES:
                    if upload_id is None:
                        # Shielded: cancelled meanwhile, the upload is still made, so its id is
                        # awaited below to abort it.
                        creating = asyncio.ensure_future(self._call("create_multipart_upload", Key=full))
                        upload_id = (await asyncio.shield(creating))["UploadId"]
                    body, held, held_bytes = b"".join(held), [], 0
                    parts.append(await self._put_part(full, upload_id, len(parts) + 1, body))
                    del body
            body, held = b"".join(held), []
            if upload_id is None:
                await self._call("put_object", Key=full, Body=body)
            else:
                if body:
                    parts.append(await self._put_part(full, upload_id, len(parts) + 1, body))
                await self._call("complete_multipart_upload", Key=full, UploadId=upload_id,
                                 MultipartUpload={"Parts": parts})
        except BaseException:
            if upload_id is None and creating is not None:
                with contextlib.suppress(Exception):
                    upload_id = (await asyncio.shield(creating))["UploadId"]
            if upload_id is not None:
                # Shielded, so a cancelled put still frees the parts it stored. Best effort: the
                # bucket's AbortIncompleteMultipartUpload lifecycle rule reclaims what this misses.
                with contextlib.suppress(Exception):
                    await asyncio.shield(self._call("abort_multipart_upload", Key=full, UploadId=upload_id))
            raise
        return ObjectStat(key=key, size=size, exists=True)

    async def _put_part(self, full: str, upload_id: str, number: int, body: bytes) -> Dict[str, object]:
        sent = await self._call("upload_part", Key=full, UploadId=upload_id, PartNumber=number, Body=body)
        return {"PartNumber": number, "ETag": sent["ETag"]}

    async def open_stream(
        self, key: str, *, chunk_size: int = _READ_CHUNK, start: int = 0
    ) -> AsyncIterator[bytes]:
        params = {"Key": self._key(key)}
        if start:
            params["Range"] = f"bytes={start}-"
        try:
            body = (await self._call("get_object", **params))["Body"]
        except self._errors.ClientError as exc:
            if _status(exc) == 416:         # starts at or past the end: nothing, as the other stores
                return
            if _status(exc) == 404:
                raise FileNotFoundError(key) from exc
            raise
        try:
            while chunk := await asyncio.to_thread(body.read, chunk_size):
                yield chunk
        finally:
            await asyncio.to_thread(body.close)

    async def stat(self, key: str) -> ObjectStat:
        try:
            head = await self._call("head_object", Key=self._key(key))
        except self._errors.ClientError as exc:
            if _status(exc) != 404:
                raise
            return ObjectStat(key=key, size=0, exists=False)
        return ObjectStat(key=key, size=head["ContentLength"], exists=True)

    def _delete(self, full: str) -> None:
        try:
            self._client.delete_object(Bucket=self._bucket, Key=full)
        except self._errors.ClientError as exc:
            if _status(exc) != 404:         # GCS answers 404 for a key already gone, S3 204
                raise

    def _objects(self, full_prefix: str):
        """Every object under ``full_prefix``, listed a page (1,000) at a time."""
        for page in self._client.get_paginator("list_objects").paginate(Bucket=self._bucket, Prefix=full_prefix):
            yield from page.get("Contents", ())

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._delete, self._key(key))

    async def delete_prefix(self, prefix: str) -> None:
        """Delete every object under ``prefix/`` (a job's artifacts), as LocalFs removes that
        directory."""
        def _delete_all() -> None:
            for obj in self._objects(self._key(prefix.rstrip("/")) + "/"):
                self._delete(obj["Key"])

        await asyncio.to_thread(_delete_all)

    def upload_target(self, key: str, *, size: Optional[int] = None) -> UploadTarget:
        """With ``OBJECT_STORE_S3_PRESIGN=1``, a presigned PUT the client sends ``key`` to, straight
        to the bucket; ``size`` signs its length, so the URL takes exactly that many bytes and no
        more. Otherwise ``backend``: through the API, as with the other stores."""
        full = self._key(key)
        if not self._presign:
            return UploadTarget(key=key, mode="backend", url=None)
        params = {"Bucket": self._bucket, "Key": full}
        if size is not None:
            params["ContentLength"] = size
        return UploadTarget(key=key, mode="presigned", url=self._client.generate_presigned_url(
            "put_object", Params=params, ExpiresIn=_UPLOAD_URL_SECONDS))

    def download_url(self, key: str, *, filename: str) -> Optional[str]:
        """With ``OBJECT_STORE_S3_PRESIGN=1``, a presigned GET of ``key`` that saves as ``filename``:
        the download, its ranges and its resumes go from the bucket, not through an API worker.
        ``None`` otherwise."""
        if not self._presign:
            return None
        return self._client.generate_presigned_url("get_object", Params={
            "Bucket": self._bucket, "Key": self._key(key),
            "ResponseContentDisposition": f'attachment; filename="{filename}"',
        }, ExpiresIn=_DOWNLOAD_URL_SECONDS)

    async def prune_older_than(self, prefix: str, seconds: float, *, keep_prefixes=()) -> int:
        """Delete each entry directly under ``prefix`` (an object, or a folder of them such as an
        upload) last written more than ``seconds`` ago, but none of ``keep_prefixes`` (inputs a job
        may still read). A folder's age is its newest object's, as a directory's mtime is. Returns
        how many entries went."""
        under = prefix.rstrip("/") + "/"
        keep = {p.rstrip("/") for p in keep_prefixes}
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=seconds)
        full = self._key(under)

        def _prune() -> int:
            entries: Dict[str, List[str]] = {}
            newest: Dict[str, datetime] = {}
            for obj in self._objects(full):
                name = obj["Key"][len(full):].split("/", 1)[0]
                entries.setdefault(name, []).append(obj["Key"])
                newest[name] = max(newest.get(name, obj["LastModified"]), obj["LastModified"])
            gone = 0
            for name, keys in entries.items():
                if under + name in keep or newest[name] >= cutoff:
                    continue
                for k in keys:
                    self._delete(k)
                gone += 1
            return gone

        return await asyncio.to_thread(_prune)

    async def sweep(self, *, older_than_hours: float, keep_prefixes=()) -> int:
        """Delete every object under the prefix written more than ``older_than_hours`` ago, but none
        under ``keep_prefixes`` (inputs a job may still read, however old). Returns how many went."""
        keep = _under(keep_prefixes)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)

        def _sweep() -> int:
            gone = 0
            for obj in self._objects(self._prefix):
                if obj["LastModified"] < cutoff and not obj["Key"][len(self._prefix):].startswith(keep):
                    self._delete(obj["Key"])
                    gone += 1
            return gone

        return await asyncio.to_thread(_sweep)


@functools.lru_cache(maxsize=None)
def shared(**settings) -> S3ObjectStore:
    """One store per configuration, built once: a boto3 client is costly to build (it loads the
    service's model and resolves credentials) and holds the connection pool its calls share."""
    return S3ObjectStore(**settings)
