import type {IncomingMessage} from 'node:http';
import type {FetchHandler} from './index.js';

/**
 * The structural slice of Koa's Context the adapter touches — deliberately not `@types/koa`:
 * the adapter is duck-typed and the real `Context` satisfies this shape.
 */
export interface KoaLikeContext {
  req: IncomingMessage;
  href: string;
  method: string;
  status: number;
  body: unknown;
  set(field: string, value: string): void;
}

/**
 * Adapts the fetch-handler bundler to a Koa middleware. Terminal — it never calls `next`;
 * mount it on the bundle route. Put `koa-compress` in front to compress the envelope.
 */
export declare function toKoaMiddleware(
  handler: FetchHandler
): (ctx: KoaLikeContext) => Promise<void>;
