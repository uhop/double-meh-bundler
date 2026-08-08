import test from 'tape-six';

import {createBundler, BUNDLE_MIME, BUNDLE_JSONL_MIME} from '../src/index.js';

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

async function* readLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer.trim());
}

const collectLines = async response => {
  const records = [];
  for await (const record of readLines(response)) records.push(record);
  return records;
};

const streamRequest = (parts, init = {}) =>
  bundleRequest(parts, {...init, headers: {accept: BUNDLE_JSONL_MIME, ...(init.headers || {})}});

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

test('hooks: observers see the bundle and every finished part', async t => {
  const started = [];
  const finished = [];
  const done = [];
  const order = [];
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'}), '/b': () => json({name: 'b'})}),
    onBundleStart: context => (started.push(context), order.push('start')),
    onItemFinish: (part, context) => (finished.push([part, context]), order.push('item')),
    onBundleFinish: (bundle, context) => (done.push([bundle, context]), order.push('finish'))
  });
  await bundler(
    bundleRequest([
      {id: 'x', url: ORIGIN + '/a'},
      {id: 'y', url: ORIGIN + '/b'}
    ])
  );
  t.equal(started.length, 1, 'onBundleStart fired once');
  t.equal(started[0].parts.length, 2, 'with the requested parts');
  t.equal(started[0].request.method, 'PUT', 'and the outer request');
  t.equal(finished.length, 2, 'onItemFinish fired per part');
  t.deepEqual(finished.map(([part]) => part.id).sort(), ['x', 'y'], 'once for each');
  const [part, context] = finished[0];
  t.equal(part.status, 200, 'the shipped part');
  t.equal(context.requestPart.url, part.url, 'the request-side part rides the context');
  t.ok(typeof context.durationMs === 'number' && context.durationMs >= 0, 'with a duration');
  t.equal(done.length, 1, 'onBundleFinish fired once');
  t.equal(done[0][0].parts.length, 2, 'with the shipped envelope');
  t.equal(done[0][1].request.method, 'PUT', 'and the outer request');
  t.ok(done[0][1].durationMs >= context.durationMs, 'its duration spans the whole bundle');
  t.deepEqual(order, ['start', 'item', 'item', 'finish'], 'start, then every item, then finish');
});

test('hooks: onBundleFinish sees the envelope processBundle produced', async t => {
  let seen;
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})}),
    processBundle: bundle => ({...bundle, servedBy: 'edge-1'}),
    onBundleFinish: bundle => (seen = bundle)
  });
  await bundler(bundleRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.equal(seen.servedBy, 'edge-1', 'the transformed envelope, not the pre-transform one');
});

test('hooks: onBundleFinish stays silent when processBundle throws', async t => {
  let fired = 0;
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})}),
    processBundle: () => {
      throw new Error('envelope transform blew up');
    },
    onBundleFinish: () => ++fired
  });
  const response = await bundler(bundleRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.equal(response.status, 500, 'the bundle failed');
  t.equal(fired, 0, 'no finish fired — the unmatched start is the failure signal');
});

test('hooks: a throwing observer never touches the bundle', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})}),
    onBundleStart: () => {
      throw new Error('metrics exploded');
    },
    onItemFinish: () => Promise.reject(new Error('async metrics exploded')),
    onBundleFinish: () => {
      throw new Error('metrics exploded at the end');
    }
  });
  const response = await bundler(bundleRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.equal(response.status, 200, 'the bundle still ships');
  const doc = await response.json();
  t.deepEqual(doc.parts[0].body, {name: 'a'}, 'with the part intact');
});

test('hooks: processResult rewrites a part, nullish keeps it', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({secret: 1, keep: 2}), '/b': () => json({name: 'b'})}),
    processResult: part => (part.id === 'x' ? {...part, body: {keep: part.body.keep}} : undefined)
  });
  const doc = await (
    await bundler(
      bundleRequest([
        {id: 'x', url: ORIGIN + '/a'},
        {id: 'y', url: ORIGIN + '/b'}
      ])
    )
  ).json();
  t.deepEqual(doc.parts[0].body, {keep: 2}, 'the transformed part shipped rewritten');
  t.deepEqual(doc.parts[1].body, {name: 'b'}, 'a nullish return kept the original');
});

test('hooks: a throwing processResult becomes a synthetic 500, siblings unaffected', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'}), '/b': () => json({name: 'b'})}),
    processResult: part => {
      if (part.id === 'x') throw new Error('transform blew up');
      return part;
    }
  });
  const doc = await (
    await bundler(
      bundleRequest([
        {id: 'x', url: ORIGIN + '/a'},
        {id: 'y', url: ORIGIN + '/b'}
      ])
    )
  ).json();
  t.equal(doc.parts[0].status, 500, 'the failed transform synthesized a 500');
  t.ok(doc.parts[0].synthetic, 'synthetically');
  t.ok(/transform blew up/.test(doc.parts[0].body), 'with the message');
  t.equal(doc.parts[0].id, 'x', 'keeping the id so the waiter resolves');
  t.deepEqual(doc.parts[1].body, {name: 'b'}, 'the sibling shipped');
});

