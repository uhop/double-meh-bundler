export declare const REQUEST_MIME: string;
export declare const BUNDLE_MIME: string;

export type FetchHandler = (request: Request) => Promise<Response>;

export interface BundlerOptions {
  /** The allow-list — the security boundary. Required; there is no default. */
  isUrlAcceptable: (url: string, request: Request) => boolean;
  /** Maps public part URLs to internal ones. Default: identity. */
  resolveUrl?: (url: string) => string;
  /** The upstream fetch — injectable for tests, mocks, and in-process serving. Default: `globalThis.fetch`. */
  fetch?: (request: Request) => Response | Promise<Response>;
  /** Hard cap on parts per bundle (400 above it). Default: 20. */
  maxRequests?: number;
  /** Per-part upstream timeout, ms — a timed-out part becomes a synthetic 504. Default: 10000. */
  partTimeout?: number;
}

/**
 * Creates the bundler as a web-standard fetch handler: usable directly with `Bun.serve`,
 * `Deno.serve`, service workers, and web-handler frameworks; see `double-meh-bundler/node.js`
 * for the `node:http`/Express adapter.
 */
export declare function createBundler(options: BundlerOptions): FetchHandler;
