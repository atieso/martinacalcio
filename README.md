# Martina Calcio – API-Football proxy per Render

Carica `server.js` e `package.json` nella radice di un repository GitHub. Non caricare l'API key nel repository.

## Configurazione Render
- New > Web Service > Git Provider: GitHub
- Name: `martina-api-football`
- Language: Node
- Branch: main
- Root Directory: vuoto
- Build Command: `npm install`
- Start Command: `npm start`
- Instance: Free per test, valutare piano a pagamento per produzione
- Health Check Path: `/health`
- Environment:
  - `API_FOOTBALL_KEY` = valore privato (secret)
  - `API_FOOTBALL_LEAGUE` = `433` (DA VERIFICARE)
  - `API_FOOTBALL_SEASON` = `2026`
  - `CACHE_SECONDS` = `3600`

## URL pubblici
- `/health` mostra `configured:true` se la chiave è presente
- `/standings` restituisce `standings` con le squadre, punti, forma, stemma

La disponibilità della classifica Serie D Girone H 2026/27 deve essere verificata dalla dashboard API-Football. Non pubblicare la chiave nel tema Shopify.

Nota: Shopify non è ancora collegato automaticamente a questo endpoint; serve integrare nella sezione Liquid/JS la chiamata all'URL pubblico restituito da Render.
