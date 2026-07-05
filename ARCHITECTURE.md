# Architecture

`double-meh-bundler` implements the server obligations of the double-meh bundle protocol (wire
format v1): parse a bundle request, fan out to upstream services, assemble one envelope.

## Project layout

```
double-meh-bundler
├── src/
│   ├── index.js          # createBundler(options) → web-standard fetch handler (platform-pure)
│   └── node.js           # toNodeHandler(handler) — duck-typed (req, res, next?): node:http + Express
├── tests/
│   ├── test-bundler.mjs  # Core over an injected upstream fetch (no server)
│   └── test-node.mjs     # Adapter over a real node:http server (incl. gzip)
└── examples/
    └── basic/            # Minimal node:http server wiring the bundler
```

## Core concepts

- **Fetch handler as the product**: `(Request) => Promise<Response>` runs on `Bun.serve`,
  `Deno.serve`, service workers, web-handler frameworks, and — via the `./node` subpath — bare
  `node:http` and Express. Adapters convert shapes; they never import frameworks.
- **Security**: `isUrlAcceptable` (required allow-list) + `resolveUrl` (public → internal mapping);
  auth/cookie propagate from the outer request only; `maxRequests` caps the fan-out;
  `partTimeout` turns hung upstreams into synthetic 504 parts.
- **Envelope rules**: outer response is `Cache-Control: no-store` (parts carry their own cache
  headers); wire-form and cookie-setting headers are stripped from parts; JSON bodies ride inline,
  text as strings, binary as base64 **sorted last** (compression-window locality); per-part
  failures become `synthetic: true` parts — one bad upstream never fails the bundle.
- **Injectable upstream `fetch`** — tests, mocks, and in-process serving need no network.

## Module dependency graph

```
src/index.js              (no dependencies — platform-pure)
src/node.js               → node:stream, node:zlib
```
