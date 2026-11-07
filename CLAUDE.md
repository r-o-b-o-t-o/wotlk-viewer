# wotlk-3d-viewer

WebGL viewer for World of Warcraft 3.3.5a models, built on three.js. Parses M2/SKIN/ANIM/BLP/DBC straight from an
extracted client; the end goal is rendering player characters.

## Layout

- `packages/core` — parsers, renderer, character and creature builders. UI-framework agnostic.
- `packages/server` — Node middleware serving client files and an AzerothCore character API, plus
  the MPQ reader and `extract` CLI that build the extracted client in `src/mpq`.
- `packages/solid`, `packages/react` — JSX bindings over core.
- `apps/demo` — SolidJS demo.

## Standing instructions

- TypeScript only. Core stays framework agnostic; SolidJS is the primary binding, React follows it.
- Keep the renderer generic while that stays cheap; when generalizing gets tedious, cut the corner
  in favour of player characters.
- Write straightforward code and skip minor edge cases; record notable ones under "Known
  limitations" in `README.md` for the user to triage.
- Comments state the point in one line; never restate the code.
- Conventional Commits, concise subjects, one logical change per commit. Commit as you go.
- Relative imports carry `.js` extensions so the built ESM loads in Node.
- `npm run format` before committing (Prettier config in `.prettierrc`).
- No machine-specific paths or credentials in committed files; they belong in `.env`.

## Local data

All game data is local; nothing calls an online service. Every package reads one root `.env`
(gitignored) — copy `.env.example` to create it. Vite and Vitest load it through `loadEnv`, the
server CLI through `--env-file-if-exists`.

- `WOW_CLIENT_DIR` — extracted client, laid out as the client is: `Data` with the base archives'
  contents and `Data/<locale>` inside it for the locale ones (that is where `DBFilesClient` lives).
  File name case is inconsistent, so resolve paths case-insensitively.
  `npm run extract -w packages/server` builds it from the MPQs in the client's own search order.
  An extract built in archive-file order serves pre-patch copies of ~1% of files, which reads as a
  renderer bug: check a file against the archives before suspecting the renderer.
- `WOW_DB_URL` — AzerothCore characters database; optional, the demo runs without it.
- `AZEROTHCORE_SRC`, `MYSQL_CLI` — pointers no code reads. The AzerothCore source explains the
  schema; do not mirror its data layout, the library takes whatever shape a REST API returns.

## Format reference

wowdev.wiki documents the file formats. `WebFetch` gets a 403 there; `curl -A` with a browser
user agent works.

- https://wowdev.wiki/M2 — header layout, particle emitters, the camera block, and the flag tables
- https://wowdev.wiki/M2/Rendering — blend modes, and the combiners with their exact per-op formulas
- https://wowdev.wiki/DB/ParticleColor — how a display's `ParticleColorID` recolours emitters
- https://wowdev.wiki/DB/ItemDisplayInfo — column list
- https://wowdev.wiki/BLS — compiled shader container; needs a decompiler, no use found for it yet

Look a flag or field up rather than guessing: several names here started as guesses and were wrong.
Then check the reading against the whole client before building on it — a tally over every model
catches a misreading that one model will happily agree with.

## Working on it

`npm run dev` (Vite, port 5173) serves the demo plus `/data` and `/api`.

- `npm run typecheck`, `npm test`, `npm run build`. Tests read the real client and skip without it.
- Verify rendering changes in the browser, not just in the typechecker. The demo exposes
  `window.viewer` for inspecting the scene.
- Vite's dependency cache goes stale after core edits and reports phantom missing exports:
  `rm -rf node_modules/.vite`, then restart.
