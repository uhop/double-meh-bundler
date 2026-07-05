# double-meh-bundler [![NPM version][npm-img]][npm-url]

[npm-img]: https://img.shields.io/npm/v/double-meh-bundler.svg
[npm-url]: https://npmjs.org/package/double-meh-bundler

The server side of the [double-meh](https://github.com/uhop/double-meh) bundle protocol: accepts one bundled request, fans out to your services on the backend network, and returns all responses in a single compressed envelope. Many small JSON responses sharing one compression window is the payoff — measured ~40–48% fewer bytes on bursts of small responses — plus aggregation across origins that HTTP/2 multiplexing cannot do.

The core is a **web-standard fetch handler** — usable directly with `Bun.serve`, `Deno.serve`, service workers, and web-handler frameworks; adapters for callback servers are thin subpaths with **zero framework dependencies**.

Docs: [browse the wiki](https://github.com/uhop/double-meh-bundler/wiki) &middot; [search it](https://uhop.github.io/wiki-search/app/?wiki=uhop/double-meh-bundler).

## Install

```bash
npm i double-meh-bundler
```

## Usage

```js
import {createBundler} from 'double-meh-bundler';

const bundler = createBundler({
  // the allow-list is the security boundary — required, no default
  isUrlAcceptable: url => url.startsWith('/api/'),
  resolveUrl: url => new URL(url, 'http://api.internal:8080').href
});

Bun.serve({fetch: bundler}); // or Deno.serve(bundler), or any Request → Response host
```

Node and Express are one adapter away:

```js
import {createServer} from 'node:http';
import {createBundler} from 'double-meh-bundler';
import {toNodeHandler} from 'double-meh-bundler/node.js';

createServer(toNodeHandler(createBundler({isUrlAcceptable}))).listen(3000);
// Express: app.put('/bundle', toNodeHandler(createBundler({isUrlAcceptable})));
// Koa:     import {toKoaMiddleware} from 'double-meh-bundler/koa.js';
//          app.use(route.put('/bundle', toKoaMiddleware(createBundler({isUrlAcceptable}))));
```

The client side is [double-meh](https://github.com/uhop/double-meh)'s `io.bundle` — transparent batching with per-URL caching, ETag/304 revalidation, and error granularity intact. The wire format (v1) is deliberately library-independent: `application/vnd.double-meh.bundle{-request}+json` envelopes, id-correlated parts echoing their URLs, per-part conditional headers, outer-request auth/cookie propagation, synthetic parts for bundler-side failures, and binary parts riding base64 sorted last to preserve compression locality.

Zero runtime dependencies. ESM. Node ≥ 18 (the code floor: web-standard `fetch`/`Request`/`Response` globals), Bun, Deno; the core also runs wherever a fetch handler does.

## Release notes

- 1.0.0 — _(unreleased)_ The initial release: the fetch-handler core, the `node:http`/Express adapter (gzip built in), the Koa adapter. Details in the [wiki release notes](https://github.com/uhop/double-meh-bundler/wiki/Release-notes).

License: BSD-3-Clause.
