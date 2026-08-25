import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/ - defineConfig comes from 'vitest/config' (a
// drop-in superset of vite's own) rather than 'vite' so this one file also
// serves as vitest's config (the `test` block below), instead of needing a
// second vitest.config.ts that could drift out of sync with this one.
export default defineConfig({
  plugins: [react()],
  test: {
    // Pure-logic unit tests only (cache keys, race-condition coordination,
    // IndexedDB persistence) - no React Testing Library/jsdom component
    // rendering yet, so the default 'node' environment is enough.
    setupFiles: ["./src/test/setup.ts"],
  },
  server: {
    // Without this, a port-5173 conflict makes Vite silently fall back to
    // 5174/5175/... - the backend's CORS allow-list only permits exactly
    // http://localhost:5173 (see backend/app/main.py's CORS_ALLOWED_ORIGINS
    // default), so every API call then fails as a CORS error that the
    // frontend's error handling reports as "Backend unreachable"/"Backend
    // not reachable", even though the backend is running fine - the actual
    // symptom is just a silent port mismatch. Failing loudly here ("Port
    // 5173 is already in use") instead of drifting to a working-but-wrong
    // port turns a confusing runtime failure into an obvious startup one.
    strictPort: true,
  },
})
