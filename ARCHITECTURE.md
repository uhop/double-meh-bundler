# Architecture

`double-meh-bundler` implements the server obligations of the double-meh bundle protocol (wire
format v1): parse a bundle request, fan out to upstream services, assemble one envelope.

## Project layout

```
double-meh-bundler
├── src/
│   ├── index.js          # createBundler(options) → web-standard fetch handler (platform-pure)
│   ├── node.js           # toNodeHandler(handler) — duck-typed (req, res, next?): node:http + Express
│   └── koa.js            # toKoaMiddleware(handler) — duck-typed ctx; terminal, route-mounted
├── tests/
│   ├── test-bundler.js   # Core over an injected upstream fetch (no server)
│   ├── test-node.js      # Adapter over a real node:http server (incl. gzip)
│   ├── test-koa.js       # Adapter over a real koa app (koa is a devDep for this test only)
│   └── test-conformance.js # The published double-meh client against this bundler, over real HTTP
└── examples/
    └── basic/            # Minimal node:http server wiring the bundler
```

## Core concepts

- **Fetch handler as the product**: `(Request) => Promise<Response>` runs on `Bun.serve`,
  `Deno.serve`, service workers, web-handler frameworks, and — via the `./node.js` subpath — bare
  `node:http` and Express. Adapters convert shapes; they never import frameworks.
- **Security**: `isUrlAcceptable` (required allow-list) + `resolveUrl` (public → internal mapping);
  auth/cookie propagate from the outer request only; `maxRequests` caps the fan-out;
  `partTimeout` turns hung upstreams into synthetic 504 parts.
- **Envelope rules**: outer response is `Cache-Control: no-store` (parts carry their own cache
  headers); wire-form and cookie-setting headers are stripped from parts; JSON bodies ride inline,
  text as strings, binary as base64 **sorted last** (compression-window locality); per-part
  failures become `synthetic: true` parts — one bad upstream never fails the bundle.
- **Injectable upstream `fetch`** — tests, mocks, and in-process serving need no network.
- **Two framings, one part shape**: a client asking for `…bundle+jsonl` gets a `{"v":1}` header line
  plus one part per line, flushed as upstreams complete. `v` stays 1 — the framing changed, not the
  parts — so the content type is the discriminator. Base64 parts still ship last; compression pays
  for the early flush (measured +25%/+57% bytes at 10/50 parts).
- **Hooks split by whether they may change the answer**: observers (`onBundleStart`,
  `onItemFinish`, `onBundleFinish`) are unawaited and their failures are swallowed —
  instrumentation can never fail a bundle;
  transforms (`processResult`, `processBundle`) are awaited, keep the original on a nullish return,
  and degrade to a synthetic 500 part / a 500 envelope when they throw.

## Module dependency graph

```
src/index.js              (no dependencies — platform-pure)
src/node.js               → node:stream, node:zlib
src/koa.js                → node:stream
```
