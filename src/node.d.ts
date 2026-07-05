import type {IncomingMessage, ServerResponse} from 'node:http';
import type {FetchHandler} from './index.js';

export interface NodeHandlerOptions {
  /** gzip the bundle response when the client accepts it — the compression-locality payoff. Default: true. */
  compress?: boolean;
}

/**
 * Adapts the fetch-handler bundler to `(req, res, next?)` — bare `node:http` and Express alike
 * (Express req/res are `IncomingMessage`/`ServerResponse` supersets; no framework import needed).
 * With `next` present, errors are forwarded to it; otherwise a 500 problem+json is sent.
 */
export declare function toNodeHandler(
  handler: FetchHandler,
  options?: NodeHandlerOptions
): (req: IncomingMessage, res: ServerResponse, next?: (error: unknown) => void) => Promise<void>;