test('hooks: processResult runs before the base64 sort', async t => {
  const bytes = Uint8Array.from({length: 8}, (_, i) => i);
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'}), '/b': () => json({name: 'b'})}),
    // a transform that turns a JSON part binary must still sort last
    processResult: part =>
      part.id === 'x'
        ? {...part, body: btoa(String.fromCharCode(...bytes)), encoding: 'base64'}
        : part
  });
  const doc = await (
    await bundler(
      bundleRequest([
        {id: 'x', url: ORIGIN + '/a'},
        {id: 'y', url: ORIGIN + '/b'}
      ])
    )
  ).json();
  t.deepEqual(
    doc.parts.map(part => part.id),
    ['y', 'x'],
    'the transformed binary part sorted last'
  );
});

test('hooks: processBundle rewrites the envelope', async t => {
  let seen;
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})}),
    processBundle: (bundle, context) => {
      seen = context;
      return {...bundle, meta: {served: 'edge-1'}};
    }
  });
  const doc = await (await bundler(bundleRequest([{id: 'x', url: ORIGIN + '/a'}]))).json();
  t.deepEqual(doc.meta, {served: 'edge-1'}, 'the envelope shipped extended');
  t.equal(doc.parts.length, 1, 'parts intact');
  t.equal(seen.request.method, 'PUT', 'the outer request rides the context');
});

test('hooks: a throwing processBundle fails the bundle as a 500', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})}),
    processBundle: () => {
      throw new Error('envelope transform blew up');
    }
  });
  const response = await bundler(bundleRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.equal(response.status, 500, '500');
  t.equal(response.headers.get('content-type'), 'application/problem+json', 'as problem+json');
  const doc = await response.json();
  t.ok(!/blew up/.test(JSON.stringify(doc)), 'the consumer message stays server-side');
});

test('hooks: a non-function hook is refused at construction', async t => {
  const names = [
    'onBundleStart',
    'onBundleFinish',
    'onItemFinish',
    'processResult',
    'processBundle'
  ];
  for (const name of names) {
    try {
      createBundler({isUrlAcceptable: accept, [name]: 'nope'});
      t.fail('must throw for ' + name);
    } catch (error) {
      t.ok(error instanceof TypeError, name + ': TypeError');
      t.ok(error.message.includes(name), name + ': naming the option');
    }
  }
});

test('streaming: a jsonl Accept gets a header line then one part per line', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'}), '/b': () => json({name: 'b'})})
  });
  const response = await bundler(
    streamRequest([
      {id: 'x', url: ORIGIN + '/a'},
      {id: 'y', url: ORIGIN + '/b'}
    ])
  );
  t.equal(response.status, 200, 'ok');
  t.equal(response.headers.get('content-type'), BUNDLE_JSONL_MIME, 'jsonl MIME');
  t.equal(response.headers.get('cache-control'), 'no-store', 'still never cacheable');
  const records = await collectLines(response);
  t.deepEqual(records[0], {v: 1}, 'the header line comes first');
  t.equal(records.length, 3, 'header plus one line per part');
  t.deepEqual(
    records
      .slice(1)
      .map(part => part.id)
      .sort(),
    ['x', 'y'],
    'both parts shipped'
  );
  t.deepEqual(records[1].headers['content-type'], 'application/json', 'parts keep the v1 shape');
});

test('streaming: parts flush as upstreams complete, not at the end', async t => {
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({
      '/fast': () => json({which: 'fast'}),
      '/slow': async () => {
        await gate;
        return json({which: 'slow'});
      }
    })
  });
  const response = await bundler(
    streamRequest([
      {id: 'slow', url: ORIGIN + '/slow'},
      {id: 'fast', url: ORIGIN + '/fast'}
    ])
  );
  const iterator = readLines(response);
  t.deepEqual((await iterator.next()).value, {v: 1}, 'header line');
  // this await would never settle if the implementation buffered the whole bundle
  const first = await iterator.next();
  t.equal(first.value.id, 'fast', 'the fast part arrived while the slow upstream was pending');
  release();
  t.equal((await iterator.next()).value.id, 'slow', 'then the slow one');
  t.ok((await iterator.next()).done, 'and the stream closed');
});

