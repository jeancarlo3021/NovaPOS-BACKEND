import type { IncomingMessage, ServerResponse } from 'http';
import app from '../src/app.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const host   = (req.headers.host ?? 'localhost').split(':')[0];
    // x-matched-path has the original path before Vercel rewrites
    const path   = (req.headers['x-matched-path'] as string | undefined) ?? req.url ?? '/';
    const url    = new URL(path, `https://${host}`);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string')      headers.set(k, v);
      else if (Array.isArray(v))      v.forEach(val => headers.append(k, val));
    }

    let body: Buffer | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (chunks.length) body = Buffer.concat(chunks);
    }

    const request  = new Request(url.toString(), { method: req.method ?? 'GET', headers, body: body ? new Uint8Array(body) : undefined });
    const response = await app.fetch(request);

    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('[handler]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: null, error: String(err) }));
  }
}
