// Conformance: the real double-meh client (a devDependency, published) against this bundler over
// real HTTP. The mirror of the koa/node adapter suites — those pin the framework shapes, this pins
// the protocol contract the two packages have to agree on.
import test from 'tape-six';
import {createServer} from 'node:http';
import {create} from 'double-meh';

import {createBundler} from '../src/index.js';
import {toNodeHandler} from '../src/node.js';

const DATA = {
  '/api/a': {name: 'a'},
  '/api/b': {name: 'b'},
  '/api/slow': {name: 'slow'}
};

// resolves when /api/slow is allowed to answer; a bundle with one laggard is the streaming case
const gateFor = () => {
  let release;
  const promise = new Promise(resolve => (release = resolve));
  return {promise, release};
};

const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
};

const shutdown = async server => {
  // keep-alive sockets from the bundler's own fetch would otherwise hold close() open
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
};

// Two origins on purpose. The bundler must not fan out over the same socket pool it is answering
// on: with one server, a deliberately blocked upstream sits in the pool the bundle request is
// itself waiting in, and the whole bundle can starve into a partTimeout. Two origins is also the
// real deployment shape — an edge bundler in front of backend services.
const withBundlerServer = async (run, options = {}) => {
  const gate = gateFor();
  const counters = {bundle: 0, upstream: 0};
  const api = createServer(async (req, res) => {
    ++counters.upstream;
    const path = req.url.split('?')[0];
    if (path === '/api/slow') await gate.promise;
    const body = DATA[path];
    if (!body) {
      res.writeHead(404, {'content-type': 'application/json'});
      return void res.end(JSON.stringify({error: 'not found'}));
    }
    res.writeHead(200, {'content-type': 'application/json', etag: '"' + path + '"'});
    res.end(JSON.stringify(body));
  });
  const bundle = toNodeHandler(
    createBundler({isUrlAcceptable: url => url.includes('/api/'), ...options})
  );
  const edge = createServer((req, res) => {
    ++counters.bundle;
    bundle(req, res);
  });
  const bases = {api: await listen(api), edge: await listen(edge)};
  try {
    await run(bases, {counters, gate});
  } finally {
    gate.release();
    await shutdown(edge);
    await shutdown(api);
  }
};

const clientFor = (bases, overrides = {}) => {
  const io = create();
  io.bundle.url = bases.edge + '/bundle';
  Object.assign(io.bundle, overrides);
  return io;
};

test('conformance: a real client burst rides one buffered bundle', async t => {
  await withBundlerServer(async (bases, {counters}) => {
    const io = clientFor(bases);
    const [a, b] = await Promise.all([
      io.get(bases.api + '/api/a', null, {bundle: true}),
      io.get(bases.api + '/api/b', null, {bundle: true})
    ]);
    t.deepEqual(a, DATA['/api/a'], 'first part decoded through the real client');
    t.deepEqual(b, DATA['/api/b'], 'second part decoded');
    t.equal(counters.bundle, 1, 'one bundle request crossed the wire');
    t.equal(counters.upstream, 2, 'the bundler fanned out to both services');
    const again = await io.get(bases.api + '/api/a');
    t.deepEqual(again, DATA['/api/a'], 'a bare GET is served from the part cache');
    t.equal(counters.upstream, 2, 'with no extra upstream hit');
  });
});

test('conformance: a streamed bundle resolves each waiter as its part lands', async t => {
  await withBundlerServer(async (bases, {counters, gate}) => {
    const io = clientFor(bases, {streaming: true});
    const order = [];
    const slow = io
      .get(bases.api + '/api/slow', null, {bundle: true})
      .then(data => (order.push('slow'), data));
    const fast = io
      .get(bases.api + '/api/a', null, {bundle: true})
      .then(data => (order.push('fast'), data));
    // the buffered framing settles both together — this await is the whole contract
    t.deepEqual(await fast, DATA['/api/a'], 'the fast part decoded while /api/slow was blocked');
    t.deepEqual(order, ['fast'], 'and resolved first');
    gate.release();
    t.deepEqual(await slow, DATA['/api/slow'], 'the slow part followed');
    t.deepEqual(order, ['fast', 'slow'], 'completion order, not request order');
    t.equal(counters.bundle, 1, 'still one bundle request');
  });
});

test('conformance: streamed parts land in the client cache like buffered ones', async t => {
  await withBundlerServer(async (bases, {counters, gate}) => {
    gate.release();
    const io = clientFor(bases, {streaming: true});
    await Promise.all([
      io.get(bases.api + '/api/a', null, {bundle: true}),
      io.get(bases.api + '/api/b', null, {bundle: true})
    ]);
    const upstreamAfterBundle = counters.upstream;
    const again = await io.get(bases.api + '/api/b');
    t.deepEqual(again, DATA['/api/b'], 'bare GET served from the streamed part');
    t.equal(counters.upstream, upstreamAfterBundle, 'no extra upstream hit');
  });
});

test('conformance: an allow-list refusal reaches the client as FailedIO', async t => {
  await withBundlerServer(async bases => {
    const io = clientFor(bases, {streaming: true});
    const [ok, refused] = await Promise.allSettled([
      io.get(bases.api + '/api/a', null, {bundle: true}),
      io.get(bases.api + '/private/secret', null, {bundle: true})
    ]);
    t.equal(ok.status, 'fulfilled', 'the acceptable part served');
    t.equal(refused.status, 'rejected', 'the refused part rejected');
    t.ok(refused.reason instanceof io.FailedIO, 'as FailedIO — the synthetic-part mapping');
    t.ok(/unacceptable URL/.test(refused.reason.message), 'carrying the bundler reason');
  });
});

test('conformance: the client falls back cleanly when the bundler will not stream', async t => {
  await withBundlerServer(
    async (bases, {counters}) => {
      const io = clientFor(bases, {streaming: true});
      const [a, b] = await Promise.all([
        io.get(bases.api + '/api/a', null, {bundle: true}),
        io.get(bases.api + '/api/b', null, {bundle: true})
      ]);
      t.deepEqual([a, b], [DATA['/api/a'], DATA['/api/b']], 'both parts decoded anyway');
      t.equal(counters.bundle, 1, 'one bundle request');
      t.equal(counters.upstream, 2, 'no individual GET fallback');
    },
    {streaming: false}
  );
});
