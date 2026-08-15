# Terminal

React/TypeScript charting terminal (Vite) with a FastAPI + DuckDB backend
(`backend/`). See `backend/README.md` for the backend's own setup, schema,
and data-rebuild instructions.

## Local development

```
npm install
npm run dev          # frontend, http://localhost:5173
```

In a second terminal, from `backend/` (first-time setup in `backend/README.md`):

```
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000 --reload
```

The frontend defaults to `VITE_API_BASE=http://localhost:8000` (see
`.env.example`) - no `.env.local` needed unless you're running the backend
on a different port.

### Cloning this repo (Git LFS)

`backend/data.duckdb` is tracked with [Git LFS](https://git-lfs.com/), not
committed as a normal blob (see `.gitattributes` at the repo root) - keeps
it out of plain git's object history while still being exactly the file
`db.py` reads. A plain `git clone` still works, but you need Git LFS
installed once per machine for the real file to come down instead of a
small pointer:

```
git lfs install          # one-time per machine
git clone <repo-url>
# or, if you already cloned before installing Git LFS:
git lfs pull
```

Without this, `backend/data.duckdb` will just be a ~130-byte pointer file
and `db.py` will fail to open it as a database.

## Deploying to Vercel

This repo deploys as **one Vercel project** using Vercel's
[Services](https://vercel.com/docs/services) feature (`vercel.json`'s
`services` key): the Vite frontend and the FastAPI backend build and deploy
together, sharing one domain, with `/api/*` routed internally to the
backend and everything else served as the static frontend build.

**Project setup on Vercel:**

- **Root Directory**: `terminal` (this directory - the one containing this
  README, `package.json`, and `vercel.json`)
- Build command / output directory: not set in the dashboard - both are
  defined per-service in `vercel.json` (`npm run build` / `dist` for the
  frontend; the backend's `installCommand` runs `pip install -r
  requirements.txt` then `python fetch_db.py` - see below) and take
  precedence.
- Everything else (routing `/api/*` to the backend, the Python entrypoint
  `app.main:app`) is already configured in `vercel.json` - no dashboard
  routing config needed.

**Environment variables to set in the Vercel dashboard:**

| Variable | Where | Value |
| --- | --- | --- |
| `VITE_API_BASE` | Project (used at build time) | Empty string. With frontend and backend on the same domain, the app should call relative paths like `/api/symbols`, not an absolute URL. |
| `CORS_ALLOWED_ORIGINS` | Backend service (optional) | Leave unset. Only needed if the backend is ever split into its own project on a different origin (see below) - same-origin requests never hit CORS at all. |
| `MARKET_DATA_PROVIDER`, `FXCM_ACCESS_TOKEN` / `OANDA_API_KEY` etc. | Backend service (optional) | Only needed if you run `sync_market_data.py` in a context that has these set - the live API (`/api/symbols`, `/api/dataset`) never calls a market-data provider at request time, it only reads `data.duckdb`. Never set these as `VITE_`-prefixed variables - that would ship them to the browser. |

**Data file (`data.duckdb`) - how it actually gets to the deployed backend:**
the backend serves data by reading `backend/data.duckdb` (read-only, ~55MB,
all 3 instruments - see `backend/app/db.py`) at exactly the same local path
it's always used; `db.py` was never changed for Vercel. The file is
committed via **Git LFS** (see [Cloning this repo](#cloning-this-repo-git-lfs)
above), not as a plain ~55MB blob, to keep it out of normal git history.

Enabling Git LFS Support in the Vercel project's Git settings **is not
enough on its own** - confirmed on this project's own deployment, with LFS
Support already on, Vercel's checkout still handed the Python function the
raw ~130-byte pointer file instead of the real database (`duckdb.connect()`
then fails with `IO Error: ... exists, but it is not a valid DuckDB
database file!`). This isn't a one-off misconfiguration; it's a long-standing,
undocumented gap in how Vercel's build checkout applies the LFS smudge
filter, reported against Vercel going back to 2023 with no official fix
([vercel/next.js#58352](https://github.com/vercel/next.js/discussions/58352)).
Leave LFS Support enabled (harmless, and it's what makes local clones and
`git lfs pull` work), but don't rely on it alone for the deployed database.

**`backend/fetch_db.py`** works around this: `vercel.json`'s backend
`installCommand` runs it right after `pip install`. It reads whatever
Vercel's checkout put at `data.duckdb` - if that's already the real file
(e.g. if Vercel's LFS handling is ever fixed), it's a no-op. If it's a Git
LFS pointer, it parses the pointer's own `oid`/`size` fields (never
hardcoded, so this keeps working if `data.duckdb` is ever rebuilt and
recommitted), downloads the real object from GitHub's public LFS media
endpoint (`https://media.githubusercontent.com/media/<owner>/<repo>/<ref>/terminal/backend/data.duckdb`
- verified serving the real file directly over plain HTTPS, no LFS protocol
needed), and only after checking the download's exact byte size **and**
SHA-256 against what the pointer declared does it atomically replace the
pointer with it. Any mismatch, or a failed download, **fails the build**
and removes the partial download - it never leaves a corrupt or
partially-written `data.duckdb` behind.

`<owner>`/`<repo>`/`<ref>` come from Vercel's `VERCEL_GIT_REPO_OWNER` /
`VERCEL_GIT_REPO_SLUG` / `VERCEL_GIT_COMMIT_SHA` build-time environment
variables when available (`ref` deliberately uses the exact deployed
commit SHA, not a branch name, so the fetched database always matches the
exact revision being deployed) - these require "Enable access to System
Environment Variables" under Project Settings -> Environment Variables. If
that's off, or building outside Vercel, the script falls back to hardcoded
`Sulpon`/`Backtest`/`master`, clearly logged either way.

`fetch_db.py` itself never ships in the deployed function - it's build-time
only, listed in `vercel.json`'s `excludeFiles` alongside the other
dev/offline scripts.

**Other things worth knowing:**

- **Services requires plan permissions.** If `services` isn't available on
  your Vercel plan/account, deploy as two separate Vercel projects instead:
  one rooted at `terminal` (frontend only - Vercel auto-detects Vite) and
  one rooted at `terminal/backend` (backend only - Vercel auto-detects
  FastAPI via `app/main.py`, no `vercel.json` needed there at all). In that
  case set `VITE_API_BASE` to the backend project's full URL instead of an
  empty string, and set `CORS_ALLOWED_ORIGINS` on the backend to the
  frontend project's URL, since the two are now genuinely cross-origin.
- **Bundle size.** A first deploy attempt actually hit this: with
  `pandas`/`numpy`/`pytest`/`uvicorn[standard]`/`httpx` all in
  `requirements.txt`, the bundle measured **247.53MB against this
  project's 225MB function size limit** (with only the ~130-byte Git LFS
  pointer standing in for `data.duckdb` at the time - the real 55MB file
  would have pushed it further over). None of those packages are imported
  by the live API (`app/main.py` only uses `fastapi`, `pydantic`, and
  `duckdb`) - they're for the offline sync/build scripts and local dev
  server. Fixed by splitting them into `backend/requirements-dev.txt`
  (installed locally alongside `requirements.txt`, never read by Vercel).
  `vercel.json`'s backend `installCommand` is back (needed to chain
  `fetch_db.py` after `pip install` - see above), which forgoes some of
  Vercel's automatic bundle-size optimization for a custom install command,
  but the dependency trim alone leaves enough margin that this shouldn't
  matter: measured real (uncompressed) package sizes put the trimmed
  dependency set at ~68MB (down from ~194MB for the original 8 packages),
  so estimated final size is ~247.53MB − ~126MB (removed packages) +
  ~52.76MB (real `data.duckdb` instead of the pointer) ≈ **174MB**, against
  the 225MB limit. `vercel.json` also excludes `tests/`,
  `.pytest_cache/`, `.venv/`, and the offline scripts/config files from the
  bundle, though those are small - the dependency split is what actually
  mattered.
- **`/api/symbols` and `/api/dataset` are the only backend routes** - both
  already prefixed with `/api/`, which is exactly what the `vercel.json`
  rewrite matches, so no route changes were needed.

## Stack notes

Vite + React 19 + TypeScript, `oxlint` for linting (see `.oxlintrc.json`).
