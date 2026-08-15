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
  frontend, `pip install -r requirements.txt` for the backend) and take
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

**Data file (`data.duckdb`) - required Vercel setting:** the backend serves
data by reading `backend/data.duckdb` (read-only, ~55MB, all 3 instruments
- see `backend/app/db.py`) at exactly the same local path it's always used;
no code change was needed for Vercel to find it. The file is committed via
**Git LFS** (see [Cloning this repo](#cloning-this-repo-git-lfs) above)
rather than as a plain ~55MB blob, to keep it out of normal git history.

This means **you must enable Git LFS in the Vercel project's Git settings**
before the first deploy (Project Settings -> Git -> Git LFS Support, or see
[Vercel's Git LFS docs](https://vercel.com/changelog/git-lfs-support)) - off
by default. With it off, Vercel checks out the same ~130-byte LFS pointer
file `git cat-file` shows locally instead of the real database, and every
`/api/*` request will fail with the same "run `python build_db.py`"
`RuntimeError` you'd see locally without the real file. With it on, Vercel
fetches the actual LFS object during the build and `backend/data.duckdb` is
the real file in the deployed bundle - free on both GitHub and Vercel at
this size. Toggling this setting requires a redeploy to take effect.

**Other things worth knowing:**

- **Services requires plan permissions.** If `services` isn't available on
  your Vercel plan/account, deploy as two separate Vercel projects instead:
  one rooted at `terminal` (frontend only - Vercel auto-detects Vite) and
  one rooted at `terminal/backend` (backend only - Vercel auto-detects
  FastAPI via `app/main.py`, no `vercel.json` needed there at all). In that
  case set `VITE_API_BASE` to the backend project's full URL instead of an
  empty string, and set `CORS_ALLOWED_ORIGINS` on the backend to the
  frontend project's URL, since the two are now genuinely cross-origin.
- **Bundle size.** `backend/requirements.txt` includes `pandas`, `numpy`,
  and `pytest` for the offline sync/build/test scripts - none of them are
  imported by the live API (`app/main.py` only uses `fastapi`, `pydantic`,
  and `duckdb`), but Vercel's Python runtime bundles whatever
  `requirements.txt` lists regardless of whether the deployed entrypoint
  actually imports it. Combined with `data.duckdb`, this may approach
  Vercel's standard 500MB function bundle limit. `vercel.json` already
  excludes `tests/`, `.pytest_cache/`, and `.venv/` from the bundle: if you
  hit the limit, splitting the sync-script dependencies into a separate
  `requirements-dev.txt` not read by Vercel is the next lever (not done
  here, since it wasn't asked for and `requirements.txt` is shared with
  local dev/tests).
- **`/api/symbols` and `/api/dataset` are the only backend routes** - both
  already prefixed with `/api/`, which is exactly what the `vercel.json`
  rewrite matches, so no route changes were needed.

## Stack notes

Vite + React 19 + TypeScript, `oxlint` for linting (see `.oxlintrc.json`).
