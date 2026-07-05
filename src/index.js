// @ts-self-types="./index.d.ts"

export const REQUEST_MIME = 'application/vnd.double-meh.bundle-request+json';
export const BUNDLE_MIME = 'application/vnd.double-meh.bundle+json';

// the whitelist that rides per part; auth/cookies propagate from the outer request only
const PART_HEADERS = ['accept', 'accept-language', 'if-none-match', 'if-modified-since'];
const PROPAGATED = ['authorization', 'cookie'];
// wire-form, hop-by-hop, and cookie-setting headers never ride inside part JSON
const STRIPPED = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-encoding',
  'content-length',
  'set-cookie'
]);

const jsonRe = /^application\/(?:[\w.+-]+\+)?json\b/;
const textRe = /^text\//;

const problem = (status, title) =>
  new Response(JSON.stringify({title, status}), {
    status,
    headers: {'content-type': 'application/problem+json', 'cache-control': 'no-store'}
  });

const synthetic = (part, url, status, message) => ({
  ...(part.id != null && {id: part.id}),
  url,
  status,
  synthetic: true,
  headers: {'content-type': 'text/plain'},
  body: message
});

const toBase64 = buffer => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const createBundler = (options = {}) => {
  const {
    isUrlAcceptable,
    resolveUrl = url => url,
    fetch: upstream = globalThis.fetch,
    maxRequests = 20,
    partTimeout = 10000
  } = options;
  if (typeof isUrlAcceptable !== 'function') {
    throw new TypeError(
      'double-meh-bundler: isUrlAcceptable is required — the allow-list is the security boundary'
    );
  }

  const runPart = async (part, request) => {
    const url = String(part.url || '');
    if (!url) return synthetic(part, url, 400, 'the part has no url');
    if ((part.method || 'GET').toUpperCase() !== 'GET') {
      return synthetic(part, url, 405, 'only GET parts are supported');
    }
    if (!isUrlAcceptable(url, request))
      return synthetic(part, url, 403, 'unacceptable URL: ' + url);
    let target;
    try {
      target = new URL(resolveUrl(url), request.url);
    } catch {
      return synthetic(part, url, 400, 'unresolvable URL: ' + url);
    }
    const headers = new Headers();
    const supplied = {};
    for (const [key, value] of Object.entries(part.headers || {})) {
      supplied[key.toLowerCase()] = value;
    }
    for (const name of PART_HEADERS) {
      if (supplied[name] != null) headers.set(name, String(supplied[name]));
    }
    for (const name of PROPAGATED) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let response;
    try {
      const signal = AbortSignal.timeout(partTimeout);
      // race the timeout explicitly: an injected upstream may ignore the signal
      response = await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, {once: true});
        const settle = fn => value => {
          signal.removeEventListener('abort', onAbort);
          fn(value);
        };
        Promise.resolve(upstream(new Request(target, {headers, signal, redirect: 'follow'}))).then(
          settle(resolve),
          settle(reject)
        );
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return synthetic(part, url, timedOut ? 504 : 502, String((error && error.message) || error));
    }
    const headersOut = /** @type {Record<string, string>} */ ({});
    response.headers.forEach((value, key) => {
      if (!STRIPPED.has(key)) headersOut[key] = value;
    });
    let body;
    let encoding;
    if (response.status !== 204 && response.status !== 304) {
      const type = headersOut['content-type'] || '';
      if (jsonRe.test(type)) {
        try {
          body = await response.json();
        } catch (error) {
          return synthetic(part, url, 502, 'invalid JSON from upstream: ' + error.message);
        }
      } else if (textRe.test(type)) {
        body = await response.text();
      } else {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength) {
          body = toBase64(buffer);
          encoding = 'base64';
        }
      }
    }
    return {
      ...(part.id != null && {id: part.id}),
      url,
      status: response.status,
      headers: headersOut,
      ...(body !== undefined && {body}),
      ...(encoding && {encoding})
    };
  };

  return async request => {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return new Response(null, {
        status: 405,
        headers: {allow: 'PUT, POST', 'cache-control': 'no-store'}
      });
    }
    let doc;
    try {
      doc = await request.json();
    } catch {
      return problem(400, 'malformed bundle request body');
    }
    if (!doc || doc.v !== 1 || !Array.isArray(doc.parts)) {
      return problem(400, 'not a v1 bundle request');
    }
    if (doc.parts.length > maxRequests) {
      return problem(400, 'too many parts (max ' + maxRequests + ')');
    }
    const parts = await Promise.all(doc.parts.map(part => runPart(part, request)));
    // binary parts sort last (stable): text parts stay contiguous in one compression window
    parts.sort((a, b) => (a.encoding === 'base64' ? 1 : 0) - (b.encoding === 'base64' ? 1 : 0));
    // no-store: the envelope must never be cached or revalidated as a unit — parts carry their own
    return new Response(JSON.stringify({v: 1, parts}), {
      headers: {'content-type': BUNDLE_MIME, 'cache-control': 'no-store'}
    });
  };
};
