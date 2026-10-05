import type { MiddlewareHandler } from 'hono';

const MAX_BYTES = 16 * 1024;

/** Bound actual bytes before JSON parsing, including routes that ignore their body.
 * Installed Hono bodyLimit trusts Content-Length and only checks streams consumed
 * downstream. Neither is sufficient for all reminder endpoints.
 */
export const reminderBodyLimit: MiddlewareHandler = async (c, next) => {
  if (Number(c.req.header('content-length')) > MAX_BYTES) {
    return c.json({ error: 'govde en fazla 16 KiB olmali' }, 413);
  }
  const reader = c.req.raw.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new TypeError('Request body must contain bytes');
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          return c.json({ error: 'govde en fazla 16 KiB olmali' }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    c.req.raw = new Request(c.req.raw, { body });
  }
  await next();
};
