import { describe, expect, it } from 'vitest';
import { readCapped } from '../src/http';

/** A request whose body comes in these chunks, without its length. */
function chunked(...chunks: Uint8Array[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request('https://stayput.test/x', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  });
}

describe('readCapped', () => {
  it('reads a body up to its limit, and none past it', async () => {
    const bytes = new TextEncoder().encode('a'.repeat(10));
    expect(await readCapped(chunked(bytes.slice(0, 4), bytes.slice(4)), 10)).toBe('a'.repeat(10));
    expect(await readCapped(chunked(bytes, new Uint8Array([98])), 10)).toBeNull();
  });

  it('trusts a length that says too much, without reading', async () => {
    const request = new Request('https://stayput.test/x', {
      method: 'POST',
      headers: { 'content-length': '11' },
      body: 'a'.repeat(11),
    });
    expect(await readCapped(request, 10)).toBeNull();
  });

  it('counts bytes, not characters, and decodes a character cut between two chunks', async () => {
    const bytes = new TextEncoder().encode('été');
    expect(bytes.length).toBe(5);
    expect(await readCapped(chunked(bytes.slice(0, 1), bytes.slice(1)), 5)).toBe('été');
    expect(await readCapped(chunked(bytes), 4)).toBeNull();
  });

  it('reads an empty body as empty', async () => {
    expect(await readCapped(new Request('https://stayput.test/x', { method: 'POST' }), 10)).toBe(
      '',
    );
  });
});
