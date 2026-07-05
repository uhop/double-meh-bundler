// @ts-self-types="./koa.d.ts"
// Koa adapter — duck-typed ctx, no koa import; mount it on your route, compression is your
// middleware's job (koa-compress in front recovers the bundle's compression payoff).
import {Readable} from 'node:stream';

export const toKoaMiddleware = handler => async ctx => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value != null) headers.set(key, value);
  }
  const method = ctx.method || 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : /** @type {ReadableStream} */ (/** @type {unknown} */ (Readable.toWeb(ctx.req)));
  const request = new Request(ctx.href, {method, headers, body, ...(body && {duplex: 'half'})});
  const response = await handler(request);
  ctx.status = response.status;
  response.headers.forEach((value, key) => ctx.set(key, value));
  // koa's body setter forces 204 on null — an empty string keeps the real status (405 et al.)
  ctx.body = response.body ? Readable.fromWeb(/** @type {any} */ (response.body)) : '';
};
