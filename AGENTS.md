# AGENTS.md — double-meh-bundler

> `double-meh-bundler` — the server side of the double-meh bundle protocol: a web-standard
> fetch-handler core that fans one bundled request out to backend services and returns all
> responses in a single compressed envelope. Zero runtime dependencies.

For project structure see [ARCHITECTURE.md](./ARCHITECTURE.md). The wire format and the
architectural decisions (fetch-handler core, duck-typed adapters, single package) are recorded in
the double-meh design record (`double-meh/dev-docs/design.md` § bundle) — this package implements
the server obligations of that spec.

## Commands

- **Install:** `npm install`
- **Test:** `npm test` (runs `tape6 --flags FO`); also `npm run test:bun`, `npm run test:deno`
- **TypeScript check (`.d.ts` contracts):** `npm run ts-check`
- **JS implementation check (`checkJs` over `src/`):** `npm run js-check`
- **Format check / fix:** `npm run lint` / `npm run lint:fix`

The full gate before shipping: `lint` + `ts-check` + `js-check` + tests on Node, Bun, and Deno.

## Code style

- **ESM** throughout (`"type": "module"`); no transpilation — code runs directly.
- **Prettier** (see `.prettierrc`): 100 char width, single quotes, no bracket spacing, no trailing
  commas, arrow parens "avoid".
- **No narrating comments.** Comments only for non-obvious decisions/constraints (the _why_),
  never restating the code (the _what_). No JSDoc in `.js` implementation files — types live in
  `.d.ts` sidecars referenced via `// @ts-self-types`.
- Prefer prefix `++i`/`--i` when the result is unused; `catch {` when the error is unused.

## Architecture rules

- **The core (`src/index.js`) stays platform-pure** — no `node:` imports; it must run in service
  workers and edge runtimes unchanged. Node-touching code lives in adapter subpaths
  (`src/node.js`).
- **Adapters are duck-typed shape converters** — never import a framework at runtime; framework
  types may appear in `.d.ts` sidecars only. Frameworks appear as devDependencies solely for
  conformance tests.
- **The allow-list (`isUrlAcceptable`) is the security boundary** — required, no default,
  never weaken it.
- **Wire format fidelity**: any change to part shapes must stay in lockstep with double-meh's
  client (`src/services/bundle.js` there) and the design record; the format is versioned (`v`).
- Zero runtime dependencies; `engines.node >= 18` is the code floor (web-standard
  `fetch`/`Request`/`Response` globals), not a support promise.

## Testing

- `tape-six`; tests in `tests/test-*.js`, runnable on Node/Bun/Deno.
- The core is tested with an **injected upstream `fetch`** — no server needed; the node adapter
  is tested over a real `node:http` server.
- Keep the error-path coverage: synthetic parts (allow-list refusal, upstream failure, timeout,
  non-GET), protocol guards (method/body/version/size), header stripping, base64 sort order.
