import test from 'tape-six';
import {createServer} from 'node:http';
import {gunzipSync} from 'node:zlib';

import {createBundler} from '../src/index.js';
import {toNodeHandler} from '../src/node.js';

const json = data =>
  new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});

const withServer = async (handler, run) => {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

const bundlerHandler = options =>
  toNodeHandler(
    createBundler({
      isUrlAcceptable: () => true,
      fetch: () => json({served: true}),
      ...options
    })
  );

const DOC = JSON.stringify({v: 1, parts: [{id: '1', url: 'https://api.internal/a'}]});

test('node adapter: a bundle round-trips over real HTTP', async t => {
  await withServer(bundlerHandler(), async base => {
    const response = await fetch(base + '/bundle', {
      method: 'PUT',
      headers: {'content-type': 'application/vnd.double-meh.bundle-request+json'},
      body: DOC
    });
    t.equal(response.status, 200, 'ok');
    t.ok(
      response.headers.get('content-type').startsWith('application/vnd.double-meh.bundle+json'),
      'bundle MIME crossed the wire'
    );
    const doc = await response.json();
    t.deepEqual(doc.parts[0].body, {served: true}, 'the part decoded');
  });
});

test('node adapter: the response is gzipped for accepting clients', async t => {
  await withServer(bundlerHandler(), async base => {
    // raw exchange: fetch would transparently decompress and hide the evidence
    const {request: httpRequest} = await import('node:http');
    const raw = await new Promise((resolve, reject) => {
      const req = httpRequest(
        base + '/bundle',
        {method: 'PUT', headers: {'accept-encoding': 'gzip', 'content-type': 'application/json'}},
        res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({res, body: Buffer.concat(chunks)}));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end(DOC);
    });
    t.equal(raw.res.headers['content-encoding'], 'gzip', 'gzip on the wire');
    const doc = JSON.parse(gunzipSync(raw.body).toString());
    t.equal(doc.v, 1, 'the gzipped envelope decodes');
  });
});

test('node adapter: protocol errors surface as-is', async t => {
  await withServer(bundlerHandler(), async base => {
    const response = await fetch(base + '/bundle', {method: 'GET'});
    t.equal(response.status, 405, 'method guard crossed the adapter');
  });
});
