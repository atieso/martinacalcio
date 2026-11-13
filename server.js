import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const host = '0.0.0.0';
const apiKey = process.env.API_FOOTBALL_KEY;
const league = process.env.API_FOOTBALL_LEAGUE || '433';
const season = process.env.API_FOOTBALL_SEASON || '2026';
const teamId = process.env.API_FOOTBALL_TEAM || '19975';
const ttlMs = Math.max(300, Number(process.env.CACHE_SECONDS || 3600)) * 1000;
const cache = new Map();

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=60',
    'access-control-allow-origin': '*',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function normalizeSplit(split) {
  if (!split) return null;
  return {
    played: split.played ?? null,
    win: split.win ?? null,
    draw: split.draw ?? null,
    lose: split.lose ?? null,
    goalsFor: split.goals?.for ?? null,
    goalsAgainst: split.goals?.against ?? null
  };
}

async function football(endpoint, params = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: { 'x-apisports-key': apiKey },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`API-Football HTTP ${response.status} (${endpoint})`);
    const raw = await response.json();
    if (raw.errors && (Array.isArray(raw.errors) ? raw.errors.length : Object.keys(raw.errors).length)) {
      throw new Error(`API-Football error (${endpoint}): ${JSON.stringify(raw.errors)}`);
    }
    return raw.response ?? [];
  } finally {
    clearTimeout(timeout);
  }
}

async function cached(key, ttl, producer) {
  const existing = cache.get(key);
  if (existing && Date.now() - existing.at < ttl) return { data: existing.data, cached: true };
  try {
    const data = await producer();
    cache.set(key, { at: Date.now(), data });
    return { data, cached: false };
  } catch (error) {
    if (existing) return { data: { ...existing.data, stale: true }, cached: true };
    throw error;
  }
}

async function getStandings() {
  return cached('standings', ttlMs, async () => {
    const response = await football('standings', { league, season });
    const groups = response?.[0]?.league?.standings;
    if (!Array.isArray(groups) || !groups.length) throw new Error('No standings for league and season');
    const standings = groups.flat().map(row => ({
      position: row.rank,
      team: row.team?.name || '',
      teamId: row.team?.id ?? null,
      logo: row.team?.logo || '',
      points: row.points,
      played: row.all?.played ?? null,
      win: row.all?.win ?? null,
      draw: row.all?.draw ?? null,
      lose: row.all?.lose ?? null,
      goalsFor: row.all?.goals?.for ?? null,
      goalsAgainst: row.all?.goals?.against ?? null,
      goalDifference: row.goalsDiff ?? null,
      form: row.form || '',
      group: row.group || '',
      home: normalizeSplit(row.home),
      away: normalizeSplit(row.away)
    }));
    return { league, season, updatedAt: new Date().toISOString(), standings };
  });
}

function compactFixture(item) {
  return {
    id: item.fixture?.id ?? null,
    date: item.fixture?.date ?? null,
    timestamp: item.fixture?.timestamp ?? null,
    status: item.fixture?.status?.short ?? null,
    statusLong: item.fixture?.status?.long ?? null,
    venue: item.fixture?.venue?.name ?? null,
    round: item.league?.round ?? null,
    home: {
      id: item.teams?.home?.id ?? null,
      name: item.teams?.home?.name ?? null,
      logo: item.teams?.home?.logo ?? null
    },
    away: {
      id: item.teams?.away?.id ?? null,
      name: item.teams?.away?.name ?? null,
      logo: item.teams?.away?.logo ?? null
    },
    goals: item.goals ?? null,
    score: item.score ?? null
  };
}

async function getMatchDetails(fixtureId, date) {
  const key = fixtureId ? `match:fixture:${fixtureId}` : `match:date:${date}`;
  return cached(key, 15 * 60 * 1000, async () => {
    let fixture;
    if (fixtureId) {
      const found = await football('fixtures', { id: fixtureId });
      fixture = found[0];
    } else {
      const found = await football('fixtures', { league, season, team: teamId, date });
      // A date can contain more than one fixture. Prefer a fixture involving our team.
      fixture = found.find(f => String(f.teams?.home?.id) === String(teamId) || String(f.teams?.away?.id) === String(teamId));
    }
    if (!fixture?.fixture?.id) {
      return { found: false, league, season, teamId, date: date || null, events: [], lineups: [] };
    }
    const id = fixture.fixture.id;
    const [eventsResult, lineupsResult] = await Promise.allSettled([
      football('fixtures/events', { fixture: id }),
      football('fixtures/lineups', { fixture: id })
    ]);
    return {
      found: true,
      league,
      season,
      fixture: compactFixture(fixture),
      fixtureId: id,
      events: eventsResult.status === 'fulfilled' ? eventsResult.value : [],
      lineups: lineupsResult.status === 'fulfilled' ? lineupsResult.value : [],
      availability: {
        events: eventsResult.status === 'fulfilled',
        lineups: lineupsResult.status === 'fulfilled'
      },
      updatedAt: new Date().toISOString()
    };
  });
}

