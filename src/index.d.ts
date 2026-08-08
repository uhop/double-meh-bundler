export declare const REQUEST_MIME: string;
export declare const BUNDLE_MIME: string;
export declare const BUNDLE_JSONL_MIME: string;

export type FetchHandler = (request: Request) => Promise<Response>;

/** A part as it arrives in the request envelope. */
export interface RequestPart {
  id?: string | number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

/** A part as it ships in the response envelope. */
export interface ResultPart {
  id?: string | number;
  url: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  encoding?: 'base64';
  synthetic?: true;
}

export interface Bundle {
  v: 1;
  parts: ResultPart[];
}

export interface PartContext {
  /** The outer bundle request. */
  request: Request;
  /** The part as the client sent it. */
  requestPart: RequestPart;
  /** Upstream fetch time in ms, excluding `processResult`. */
  durationMs: number;
}

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
  /**
   * Serve `application/vnd.double-meh.bundle+jsonl` when the request's `Accept` names it —
   * a `{"v":1}` header line followed by one part per line, flushed as upstreams complete.
   * Never applies when `processBundle` is configured (that transform needs the whole envelope).
   * Default: true.
   */
  streaming?: boolean;

  /**
   * Observer: the bundle passed its protocol guards and is about to fan out.
   * Not awaited; a throw or rejection is swallowed — instrumentation never changes behavior.
   */
  onBundleStart?: (context: {request: Request; parts: RequestPart[]}) => unknown;
  /**
   * Observer: the envelope reached its final shape (after `processBundle`), about to be serialized.
   * `durationMs` covers the whole bundle, from the guards passing to here. Does not fire when
   * `processBundle` throws — a start with no matching finish is the failure signal.
   * Not awaited; a throw or rejection is swallowed — instrumentation never changes behavior.
   */
  onBundleFinish?: (bundle: Bundle, context: {request: Request; durationMs: number}) => unknown;
  /**
   * Observer: one part reached its final shape (after `processResult`).
   * Not awaited; a throw or rejection is swallowed — instrumentation never changes behavior.
   */
  onItemFinish?: (part: ResultPart, context: PartContext) => unknown;
  /**
   * Transform: rewrite one finished part. Awaited, and runs before the base64 sort.
   * A nullish return keeps the original part; a throw makes the part a synthetic 500.
   */
  processResult?: (
    part: ResultPart,
    context: PartContext
  ) => ResultPart | undefined | null | Promise<ResultPart | undefined | null>;
  /**
   * Transform: rewrite the whole envelope, after the sort and before serialization.
   * A nullish return keeps the original envelope; a throw fails the bundle with a 500.
   */
  processBundle?: (
    bundle: Bundle,
    context: {request: Request}
  ) => Bundle | undefined | null | Promise<Bundle | undefined | null>;
}

/**
 * Creates the bundler as a web-standard fetch handler: usable directly with `Bun.serve`,
 * `Deno.serve`, service workers, and web-handler frameworks; see `double-meh-bundler/node.js`
 * for the `node:http`/Express adapter.
 */
export declare function createBundler(options: BundlerOptions): FetchHandler;
