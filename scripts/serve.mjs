// Serves the built site (dist/) with the Luminal relay at /luminal, so the director works locally
// without deploying anything:  npm run build && npm run serve   ->  http://localhost:4173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { relay } from '../relay/worker.js';

const root = path.resolve(process.env.ROOT || 'dist');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.splat': 'application/octet-stream' };

export async function nodeRelay(req, res, prefix) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://local${req.url}`, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  });
  if (!request.headers.get('authorization') && process.env.LUMINAL_API_KEY) request.headers.set('authorization', `Bearer ${process.env.LUMINAL_API_KEY}`);
  const r = await relay(request, prefix);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (!r.body) return res.end();
  for await (const c of r.body) res.write(c);
  res.end();
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/luminal/')) return await nodeRelay(req, res, '/luminal');
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(502); res.end(String(err));
    }
  }).listen(port, () => console.log(`Living Stills on http://localhost:${port}`));
}
