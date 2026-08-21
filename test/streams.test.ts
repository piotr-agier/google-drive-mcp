import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { toNodeReadable } from '../src/utils/streams.js';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

test('toNodeReadable passes a Node Readable through unchanged', async () => {
  const source = Readable.from(['node-', 'payload']);
  const out = toNodeReadable(source);
  assert.equal(out, source);
  assert.equal(await collect(out), 'node-payload');
});

test('toNodeReadable wraps buffered bodies as a single chunk', async () => {
  assert.equal(await collect(toNodeReadable(Buffer.from('buffer-payload'))), 'buffer-payload');
  assert.equal(await collect(toNodeReadable('string-payload')), 'string-payload');
});

test('toNodeReadable converts a web ReadableStream to a Node Readable', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('web-'));
      controller.enqueue(new TextEncoder().encode('payload'));
      controller.close();
    },
  });
  const out = toNodeReadable(source);
  assert.ok(out instanceof Readable);
  assert.equal(await collect(out), 'web-payload');
});
