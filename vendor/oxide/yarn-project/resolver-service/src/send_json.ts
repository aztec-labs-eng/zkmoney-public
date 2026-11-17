import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', String(buf.length));
  res.end(buf);
}
