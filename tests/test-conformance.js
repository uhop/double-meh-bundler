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

const withBundlerServer = async (run, options = {}) => {
  const gate = gateFor();
  const counters = {bundle: 0, upstream: 0};
  const bundle = toNodeHandler(
    createBundler({isUrlAcceptable: url => url.includes('/api/'), ...options})
  );
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/bundle') {
      ++counters.bundle;
      return void bundle(req, res);
    }
    ++counters.upstream;
    if (path === '/api/slow') await gate.promise;
    const body = DATA[path];
    if (!body) {
      res.writeHead(404, {'content-type': 'application/json'});
      return void res.end(JSON.stringify({error: 'not found'}));
    }
    res.writeHead(200, {'content-type': 'application/json', etag: '"' + path + '"'});
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + server.address().port, {counters, gate});
  } finally {
    gate.release();
    await new Promise(resolve => server.close(resolve));
  }
};

const clientFor = (base, overrides = {}) => {
  const io = create();
  io.bundle.url = base + '/bundle';
  Object.assign(io.bundle, overrides);
  return io;
};

test('conformance: a real client burst rides one buffered bundle', async t => {
  await withBundlerServer(async (base, {counters}) => {
    const io = clientFor(base);
    const [a, b] = await Promise.all([
      io.get(base + '/api/a', null, {bundle: true}),
      io.get(base + '/api/b', null, {bundle: true})
    ]);
    t.deepEqual(a, DATA['/api/a'], 'first part decoded through the real client');
    t.deepEqual(b, DATA['/api/b'], 'second part decoded');
    t.equal(counters.bundle, 1, 'one bundle request crossed the wire');
    t.equal(counters.upstream, 2, 'the bundler fanned out to both services');
    const again = await io.get(base + '/api/a');
    t.deepEqual(again, DATA['/api/a'], 'a bare GET is served from the part cache');
    t.equal(counters.upstream, 2, 'with no extra upstream hit');
  });
});

test('conformance: a streamed bundle resolves each waiter as its part lands', async t => {
  await withBundlerServer(async (base, {counters, gate}) => {
    const io = clientFor(base, {streaming: true});
    const order = [];
    const slow = io
      .get(base + '/api/slow', null, {bundle: true})
      .then(data => (order.push('slow'), data));
    const fast = io
      .get(base + '/api/a', null, {bundle: true})
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
  await withBundlerServer(async (base, {counters, gate}) => {
    gate.release();
    const io = clientFor(base, {streaming: true});
    await Promise.all([
      io.get(base + '/api/a', null, {bundle: true}),
      io.get(base + '/api/b', null, {bundle: true})
    ]);
    const upstreamAfterBundle = counters.upstream;
    const again = await io.get(base + '/api/b');
    t.deepEqual(again, DATA['/api/b'], 'bare GET served from the streamed part');
    t.equal(counters.upstream, upstreamAfterBundle, 'no extra upstream hit');
  });
});

test('conformance: an allow-list refusal reaches the client as FailedIO', async t => {
  await withBundlerServer(async base => {
    const io = clientFor(base, {streaming: true});
    const [ok, refused] = await Promise.allSettled([
      io.get(base + '/api/a', null, {bundle: true}),
      io.get(base + '/private/secret', null, {bundle: true})
    ]);
    t.equal(ok.status, 'fulfilled', 'the acceptable part served');
    t.equal(refused.status, 'rejected', 'the refused part rejected');
    t.ok(refused.reason instanceof io.FailedIO, 'as FailedIO — the synthetic-part mapping');
    t.ok(/unacceptable URL/.test(refused.reason.message), 'carrying the bundler reason');
  });
});

test('conformance: the client falls back cleanly when the bundler will not stream', async t => {
  await withBundlerServer(
    async (base, {counters}) => {
      const io = clientFor(base, {streaming: true});
      const [a, b] = await Promise.all([
        io.get(base + '/api/a', null, {bundle: true}),
        io.get(base + '/api/b', null, {bundle: true})
      ]);
      t.deepEqual([a, b], [DATA['/api/a'], DATA['/api/b']], 'both parts decoded anyway');
      t.equal(counters.bundle, 1, 'one bundle request');
      t.equal(counters.upstream, 2, 'no individual GET fallback');
    },
    {streaming: false}
  );
});
