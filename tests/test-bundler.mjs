import test from 'tape-six';

import {createBundler, BUNDLE_MIME} from '../src/index.js';

const ORIGIN = 'https://api.internal';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {'content-type': 'application/json', ...(init.headers || {})}
  });

const upstreamOf = routes => request => {
  const url = new URL(request.url);
  const route = routes[url.pathname];
  return route ? route(request) : new Response('not found', {status: 404});
};

const bundleRequest = (parts, init = {}) =>
  new Request('https://edge.example.com/bundle', {
    method: 'PUT',
    headers: {
      'content-type': 'application/vnd.double-meh.bundle-request+json',
      ...(init.headers || {})
    },
    body: JSON.stringify({v: 1, parts, ...(init.doc || {})})
  });

const accept = () => true;

test('bundler: happy path — inline JSON parts, ids and urls echoed', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({
      '/a': () => json({name: 'a'}, {headers: {etag: '"a1"', vary: 'Accept'}}),
      '/b': () => json({name: 'b'})
    })
  });
  const response = await bundler(
    bundleRequest([
      {id: 'x', url: ORIGIN + '/a', method: 'GET', headers: {accept: 'application/json'}},
      {id: 'y', url: ORIGIN + '/b'}
    ])
  );
  t.equal(response.status, 200, 'ok');
  t.ok(response.headers.get('content-type').startsWith(BUNDLE_MIME), 'bundle MIME');
  t.equal(response.headers.get('cache-control'), 'no-store', 'the envelope is never cacheable');
  const doc = await response.json();
  t.equal(doc.v, 1, 'v1');
  t.deepEqual(
    doc.parts.map(part => [part.id, part.url, part.status]),
    [
      ['x', ORIGIN + '/a', 200],
      ['y', ORIGIN + '/b', 200]
    ],
    'ids, urls, statuses echoed'
  );
  t.deepEqual(doc.parts[0].body, {name: 'a'}, 'JSON body rides inline');
  t.equal(doc.parts[0].headers.etag, '"a1"', 'cache-relevant part headers ride');
  t.equal(doc.parts[0].headers.vary, 'Accept', 'vary rides per part');
});

test('bundler: the allow-list is the boundary', async t => {
  const bundler = createBundler({
    isUrlAcceptable: url => !url.includes('secret'),
    fetch: upstreamOf({'/ok': () => json({fine: true})})
  });
  const doc = await (
    await bundler(
      bundleRequest([
        {id: '1', url: ORIGIN + '/ok'},
        {id: '2', url: ORIGIN + '/secret'}
      ])
    )
  ).json();
  t.equal(doc.parts[0].status, 200, 'acceptable part served');
  t.equal(doc.parts[1].status, 403, 'unacceptable part refused');
  t.ok(doc.parts[1].synthetic, 'as a synthetic part');
});

test('bundler: resolveUrl maps public to internal', async t => {
  const seen = [];
  const bundler = createBundler({
    isUrlAcceptable: accept,
    resolveUrl: url => url.replace('/public/', '/internal/'),
    fetch: request => {
      seen.push(new URL(request.url).pathname);
      return json({ok: true});
    }
  });
  await bundler(bundleRequest([{id: '1', url: ORIGIN + '/public/x'}]));
  t.deepEqual(seen, ['/internal/x'], 'the sub-request hit the internal URL');
});

test('bundler: outer auth/cookie propagate; part conditionals ride', async t => {
  let seen;
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: request => {
      seen = request;
      return json({ok: true});
    }
  });
  await bundler(
    bundleRequest([{id: '1', url: ORIGIN + '/a', headers: {'If-None-Match': '"v7"'}}], {
      headers: {authorization: 'Bearer token-123', cookie: 'sid=abc'}
    })
  );
  t.equal(seen.headers.get('authorization'), 'Bearer token-123', 'authorization propagated');
  t.equal(seen.headers.get('cookie'), 'sid=abc', 'cookie propagated');
  t.equal(seen.headers.get('if-none-match'), '"v7"', 'part conditional rode (case-insensitive)');
});

test('bundler: non-GET parts are refused per part', async t => {
  const bundler = createBundler({isUrlAcceptable: accept, fetch: () => json({ok: true})});
  const doc = await (
    await bundler(bundleRequest([{id: '1', url: ORIGIN + '/a', method: 'POST'}]))
  ).json();
  t.equal(doc.parts[0].status, 405, 'refused');
  t.ok(doc.parts[0].synthetic, 'synthetically');
});

