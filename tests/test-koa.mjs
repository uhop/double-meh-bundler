import test from 'tape-six';
import Koa from 'koa';

import {createBundler} from '../src/index.js';
import {toKoaMiddleware} from '../src/koa.js';

const json = data =>
  new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});

const withKoa = async run => {
  const app = new Koa();
  const middleware = toKoaMiddleware(
    createBundler({isUrlAcceptable: () => true, fetch: () => json({served: 'koa'})})
  );
  app.use(ctx => {
    if (ctx.path === '/bundle') return middleware(ctx);
    ctx.status = 404;
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

test('koa adapter: a bundle round-trips through real koa', async t => {
  await withKoa(async base => {
    const response = await fetch(base + '/bundle', {
      method: 'PUT',
      headers: {'content-type': 'application/vnd.double-meh.bundle-request+json'},
      body: JSON.stringify({v: 1, parts: [{id: '1', url: 'https://api.internal/a'}]})
    });
    t.equal(response.status, 200, 'ok');
    t.ok(
      response.headers.get('content-type').startsWith('application/vnd.double-meh.bundle+json'),
      'bundle MIME survived koa'
    );
    const doc = await response.json();
    t.deepEqual(doc.parts[0].body, {served: 'koa'}, 'the part decoded');
  });
});

test('koa adapter: bodyless statuses survive the koa body setter', async t => {
  await withKoa(async base => {
    const response = await fetch(base + '/bundle', {method: 'GET'});
    t.equal(response.status, 405, 'the 405 is not collapsed into a 204');
    t.equal(response.headers.get('allow'), 'PUT, POST', 'Allow crossed the adapter');
  });
});