// A single, cached request for all Martina fixtures. No player-level data is needed.
async function getTeamFixtures() {
  return cached('team-fixtures', 15 * 60 * 1000, async () => {
    const response = await football('fixtures', { league, season, team: teamId });
    return {
      league, season, teamId: Number(teamId), updatedAt: new Date().toISOString(),
      fixtures: response.map(compactFixture).filter(f => f.id && f.date)
    };
  });
}

// Goal scorers are derived from actual goal events only. Incomplete coverage is reported.
async function getTeamGoals() {
  return cached('team-goals', 6 * 3600 * 1000, async () => {
    const {data:fixtureData}=await getTeamFixtures();
    const finished=fixtureData.fixtures.filter(f=>['FT','AET','PEN'].includes(f.status));
    const goals=new Map();let checked=0,failed=0,missingEvents=0;
    // Concurrency bounded to avoid API rate spikes. Do not infer undocumented events.
    for(let offset=0;offset<finished.length;offset+=3){
      const batch=finished.slice(offset,offset+3);
      const responses=await Promise.allSettled(batch.map(f=>football('fixtures/events',{fixture:f.id})));
      for(let j=0;j<batch.length;j++){
        const result=responses[j],f=batch[j];
        if(result.status!=='fulfilled'){failed++;continue;}
        checked++;
        const events=result.value;
        if(!events.length){missingEvents++;continue;}
        for(const e of events){
          if(Number(e.team?.id)!==Number(teamId)||e.type!=='Goal')continue;
          const detail=String(e.detail||'').toLowerCase();
          // Own goals by a Martina player are scored for the opponent, not for Martina.
          if(detail.includes('own goal'))continue;
          const id=e.player?.id;
          const name=e.player?.name;
          if(!id&&!name)continue;
          const key=id?'id:'+id:'name:'+name.toLowerCase();
          const item=goals.get(key)||{id:id||null,name:name||'',goals:0,fixtures:[]};
          item.goals++;item.fixtures.push({fixtureId:f.id,minute:e.time?.elapsed??null,detail:e.detail||''});
          goals.set(key,item);
        }
      }
    }
    return {league,season,teamId:Number(teamId),updatedAt:new Date().toISOString(),
      totalFinishedFixtures:finished.length,checkedFixtures:checked,failedFixtures:failed,fixturesWithoutEvents:missingEvents,
      complete:failed===0&&missingEvents===0,
      scorers:[...goals.values()].sort((a,b)=>b.goals-a.goals||a.name.localeCompare(b.name))};
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (pathname === '/health') return send(res, 200, {
    ok: true, configured: Boolean(apiKey), available: ['/health', '/standings', '/match-details', '/team-fixtures', '/team-goals']
  }, { 'cache-control': 'no-store' });
  if (!['/standings', '/match-details', '/team-fixtures', '/team-goals'].includes(pathname)) {
    return send(res, 404, { error: 'Not found', available: ['/health', '/standings', '/match-details', '/team-fixtures', '/team-goals'] });
  }
  if (!apiKey) return send(res, 503, { error: 'API_FOOTBALL_KEY not configured' }, { 'cache-control': 'no-store' });

  if (pathname === '/team-goals') {
    try {
      const result=await getTeamGoals();
      return send(res,200,{...result.data,cached:result.cached});
    } catch(error){
      console.error('Team goals lookup failed:',error.message);
      return send(res,502,{error:'Marcatori temporaneamente non disponibili'},{'cache-control':'no-store'});
    }
  }

  if (pathname === '/team-fixtures') {
    try {
      const result = await getTeamFixtures();
      return send(res, 200, { ...result.data, cached: result.cached });
    } catch (error) {
      console.error('Team fixtures lookup failed:', error.message);
      return send(res, 502, { error: 'Calendario Martina temporaneamente non disponibile' }, { 'cache-control': 'no-store' });
    }
  }

  if (pathname === '/match-details') {
    const fixture = url.searchParams.get('fixture');
    const date = url.searchParams.get('date');
    if (!fixture && !date) return send(res, 400, {
      error: 'Indicare fixture=ID oppure date=YYYY-MM-DD',
      examples: ['/match-details?date=2026-11-08', '/match-details?fixture=1234567']
    }, { 'cache-control': 'no-store' });
    if (fixture && !/^\d+$/.test(fixture)) return send(res, 400, { error: 'fixture deve essere numerico' }, { 'cache-control': 'no-store' });
    if (!fixture && !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return send(res, 400, { error: 'date deve essere YYYY-MM-DD' }, { 'cache-control': 'no-store' });
    try {
      const result = await getMatchDetails(fixture, date);
      return send(res, 200, { ...result.data, cached: result.cached });
    } catch (error) {
      console.error('Match details lookup failed:', error.message);
      return send(res, 502, { error: 'Dati partita temporaneamente non disponibili' }, { 'cache-control': 'no-store' });
    }
  }

  try {
    const result = await getStandings();
    return send(res, 200, { ...result.data, cached: result.cached });
  } catch (error) {
    console.error('Standings lookup failed:', error.message);
    return send(res, 502, { error: 'Classifica non disponibile. Verificare ID lega, stagione e copertura del piano.' }, { 'cache-control': 'no-store' });
  }
});

server.listen(port, host, () => console.log(`Listening on ${host}:${port}`));