test('bundler: protocol guards — method, body, version, size', async t => {
  const bundler = createBundler({isUrlAcceptable: accept, fetch: () => json({}), maxRequests: 2});
  const get = await bundler(new Request('https://edge.example.com/bundle'));
  t.equal(get.status, 405, 'GET refused');
  t.equal(get.headers.get('allow'), 'PUT, POST', 'with Allow');
  const bad = await bundler(
    new Request('https://edge.example.com/bundle', {method: 'PUT', body: 'not json'})
  );
  t.equal(bad.status, 400, 'malformed body refused');
  const v2 = await bundler(
    new Request('https://edge.example.com/bundle', {
      method: 'PUT',
      body: JSON.stringify({v: 2, parts: []})
    })
  );
  t.equal(v2.status, 400, 'unknown version refused');
  const big = await bundler(bundleRequest([{url: '/a'}, {url: '/b'}, {url: '/c'}]));
  t.equal(big.status, 400, 'oversized bundle refused');
  const empty = await (await bundler(bundleRequest([]))).json();
  t.deepEqual(empty, {v: 1, parts: []}, 'an empty bundle is a valid no-op');
});

test('bundler: binary parts ride base64 and sort last', async t => {
  const bytes = Uint8Array.from({length: 300}, (_, i) => i % 256);
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({
      '/img': () => new Response(bytes, {headers: {'content-type': 'application/octet-stream'}}),
      '/data': () => json({after: 'binary'})
    })
  });
  const doc = await (
    await bundler(
      bundleRequest([
        {id: 'bin', url: ORIGIN + '/img'},
        {id: 'txt', url: ORIGIN + '/data'}
      ])
    )
  ).json();
  t.deepEqual(
    doc.parts.map(part => part.id),
    ['txt', 'bin'],
    'the binary part sorted last'
  );
  t.equal(doc.parts[1].encoding, 'base64', 'marked base64');
  const decoded = Uint8Array.from(atob(doc.parts[1].body), c => c.charCodeAt(0));
  t.deepEqual([...decoded], [...bytes], 'binary body roundtrips');
});

test('bundler: upstream failures become synthetic parts, siblings unaffected', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({
      '/ok': () => json({fine: true}),
      '/boom': () => {
        throw new Error('connection refused');
      }
    })
  });
  const doc = await (
    await bundler(
      bundleRequest([
        {id: '1', url: ORIGIN + '/ok'},
        {id: '2', url: ORIGIN + '/boom'}
      ])
    )
  ).json();
  t.equal(doc.parts[0].status, 200, 'healthy part served');
  t.equal(doc.parts[1].status, 502, 'failed part synthesized');
  t.ok(/connection refused/.test(doc.parts[1].body), 'with the upstream message');
});

test('bundler: a hung upstream times out into a synthetic 504', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    partTimeout: 20,
    fetch: () => new Promise(() => {}) // ignores the signal, never settles
  });
  const doc = await (await bundler(bundleRequest([{id: '1', url: ORIGIN + '/slow'}]))).json();
  t.equal(doc.parts[0].status, 504, 'timed out');
  t.ok(doc.parts[0].synthetic, 'synthetically');
});

test('bundler: 304 parts carry headers and no body; wire-form headers are stripped', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({
      '/etag': () =>
        new Response(null, {
          status: 304,
          headers: {etag: '"v3"', 'set-cookie': 'sid=leak', 'content-encoding': 'gzip'}
        })
    })
  });
  const doc = await (await bundler(bundleRequest([{id: '1', url: ORIGIN + '/etag'}]))).json();
  const part = doc.parts[0];
  t.equal(part.status, 304, '304 rides');
  t.equal(part.headers.etag, '"v3"', 'etag rides');
  t.equal(part.body, undefined, 'no body');
  t.equal(part.headers['set-cookie'], undefined, 'set-cookie never rides in a part');
  t.equal(part.headers['content-encoding'], undefined, 'wire-form headers stripped');
});

test('bundler: isUrlAcceptable is mandatory', async t => {
  try {
    createBundler({});
    t.fail('must throw');
  } catch (error) {
    t.ok(error instanceof TypeError, 'TypeError');
    t.ok(/isUrlAcceptable/.test(error.message), 'naming the option');
  }
});
