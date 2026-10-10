# Hive

Electron app that runs Claude Code sessions in tabs and relays "Claude needs you" events to phone channels (plugins).
Design and verified decisions: docs/DESIGN.md. Plugin API: docs/PLUGINS.md.

## Commands
- `npm install` at the repo root (npm workspaces; no postinstall rebuild — node-pty ships N-API prebuilds for win/mac; electron-builder has `npmRebuild: false`).
- Windows installer: `cd apps/desktop && npx electron-vite build && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis` → release/<ver>/. The packaged exe honours the same HIVE_SMOKE env vars.
- Icons: edit build/icon.svg, then `npx electron scripts/render-icons.cjs` (writes build/icon.png and resources/*.png).
- `npm run dev` / `npm run build` / `npm test` (vitest, pure logic in apps/desktop/src/core) / `npm run typecheck`.
- End-to-end smoke test against the real `claude` CLI (uses a little Claude usage):
  `HIVE_HOME=<tmp dir> HIVE_SMOKE=1 HIVE_SMOKE_CWD=<trusted folder> npx electron .` from apps/desktop after `npx electron-vite build`.
  Add `HIVE_SMOKE_REMOTE=1` with a mock channel plugin in `<tmp>/plugins` to test the phone loop. Writes smoke.log/smoke.png to `<tmp>/logs`.
- `HIVE_SCREENSHOTS=1` captures the main screens to `$HIVE_HOME/logs`.

## Layout
- `apps/desktop/src/core` — pure, unit-tested logic (state machine, router, reply parser, hook settings, transcript parsing). No Electron imports.
- `apps/desktop/src/main` — Electron main: SessionManager (node-pty), HookServer (http hooks), PluginHost (utilityProcess per plugin, runtime in pluginRuntime.ts), HistoryIndex (worker + node:sqlite FTS5), presence.
- `apps/desktop/src/renderer` — React + xterm.js UI. `window.hive` API is defined in src/shared/api.ts and implemented in src/preload.
- `plugins/` — built-in channel plugins (plain CommonJS, no build step). `relay/whatsapp-relay` — optional Cloudflare Worker.

## Conventions
- Never modify the user's ~/.claude settings; everything goes through `--settings` per session.
- Hive data lives in ~/.hive (override with HIVE_HOME). Secrets go through SettingsStore.setSecret (OS keychain).
- Keep core/ free of Electron so it stays testable; add a vitest case for routing/parsing changes.
