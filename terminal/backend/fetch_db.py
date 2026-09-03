"""
data.deploy.duckdb -> real file, for Vercel deployments (see vercel.json's
backend installCommand) - not part of the deployed function's own
runtime, and not needed for local development, which never reads this
file at all (app/db.py only opens data.deploy.duckdb when the VERCEL env
var is set - see that module). data.deploy.duckdb is the small (~60MB),
30-symbol/1h-4h-1d-only, no-indexes artifact export_deploy_db.py derives
from the full local data.duckdb (499MB - see that script's own docstring
for why the full file can never be the thing Vercel actually bundles: it
alone exceeds Vercel's 225MB function-size limit).

Vercel's Git LFS Support project setting is supposed to fetch the real
tracked file during checkout, but Vercel has a long-standing, undocumented
gap where LFS-tracked files sometimes deploy as their small pointer-text
stand-in instead of the real content, even with LFS Support enabled (see
https://github.com/vercel/next.js/discussions/58352 - open since 2023,
still unresolved as of a 2025 follow-up) - confirmed happening on this
project's own deployment. Rather than depend on that, this script
detects the pointer, fetches the real object directly over plain HTTPS
from GitHub's public LFS media endpoint, and atomically replaces the
pointer with it - failing the build loudly if anything doesn't check
out, instead of silently deploying a broken database.

Safe to run unconditionally: if data.deploy.duckdb is already the real
file (what would happen if Vercel's own LFS checkout ever gets fixed),
this is a no-op.

Also unconditionally removes data.duckdb (the full, un-trimmed, 499MB
database) if present, regardless of whether it's still an LFS pointer or
Vercel's LFS Support already converted it to real content - confirmed
empirically that vercel.json's functions.excludeFiles does NOT reliably
keep it out of the packaged function on its own (a real deploy still
hit "Total bundle size (606.84 MB) exceeds the maximum function size
(225 MB)" - almost exactly data.duckdb's 499MB plus data.deploy.duckdb's
60MB plus ~50MB of Python deps - with data.duckdb already excluded in
vercel.json at the time). Deleting it here is deterministic regardless of
how Vercel's exclude-files mechanism behaves for this "services"-style
vercel.json shape; nothing at runtime ever needs data.duckdb in
production (app/db.py only opens it when VERCEL is unset).
"""

from __future__ import annotations

import hashlib
import os
import sys
import urllib.error
import urllib.request

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BACKEND_DIR, "data.deploy.duckdb")
REPO_RELATIVE_PATH = "terminal/backend/data.deploy.duckdb"
LFS_POINTER_SIGNATURE = b"version https://git-lfs.github.com/spec/v1"

# The full, un-trimmed database - never needed at runtime in production
# (see module docstring) and too large to risk leaving in the backend
# directory at package time under any circumstance.
FULL_DB_PATH = os.path.join(BACKEND_DIR, "data.duckdb")

# Only used if Vercel doesn't expose its System Environment Variables
# (Project Settings -> Environment Variables -> "Enable access to System
# Environment Variables" must be on) - matches this repo. Real deployment
# values are always preferred so a fork or rename doesn't silently fetch
# the wrong repo's data - see fetch_url() below.
FALLBACK_OWNER = "Sulpon"
FALLBACK_REPO = "Backtest"
FALLBACK_REF = "master"


def read_pointer(path: str) -> tuple[str, int] | None:
    """Returns (oid, size) parsed from the Git LFS pointer at `path`, or
    None if `path` doesn't exist or isn't a pointer (i.e. it's already
    the real database - never hardcoded, always read fresh from whatever
    Vercel's checkout actually produced for this exact commit)."""
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        head = f.read(200)
    if not head.startswith(LFS_POINTER_SIGNATURE):
        return None
    text = head.decode("utf-8", errors="replace")
    oid = size = None
    for line in text.splitlines():
        if line.startswith("oid sha256:"):
            oid = line.split(":", 1)[1].strip()
        elif line.startswith("size "):
            size = int(line.split(" ", 1)[1].strip())
    if oid is None or size is None:
        raise RuntimeError(f"{path} looks like a Git LFS pointer but couldn't be parsed (oid={oid!r}, size={size!r})")
    return oid, size


