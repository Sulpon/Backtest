"""
On-disk cache for raw (still LZMA-compressed) .bi5 hour files - avoids
re-fetching the same hour from Dukascopy across incremental/resumable
runs. Caches the RAW bytes, not the decompressed/parsed form: decompression
is cheap and deterministic, so there's no benefit to a bigger on-disk
footprint for the decompressed form.

An hour with NO ticks (market closed, or simply nothing traded) returns
HTTP 404 from Dukascopy - that's cached too, as a zero-byte marker file,
so a rerun doesn't re-request an hour it already confirmed is empty.
"""
from __future__ import annotations

import os
from datetime import datetime

DEFAULT_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")


def cache_path(symbol: str, dt: datetime, cache_dir: str = DEFAULT_CACHE_DIR) -> str:
    return os.path.join(
        cache_dir, symbol, f"{dt.year:04d}", f"{dt.month:02d}", f"{dt.day:02d}", f"{dt.hour:02d}h_ticks.bi5"
    )


def read_cached(path: str) -> bytes | None:
    """None means "not cached yet" - distinct from b"" (cached, and the
    hour genuinely had no ticks), which IS a real cache hit."""
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def write_cache(path: str, raw: bytes) -> None:
    """Atomic write (temp file + os.replace) so a crash mid-write never
    leaves a corrupt/truncated cache entry that a later read would
    mistake for a genuine (possibly-empty) successful fetch."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = path + ".tmp"
    with open(tmp_path, "wb") as f:
        f.write(raw)
    os.replace(tmp_path, path)