test('streaming: base64 parts still flush last', async t => {
  const bytes = Uint8Array.from({length: 64}, (_, i) => i);
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({
      '/img': () => new Response(bytes, {headers: {'content-type': 'application/octet-stream'}}),
      '/data': () => json({after: 'binary'})
    })
  });
  const records = await collectLines(
    await bundler(
      streamRequest([
        {id: 'bin', url: ORIGIN + '/img'},
        {id: 'txt', url: ORIGIN + '/data'}
      ])
    )
  );
  t.deepEqual(
    records.slice(1).map(part => part.id),
    ['txt', 'bin'],
    'the binary part is held back to the end of the stream'
  );
  t.equal(records[2].encoding, 'base64', 'marked base64');
});

test('streaming: synthetic parts stream like any other', async t => {
  const bundler = createBundler({
    isUrlAcceptable: url => !url.includes('secret'),
    fetch: upstreamOf({'/ok': () => json({fine: true})})
  });
  const records = await collectLines(
    await bundler(
      streamRequest([
        {id: '1', url: ORIGIN + '/ok'},
        {id: '2', url: ORIGIN + '/secret'}
      ])
    )
  );
  const refused = records.slice(1).find(part => part.id === '2');
  t.equal(refused.status, 403, 'the refusal rode the stream');
  t.ok(refused.synthetic, 'synthetically');
});

test('streaming: hooks fire per part and once at the end', async t => {
  const items = [];
  let finished;
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'}), '/b': () => json({name: 'b'})}),
    onItemFinish: part => items.push(part.id),
    onBundleFinish: (bundle, context) => (finished = [bundle, context])
  });
  await collectLines(
    await bundler(
      streamRequest([
        {id: 'x', url: ORIGIN + '/a'},
        {id: 'y', url: ORIGIN + '/b'}
      ])
    )
  );
  t.deepEqual(items.sort(), ['x', 'y'], 'onItemFinish fired per part');
  t.equal(finished[0].parts.length, 2, 'onBundleFinish saw the shipped parts');
  t.equal(finished[0].v, 1, 'as a v1 envelope');
  t.ok(finished[1].durationMs >= 0, 'with a whole-bundle duration');
});

test('streaming: processResult transforms stream too', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({secret: 1, keep: 2})}),
    processResult: part => ({...part, body: {keep: part.body.keep}})
  });
  const records = await collectLines(await bundler(streamRequest([{id: 'x', url: ORIGIN + '/a'}])));
  t.deepEqual(records[1].body, {keep: 2}, 'the transform applied before the line was written');
});

test('streaming: only an exact jsonl Accept opts in', async t => {
  const bundler = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})})
  });
  const plain = await bundler(bundleRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.ok(plain.headers.get('content-type').startsWith(BUNDLE_MIME), 'no Accept → buffered json');
  // BUNDLE_MIME is a string prefix of BUNDLE_JSONL_MIME: a +json Accept must not opt in
  const jsonOnly = await bundler(
    bundleRequest([{id: 'x', url: ORIGIN + '/a'}], {headers: {accept: BUNDLE_MIME}})
  );
  t.equal(jsonOnly.headers.get('content-type'), BUNDLE_MIME, 'a +json Accept stays buffered');
  const negotiated = await bundler(
    bundleRequest([{id: 'x', url: ORIGIN + '/a'}], {
      headers: {accept: BUNDLE_JSONL_MIME + ';q=1.0, ' + BUNDLE_MIME + ';q=0.5'}
    })
  );
  t.equal(negotiated.headers.get('content-type'), BUNDLE_JSONL_MIME, 'q-params are tolerated');
});

test('streaming: streaming:false and processBundle both fall back to buffered json', async t => {
  const off = createBundler({
    isUrlAcceptable: accept,
    streaming: false,
    fetch: upstreamOf({'/a': () => json({name: 'a'})})
  });
  const offResponse = await off(streamRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.equal(offResponse.headers.get('content-type'), BUNDLE_MIME, 'streaming:false disables it');
  const transformed = createBundler({
    isUrlAcceptable: accept,
    fetch: upstreamOf({'/a': () => json({name: 'a'})}),
    processBundle: bundle => ({...bundle, servedBy: 'edge-1'})
  });
  const response = await transformed(streamRequest([{id: 'x', url: ORIGIN + '/a'}]));
  t.equal(response.headers.get('content-type'), BUNDLE_MIME, 'processBundle wins over streaming');
  const doc = await response.json();
  t.equal(doc.servedBy, 'edge-1', 'and the transform still ran');
});

test('streaming: protocol guards still answer before any stream opens', async t => {
  const bundler = createBundler({isUrlAcceptable: accept, fetch: () => json({}), maxRequests: 1});
  const big = await bundler(streamRequest([{url: '/a'}, {url: '/b'}]));
  t.equal(big.status, 400, 'oversized bundle refused as problem+json');
  t.equal(big.headers.get('content-type'), 'application/problem+json', 'not as a stream');
  const empty = await collectLines(await bundler(streamRequest([])));
  t.deepEqual(empty, [{v: 1}], 'an empty bundle streams just the header');
});
