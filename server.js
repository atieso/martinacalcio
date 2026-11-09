import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const host = '0.0.0.0';
const apiKey = process.env.API_FOOTBALL_KEY;
const league = process.env.API_FOOTBALL_LEAGUE || '433';
const season = process.env.API_FOOTBALL_SEASON || '2026';
const ttlMs = Math.max(300, Number(process.env.CACHE_SECONDS || 3600)) * 1000;
let cache = { at: 0, data: null };

function send(res, status, body, headers = {}) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*', ...headers});
  res.end(JSON.stringify(body));
}

async function getStandings() {
  if (cache.data && Date.now() - cache.at < ttlMs) return { ...cache.data, cached: true };
  const u = new URL('https://v3.football.api-sports.io/standings');
  u.searchParams.set('league', league);
  u.searchParams.set('season', season);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(u, { headers: { 'x-apisports-key': apiKey }, signal: controller.signal });
    if (!r.ok) throw new Error(`API-Football HTTP ${r.status}`);
    const raw = await r.json();
    if (raw.errors && (Array.isArray(raw.errors) ? raw.errors.length : Object.keys(raw.errors).length)) throw new Error('API-Football returned an error');
    const groups = raw.response?.[0]?.league?.standings;
    if (!Array.isArray(groups) || !groups.length) throw new Error('No standings returned for configured league and season');
    const standings = groups.flat().map(row => ({
      position: row.rank, team: row.team?.name || '', teamId: row.team?.id || null, logo: row.team?.logo || '',
      points: row.points, played: row.all?.played ?? null, win: row.all?.win ?? null,
      draw: row.all?.draw ?? null, lose: row.all?.lose ?? null,
      goalsFor: row.all?.goals?.for ?? null, goalsAgainst: row.all?.goals?.against ?? null,
      goalDifference: row.goalsDiff ?? null, form: row.form || '', group: row.group || ''
    }));
    const data = { league, season, updatedAt: new Date().toISOString(), standings };
    cache = {at: Date.now(), data};
    return { ...data, cached: false };
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (pathname === '/health') return send(res, 200, { ok: true, configured: Boolean(apiKey) }, {'cache-control':'no-store'});
  if (pathname !== '/standings') return send(res, 404, {error:'Not found', available:['/health','/standings']});
  if (!apiKey) return send(res, 503, {error:'API_FOOTBALL_KEY not configured'}, {'cache-control':'no-store'});
  try { return send(res, 200, await getStandings()); }
  catch (e) {
    console.error('Standings lookup failed:', e.message);
    if (cache.data) return send(res, 200, {...cache.data, cached:true, stale:true});
    return send(res, 502, {error:'Classifica non disponibile. Verificare ID lega, stagione e copertura del piano.'}, {'cache-control':'no-store'});
  }
});
server.listen(port, host, () => console.log(`Listening on ${host}:${port}`));
