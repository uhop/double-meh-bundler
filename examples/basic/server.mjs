// Minimal bundler deployment: local API routes + the bundle endpoint on one node:http server.
import {createServer} from 'node:http';

import {createBundler} from '../../src/index.js';
import {toNodeHandler} from '../../src/node.js';

const PORT = Number(process.env.PORT) || 3000;

const api = {
  '/api/hello': () => ({message: 'hello from the backend'}),
  '/api/time': () => ({now: new Date().toISOString()})
};

const bundle = toNodeHandler(
  createBundler({
    isUrlAcceptable: url => url.startsWith('/api/'),
    resolveUrl: url => new URL(url, `http://127.0.0.1:${PORT}`).href
  })
);

createServer((req, res) => {
  const route = api[new URL(req.url, `http://${req.headers.host}`).pathname];
  if (route) {
    res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify(route()));
  }
  if (req.url.startsWith('/bundle')) return void bundle(req, res);
  res.statusCode = 404;
  res.end('not found');
}).listen(PORT, () => console.log(`bundler example on http://localhost:${PORT}`));
