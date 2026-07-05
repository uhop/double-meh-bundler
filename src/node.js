// @ts-self-types="./node.d.ts"
// node:http adapter — duck-typed (req, res, next?): covers bare node:http and Express alike.
import {Readable} from 'node:stream';
import {createGzip} from 'node:zlib';

const gzipRe = /(^|[,\s])gzip($|[;,\s])/;

export const toNodeHandler = (handler, options = {}) => {
  const {compress = true} = options;
  return async (req, res, next) => {
    try {
      const proto = req.socket && req.socket.encrypted ? 'https' : 'http';
      const url = new URL(req.url || '/', proto + '://' + (req.headers.host || 'localhost'));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else if (value != null) headers.set(key, value);
      }
      const method = req.method || 'GET';
      const body =
        method === 'GET' || method === 'HEAD'
          ? undefined
          : /** @type {ReadableStream} */ (/** @type {unknown} */ (Readable.toWeb(req)));
      const request = new Request(url, {method, headers, body, ...(body && {duplex: 'half'})});
      const response = await handler(request);
      const outHeaders = {};
      response.headers.forEach((value, key) => (outHeaders[key] = value));
      const source = response.body
        ? Readable.fromWeb(/** @type {any} */ (response.body))
        : undefined;
      if (compress && source && gzipRe.test(String(req.headers['accept-encoding'] || ''))) {
        delete outHeaders['content-length'];
        outHeaders['content-encoding'] = 'gzip';
        res.writeHead(response.status, outHeaders);
        source.pipe(createGzip()).pipe(res);
      } else {
        res.writeHead(response.status, outHeaders);
        if (source) source.pipe(res);
        else res.end();
      }
    } catch (error) {
      if (typeof next === 'function') return void next(error);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/problem+json');
      res.end(JSON.stringify({title: 'bundler failure', status: 500}));
    }
  };
};
