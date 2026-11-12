import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const host = '0.0.0.0';
const apiKey = process.env.API_FOOTBALL_KEY;
const league = process.env.API_FOOTBALL_LEAGUE || '433';
const season = process.env.API_FOOTBALL_SEASON || '2026';
const teamId = Number(process.env.API_FOOTBALL_TEAM || '19975');
const ttlMs = Math.max(300, Number(process.env.CACHE_SECONDS || 3600)) * 1000;
const standingsCache = {at:0, data:null};
const fixturesCache = {at:0, data:null};
const matchCache = new Map();

function send(res,status,body,headers={}) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'public, max-age=60', 'access-control-allow-origin':'*', ...headers});
  res.end(JSON.stringify(body));
}
async function apiGet(path,params) {
  const url=new URL(`https://v3.football.api-sports.io${path}`);
  for(const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(url,{headers:{'x-apisports-key':apiKey},signal:controller.signal});
    if(!response.ok) throw new Error(`API-Football HTTP ${response.status}`);
    const raw=await response.json();
    if(raw.errors && (Array.isArray(raw.errors)?raw.errors.length:Object.keys(raw.errors).length)) throw new Error('API-Football returned an error');
    return raw;
  } finally {clearTimeout(timer);}
}
function splitStats(split) {
  if(!split) return null;
  return {played:split.played??null,win:split.win??null,draw:split.draw??null,lose:split.lose??null,goalsFor:split.goals?.for??null,goalsAgainst:split.goals?.against??null};
}
async function getStandings() {
  if(standingsCache.data && Date.now()-standingsCache.at<ttlMs) return {...standingsCache.data,cached:true};
  const raw=await apiGet('/standings',{league,season});
  const groups=raw.response?.[0]?.league?.standings;
  if(!Array.isArray(groups)||!groups.length) throw new Error('No standings returned');
  const standings=groups.flat().map(row=>({
    position:row.rank,team:row.team?.name||'',teamId:row.team?.id||null,logo:row.team?.logo||'',
    points:row.points,played:row.all?.played??null,win:row.all?.win??null,draw:row.all?.draw??null,lose:row.all?.lose??null,
    goalsFor:row.all?.goals?.for??null,goalsAgainst:row.all?.goals?.against??null,goalDifference:row.goalsDiff??null,
    form:row.form||'',group:row.group||'',home:splitStats(row.home),away:splitStats(row.away)
  }));
  const data={league,season,updatedAt:new Date().toISOString(),standings};
  Object.assign(standingsCache,{at:Date.now(),data});
  return {...data,cached:false};
}
function normalizeFixture(item) {
  const f=item.fixture||{},teams=item.teams||{},goals=item.goals||{},lg=item.league||{};
  return {
    id:f.id??null,date:f.date||null,timestamp:f.timestamp??null,round:lg.round||'Giornata non assegnata',
    status:f.status?.short||'NS',statusLong:f.status?.long||'',elapsed:f.status?.elapsed??null,venue:f.venue?.name||'',
    home:{id:teams.home?.id??null,name:teams.home?.name||'',logo:teams.home?.logo||''},
    away:{id:teams.away?.id??null,name:teams.away?.name||'',logo:teams.away?.logo||''},
    goals:{home:goals.home??null,away:goals.away??null}
  };
}
async function getFixtures() {
  if(fixturesCache.data && Date.now()-fixturesCache.at<ttlMs) return {...fixturesCache.data,cached:true};
  const raw=await apiGet('/fixtures',{league,season,timezone:'Europe/Rome'});
  if(!Array.isArray(raw.response)||!raw.response.length) throw new Error('No fixtures returned');
  const fixtures=raw.response.map(normalizeFixture).sort((a,b)=>(a.timestamp??0)-(b.timestamp??0));
  const rounds=[...new Set(fixtures.map(x=>x.round))];
  const roundNumber=s=>{const n=String(s).match(/(?:regular season|giornata|matchday|round)\s*[-:]?\s*(\d+)/i);return n?Number(n[1]):Infinity;};
  rounds.sort((a,b)=>roundNumber(a)-roundNumber(b)||a.localeCompare(b,'it',{numeric:true}));
  const data={league,season,updatedAt:new Date().toISOString(),rounds,fixtures};
  Object.assign(fixturesCache,{at:Date.now(),data});
  return {...data,cached:false};
}
function normalizeLineup(item) {
  const people=arr=>Array.isArray(arr)?arr.map(x=>({id:x.player?.id??null,name:x.player?.name||'',number:x.player?.number??null,pos:x.player?.pos||'',grid:x.player?.grid||''})).filter(x=>x.name):[];
  return {teamId:item.team?.id??null,team:item.team?.name||'',logo:item.team?.logo||'',formation:item.formation||'',coach:item.coach?.name||'',starters:people(item.startXI),substitutes:people(item.substitutes)};
}
function normalizeEvent(item) {
  return {minute:item.time?.elapsed??null,extra:item.time?.extra??null,teamId:item.team?.id??null,
    team:item.team?.name||'',type:item.type||'',detail:item.detail||'',player:item.player?.name||'',assist:item.assist?.name||'',comments:item.comments||''};
}
function isMartinaFixture(item) {
  return Number(item.teams?.home?.id)===teamId || Number(item.teams?.away?.id)===teamId;
}
async function getMatchDetails({fixtureId,date}) {
  const cacheKey=fixtureId?`id:${fixtureId}`:`date:${date}`;
  const stored=matchCache.get(cacheKey);
  if(stored && Date.now()-stored.at<ttlMs) return {...stored.data,cached:true};
  let fixture;
  if(fixtureId) {
    const raw=await apiGet('/fixtures',{id:fixtureId});
    fixture=raw.response?.[0];
  } else {
    const raw=await apiGet('/fixtures',{league,season,team:teamId,date,timezone:'Europe/Rome'});
    fixture=raw.response?.find(isMartinaFixture);
  }
  if(!fixture) return {league,season,found:false,reason:'Partita non trovata nel provider',events:[],lineups:[]};
  if(Number(fixture.league?.id)!==Number(league) || Number(fixture.league?.season)!==Number(season) || !isMartinaFixture(fixture)) {
    return {league,season,found:false,reason:'Partita fuori dal campionato Martina configurato',events:[],lineups:[]};
  }
  const id=fixture.fixture?.id;
  const [eventsResult,lineupsResult]=await Promise.allSettled([
    apiGet('/fixtures/events',{fixture:id}),apiGet('/fixtures/lineups',{fixture:id})
  ]);
  const events=eventsResult.status==='fulfilled' && Array.isArray(eventsResult.value.response)
    ?eventsResult.value.response.map(normalizeEvent):[];
  const lineups=lineupsResult.status==='fulfilled' && Array.isArray(lineupsResult.value.response)
    ?lineupsResult.value.response.map(normalizeLineup):[];
  const data={league,season,found:true,fixture:normalizeFixture(fixture),events,lineups,
    coverage:{events:eventsResult.status==='fulfilled',lineups:lineupsResult.status==='fulfilled'},
    updatedAt:new Date().toISOString()};
  matchCache.set(cacheKey,{at:Date.now(),data});
  if(matchCache.size>150) matchCache.delete(matchCache.keys().next().value);
  return {...data,cached:false};
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url||'/','http://localhost');
  const path=url.pathname;
  if(req.method!=='GET') return send(res,405,{error:'Method not allowed'});
  if(path==='/health') return send(res,200,{ok:true,configured:Boolean(apiKey)},{'cache-control':'no-store'});
  if(!['/standings','/fixtures','/match-details'].includes(path)) return send(res,404,{error:'Not found',available:['/health','/standings','/fixtures','/match-details']});
  if(!apiKey) return send(res,503,{error:'API_FOOTBALL_KEY not configured'},{'cache-control':'no-store'});
  const fixtureId=url.searchParams.get('fixture');
  const date=url.searchParams.get('date');
  if(path==='/match-details' && !((fixtureId && /^\d{1,12}$/.test(fixtureId)) || (date && /^20\d{2}-\d{2}-\d{2}$/.test(date)))) {
    return send(res,400,{error:'Indicare fixture=ID oppure date=YYYY-MM-DD'},{'cache-control':'no-store'});
  }
  try {
    if(path==='/standings') return send(res,200,await getStandings());
    if(path==='/fixtures') return send(res,200,await getFixtures());
    return send(res,200,await getMatchDetails({fixtureId,date}));
  } catch(e) {
    console.error('Martina API lookup failed:',path,e.message);
    const old=path==='/standings'?standingsCache.data:path==='/fixtures'?fixturesCache.data:matchCache.get(fixtureId?`id:${fixtureId}`:`date:${date}`)?.data;
    if(old) return send(res,200,{...old,cached:true,stale:true});
    return send(res,502,{error:'Dati temporaneamente non disponibili'},{'cache-control':'no-store'});
  }
});
server.listen(port,host,()=>console.log(`Listening on ${host}:${port}`));