def fetch_url() -> str:
    owner = os.environ.get("VERCEL_GIT_REPO_OWNER") or FALLBACK_OWNER
    repo = os.environ.get("VERCEL_GIT_REPO_SLUG") or FALLBACK_REPO
    # The exact deployed commit, not a branch name, so the fetched
    # database always corresponds to the exact revision being deployed -
    # falls back to a branch ref only if Vercel doesn't expose the SHA.
    ref = os.environ.get("VERCEL_GIT_COMMIT_SHA") or FALLBACK_REF
    source = "Vercel system env vars" if os.environ.get("VERCEL_GIT_COMMIT_SHA") else f"fallback ({FALLBACK_OWNER}/{FALLBACK_REPO}@{FALLBACK_REF})"
    print(f"Using {owner}/{repo}@{ref} ({source})")
    return f"https://media.githubusercontent.com/media/{owner}/{repo}/{ref}/{REPO_RELATIVE_PATH}"


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def remove_full_db_if_present() -> None:
    """Deterministically keeps the 499MB data.duckdb out of the packaged
    function, independent of vercel.json's excludeFiles (which a real
    deploy proved doesn't reliably work for this - see module docstring).

    Gated on the VERCEL env var (same signal app/db.py uses) specifically
    so an accidental local run of this script - it's meant to be Vercel-
    build-only, but nothing stops a human from running it by hand - can
    never delete a developer's real, hours-to-rebuild local data.duckdb.
    Only ever destructive inside an actual Vercel build, where the file
    is disposable (re-derivable from the repo's LFS-tracked copy, and
    never read by production anyway - see FULL_DB_PATH's own comment)."""
    if not os.environ.get("VERCEL"):
        return
    if os.path.exists(FULL_DB_PATH):
        size = os.path.getsize(FULL_DB_PATH)
        os.remove(FULL_DB_PATH)
        print(f"Removed {FULL_DB_PATH} ({size} bytes) - not needed in production, kept out of the function bundle.")


def main() -> int:
    remove_full_db_if_present()

    pointer = read_pointer(DB_PATH)
    if pointer is None:
        if os.path.exists(DB_PATH):
            print(f"{DB_PATH} already looks like a real file, not a Git LFS pointer - nothing to fetch.")
            return 0
        print(f"ERROR: {DB_PATH} does not exist at all.", file=sys.stderr)
        return 1

    expected_oid, expected_size = pointer
    url = fetch_url()
    print(f"Found LFS pointer (sha256={expected_oid}, size={expected_size} bytes) - downloading real object from {url}")

    # Downloaded next to the real destination (same filesystem) so the
    # final move is a same-volume rename, not a copy - and named
    # distinctly so a failed/interrupted run never leaves something that
    # could be mistaken for data.duckdb itself.
    tmp_path = DB_PATH + ".download"
    try:
        try:
            urllib.request.urlretrieve(url, tmp_path)
        except urllib.error.URLError as e:
            print(f"ERROR: failed to download {url}: {e}", file=sys.stderr)
            return 1

        actual_size = os.path.getsize(tmp_path)
        if actual_size != expected_size:
            print(f"ERROR: downloaded {actual_size} bytes, expected {expected_size} bytes (from the LFS pointer). Refusing to deploy it.", file=sys.stderr)
            return 1

        actual_oid = sha256_of(tmp_path)
        if actual_oid != expected_oid:
            print(f"ERROR: downloaded file sha256={actual_oid}, expected {expected_oid} (from the LFS pointer). Refusing to deploy it.", file=sys.stderr)
            return 1

        # Only touches the real data.duckdb once everything above has
        # already verified the download byte-for-byte - os.replace is
        # atomic on both POSIX and Windows, so a build that dies mid-way
        # through this line still leaves either the old pointer or the
        # fully-verified real file at DB_PATH, never something partial.
        os.replace(tmp_path, DB_PATH)
        print(f"OK: replaced the LFS pointer with the verified {actual_size}-byte database.")
        return 0
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


if __name__ == "__main__":
    sys.exit(main())
