// Living Stills relay for Luminal (Cloudflare Worker, free tier is plenty).
//
// Luminal does not answer calls made from a web page, so the published site sends its director
// requests here and this forwards them. Your Luminal key travels with each request from your
// browser and is not stored here.
//
// Deploy: dash.cloudflare.com -> Workers & Pages -> Create -> Worker -> paste this file -> Deploy.
// Then paste the worker's URL (https://<name>.<you>.workers.dev) into Living Stills -> Settings -> Relay.

const UPSTREAM = 'https://flash.luminal.cloud/v1';
const ROUTES = new Set(['/chat/completions', '/balance', '/models']);

export function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function relay(request, prefix = '') {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  const route = url.pathname.slice(prefix.length) || '/';
  if (!ROUTES.has(route)) return new Response('Not found', { status: 404, headers: cors(origin) });
  const auth = request.headers.get('Authorization') || '';
  const upstream = await fetch(UPSTREAM + route, {
    method: request.method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: request.method === 'POST' ? await request.text() : undefined,
  });
  const headers = new Headers(cors(origin));
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default { fetch: (request) => relay(request) };
