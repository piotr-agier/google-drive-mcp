import { Readable } from 'node:stream';

/**
 * Normalize a media-download response body to a Node Readable.
 *
 * gaxios 7 (native fetch) returns a web ReadableStream for
 * `responseType: 'stream'`, while older clients and test doubles produce Node
 * Readables or already-buffered bodies (Buffer/string). Downstream code relies
 * on Node stream semantics (`.on()` listeners, upload media bodies), so accept
 * any of those shapes here.
 */
export function toNodeReadable(data: unknown): Readable {
  if (data instanceof Readable) return data;
  if (typeof data === 'string' || data instanceof Uint8Array) {
    // Wrap in an array so Readable.from emits one chunk instead of iterating
    // per character / per byte.
    return Readable.from([data]);
  }
  return Readable.fromWeb(data as import('node:stream/web').ReadableStream);
}
