/**
 * Worker für handball-statistik-saas.
 *
 * Zuständig für:
 *  - /api/proxy: Login (Code -> Session-Token), Kader-Auslieferung,
 *    Sync-Upsert (spiele/aktionen/kader/kader_runde) gegen D1
 *  - alles andere: Weiterreichen an die statischen Assets (index.html, app.js, ...)
 *
 * Auswertung (pro Spielerin/Team, halbzeitfein), Aktionen-Abruf und der
 * vollständige CSV-Export (Datenhoheit des Kunden, Punkt 4 der
 * Architekturentscheidung) sind implementiert.
 *
 * Einmalig vor erstem Login nötig (siehe README-Abschnitt "D1 Setup"):
 *  1. Schema anwenden:  wrangler d1 execute handball-statistik-saas-db --remote --file=./d1-schema.sql
 *  2. Ersten Kunden + Zugangscodes anlegen (siehe seed.sql)
 */

const SESSION_TTL_TAGE = 180;

/* ---------- Statistik-Berechnung (identisch zur Logik aus apps-script.gs) ---------- */
const WURF_ZONEN = ['9m', '6m', 'Außen', 'Kreis', 'Konter', '7m'];
const BALLGEWINN = ['Techn. Fehler provoziert', 'Pass abgefangen', 'Rausprellen', 'Block'];
const FEHLER = ['Fehlpass', 'Schritte', 'Stürmerfoul', 'Kreisfehler', 'Doppeltipp', 'Ballverlust'];
const EINZEL = ['Assist', '7m geholt', '7m verursacht', '2min geholt', '2min verursacht'];

function emptyStats() {
  const s = {};
  WURF_ZONEN.forEach(function (z) { s[z + '_Versuche'] = 0; s[z + '_Erfolg'] = 0; });
  BALLGEWINN.forEach(function (k) { s[k] = 0; });
  FEHLER.forEach(function (k) { s[k] = 0; });
  EINZEL.forEach(function (k) { s[k] = 0; });
  return s;
}

// Erfolg = Treffer bei Feldspielerinnen, Parade bei Torhüterinnen (isTW).
function applyAktion(stats, aktionstyp, ergebnis, isTW) {
  if (WURF_ZONEN.indexOf(aktionstyp) !== -1) {
    const erfolgswert = isTW ? 'Parade' : 'Treffer';
    stats[aktionstyp + '_Versuche']++;
    if (ergebnis === erfolgswert) stats[aktionstyp + '_Erfolg']++;
    return;
  }
  if (Object.prototype.hasOwnProperty.call(stats, aktionstyp)) stats[aktionstyp]++;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function uid() {
  return crypto.randomUUID();
}

async function getSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT s.token, s.kunde_id, s.rolle, s.expires_at FROM sessions s WHERE s.token = ?'
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/* ---------- Login ---------- */
async function handleLogin(request, env) {
  const body = await request.json();
  const code = (body.code || '').trim();
  if (!code) return json({ error: 'Code fehlt' }, 400);

  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    'SELECT id, kunde_id, rolle, anzeige_name FROM zugangscodes WHERE code_hash = ? AND aktiv = 1'
  ).bind(codeHash).first();
  if (!row) return json({ error: 'Unbekannter Code' }, 401);

  const token = uid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_TAGE * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token, kunde_id, zugangscode_id, rolle, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(token, row.kunde_id, row.id, row.rolle, expiresAt).run();

  return json({ token: token, rolle: row.rolle, name: row.anzeige_name });
}

/* ---------- Kader (roster) ---------- */
async function handleRoster(request, env, session, runde) {
  const rows = await env.DB.prepare(
    `SELECT k.id AS SpielerinID, k.name AS Name, k.rueckennummer AS Rückennummer, k.position AS Position
     FROM kader k
     JOIN kader_runde kr ON kr.kader_id = k.id
     WHERE k.kunde_id = ? AND kr.kunde_id = ? AND kr.runde = ? AND kr.status = 'aktiv'`
  ).bind(session.kunde_id, session.kunde_id, runde || '').all();
  return json(rows.results || []);
}

async function handleSpieleListe(env, session) {
  const rows = await env.DB.prepare(
    'SELECT id AS SpielID, datum AS Datum, gegner AS Gegner, runde AS Runde, tore_eigene AS Tore_eigene, tore_gegner AS Tore_gegner, status AS Status FROM spiele WHERE kunde_id = ?'
  ).bind(session.kunde_id).all();
  return json(rows.results || []);
}

/* ---------- Sync (POST) ---------- */
async function handleSync(request, env, session) {
  const body = await request.json();
  const results = { spiele: [], aktionen: [], kader: [], kader_runde: [] };

  if (Array.isArray(body.spiele)) {
    for (const s of body.spiele) {
      await env.DB.prepare(
        `INSERT INTO spiele (id, kunde_id, datum, gegner, runde, tore_eigene, tore_gegner, status, aktive_spielerinnen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET datum=excluded.datum, gegner=excluded.gegner, runde=excluded.runde,
           tore_eigene=excluded.tore_eigene, tore_gegner=excluded.tore_gegner, status=excluded.status,
           aktive_spielerinnen=excluded.aktive_spielerinnen`
      ).bind(
        s.SpielID, session.kunde_id, s.Datum, s.Gegner, s.Runde,
        s.Tore_eigene === '' ? null : s.Tore_eigene,
        s.Tore_gegner === '' ? null : s.Tore_gegner,
        s.Status || '',
        JSON.stringify(s.AktiveSpielerinnen || [])
      ).run();
      results.spiele.push(s.SpielID);
    }
  }

  if (Array.isArray(body.aktionen)) {
    for (const a of body.aktionen) {
      await env.DB.prepare(
        `INSERT INTO aktionen (id, kunde_id, spiel_id, spielerin_id, halbzeit, aktionstyp, ergebnis, quelle, zeitstempel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind(
        a.AktionID, session.kunde_id, a.SpielID, a.SpielerinID, a.Halbzeit, a.Aktionstyp, a.Ergebnis, a.Quelle, a.Zeitstempel
      ).run();
      results.aktionen.push(a.AktionID);
    }
  }

  if (Array.isArray(body.kader)) {
    for (const k of body.kader) {
      try {
        await env.DB.prepare(
          `INSERT INTO kader (id, kunde_id, name, rueckennummer, position)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, rueckennummer=excluded.rueckennummer, position=excluded.position`
        ).bind(k.id, session.kunde_id, k.Name, k.Rückennummer || '', k.Position).run();
        results.kader.push(k.id);
      } catch (e) {
        // UNIQUE(kunde_id, name) verletzt -> Duplikat, bewusst NICHT bestätigt,
        // bleibt in der App als "nicht synchronisiert" sichtbar (siehe Kader-Screen).
      }
    }
  }

  if (Array.isArray(body.kader_runde)) {
    for (const r of body.kader_runde) {
      await env.DB.prepare(
        `INSERT INTO kader_runde (id, kunde_id, kader_id, runde, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status`
      ).bind(r.id, session.kunde_id, r.kader_id, r.Runde, r.Status).run();
      results.kader_runde.push(r.id);
    }
  }

  return json({ status: 'ok', results: results });
}

async function handleAktionenSpiel(env, session, spielId) {
  const rows = await env.DB.prepare(
    `SELECT id AS AktionID, spiel_id AS SpielID, spielerin_id AS SpielerinID, halbzeit AS Halbzeit,
            aktionstyp AS Aktionstyp, ergebnis AS Ergebnis, quelle AS Quelle, zeitstempel AS Zeitstempel
     FROM aktionen WHERE kunde_id = ? AND spiel_id = ?`
  ).bind(session.kunde_id, spielId).all();
  return json(rows.results || []);
}

/* Liefert die Aktionen für einen Zeitraum: entweder ein einzelnes Spiel
   (zeitraum = SpielID) oder eine ganze Runde (zeitraum = 'runde', runde-Name
   zusätzlich nötig -- fasst alle Spiele dieser Runde zusammen). */
async function ladeAktionenFuerZeitraum(env, session, zeitraum, runde) {
  if (zeitraum !== 'runde') {
    const rows = await env.DB.prepare(
      'SELECT spielerin_id, halbzeit, aktionstyp, ergebnis FROM aktionen WHERE kunde_id = ? AND spiel_id = ?'
    ).bind(session.kunde_id, zeitraum).all();
    return rows.results || [];
  }
  const spiele = await env.DB.prepare(
    'SELECT id FROM spiele WHERE kunde_id = ? AND runde = ?'
  ).bind(session.kunde_id, runde || '').all();
  const spielIds = (spiele.results || []).map(function (s) { return s.id; });
  if (!spielIds.length) return [];
  const platzhalter = spielIds.map(function () { return '?'; }).join(',');
  const rows = await env.DB.prepare(
    `SELECT spielerin_id, halbzeit, aktionstyp, ergebnis FROM aktionen WHERE kunde_id = ? AND spiel_id IN (${platzhalter})`
  ).bind(session.kunde_id, ...spielIds).all();
  return rows.results || [];
}

async function handleAuswertung(request, env, session, url) {
  const scope = url.searchParams.get('scope');
  const zeitraum = url.searchParams.get('zeitraum');
  const runde = url.searchParams.get('runde');
  if (!zeitraum) return json({ error: 'zeitraum fehlt' }, 400);

  const aktionen = await ladeAktionenFuerZeitraum(env, session, zeitraum, runde);

  if (scope === 'team') {
    const kader = await env.DB.prepare('SELECT id, position FROM kader WHERE kunde_id = ?').bind(session.kunde_id).all();
    const posById = {};
    (kader.results || []).forEach(function (k) { posById[k.id] = k.position; });

    const buckets = { Feld: { '1': emptyStats(), '2': emptyStats(), Gesamt: emptyStats() }, TW: { '1': emptyStats(), '2': emptyStats(), Gesamt: emptyStats() } };
    aktionen.forEach(function (a) {
      const pos = posById[a.spielerin_id] === 'TW' ? 'TW' : 'Feld';
      const hz = String(a.halbzeit) === '2' ? '2' : '1';
      applyAktion(buckets[pos][hz], a.aktionstyp, a.ergebnis, pos === 'TW');
      applyAktion(buckets[pos].Gesamt, a.aktionstyp, a.ergebnis, pos === 'TW');
    });
    return json({
      Feld: { HZ1: buckets.Feld['1'], HZ2: buckets.Feld['2'], Gesamt: buckets.Feld.Gesamt },
      TW: { HZ1: buckets.TW['1'], HZ2: buckets.TW['2'], Gesamt: buckets.TW.Gesamt }
    });
  }

  if (scope === 'spielerin') {
    const spielerinId = url.searchParams.get('spielerinId');
    if (!spielerinId) return json({ error: 'spielerinId fehlt' }, 400);
    const kaderRow = await env.DB.prepare('SELECT position FROM kader WHERE kunde_id = ? AND id = ?').bind(session.kunde_id, spielerinId).first();
    const isTW = kaderRow && kaderRow.position === 'TW';

    const buckets = { '1': emptyStats(), '2': emptyStats(), Gesamt: emptyStats() };
    aktionen.filter(function (a) { return a.spielerin_id === spielerinId; }).forEach(function (a) {
      const hz = String(a.halbzeit) === '2' ? '2' : '1';
      applyAktion(buckets[hz], a.aktionstyp, a.ergebnis, isTW);
      applyAktion(buckets.Gesamt, a.aktionstyp, a.ergebnis, isTW);
    });
    return json({ position: isTW ? 'TW' : 'Feld', HZ1: buckets['1'], HZ2: buckets['2'], Gesamt: buckets.Gesamt });
  }

  return json({ error: 'scope muss spielerin oder team sein' }, 400);
}
/* ---------- Vollständiger Datenexport (Datenhoheit, ersetzt "eigenes Google Sheet") ---------- */
async function handleExportAll(env, session) {
  if (session.rolle !== 'admin') return json({ error: 'Nur Admin darf den Komplettexport auslösen.' }, 403);

  const kader = await env.DB.prepare(
    'SELECT id AS SpielerinID, name AS Name, rueckennummer AS Rückennummer, position AS Position FROM kader WHERE kunde_id = ?'
  ).bind(session.kunde_id).all();
  const kaderRunde = await env.DB.prepare(
    'SELECT kader_id AS SpielerinID, runde AS Runde, status AS Status FROM kader_runde WHERE kunde_id = ?'
  ).bind(session.kunde_id).all();
  const spiele = await env.DB.prepare(
    'SELECT id AS SpielID, datum AS Datum, gegner AS Gegner, runde AS Runde, tore_eigene AS Tore_eigene, tore_gegner AS Tore_gegner, status AS Status FROM spiele WHERE kunde_id = ?'
  ).bind(session.kunde_id).all();
  const aktionen = await env.DB.prepare(
    'SELECT id AS AktionID, spiel_id AS SpielID, spielerin_id AS SpielerinID, halbzeit AS Halbzeit, aktionstyp AS Aktionstyp, ergebnis AS Ergebnis, quelle AS Quelle, zeitstempel AS Zeitstempel FROM aktionen WHERE kunde_id = ?'
  ).bind(session.kunde_id).all();

  return json({
    kader: kader.results || [],
    kader_runde: kaderRunde.results || [],
    spiele: spiele.results || [],
    aktionen: aktionen.results || []
  });
}

/* ---------- Router ---------- */
async function handleApi(request, env, url) {
  if (url.searchParams.get('action') === 'login' || (request.method === 'POST' && url.searchParams.get('action') === undefined && url.pathname.endsWith('/login'))) {
    // Login ist der einzige Endpunkt ohne Session.
  }

  const action = url.searchParams.get('action') || (request.method === 'POST' ? 'sync' : null);

  if (request.method === 'POST' && action === 'login') {
    return handleLogin(request, env);
  }

  const session = await getSession(env, bearerToken(request));
  if (!session) return json({ error: 'Nicht angemeldet oder Session abgelaufen' }, 401);

  if (request.method === 'GET' && action === 'roster') {
    return handleRoster(request, env, session, url.searchParams.get('runde'));
  }
  if (request.method === 'GET' && action === 'spiele') {
    return handleSpieleListe(env, session);
  }
  if (request.method === 'POST' && action === 'sync') {
    return handleSync(request, env, session);
  }

  if (request.method === 'GET' && action === 'aktionenSpiel') {
    const spielId = url.searchParams.get('spielId');
    if (!spielId) return json({ error: 'spielId fehlt' }, 400);
    return handleAktionenSpiel(env, session, spielId);
  }
  if (request.method === 'GET' && action === 'auswertung') {
    return handleAuswertung(request, env, session, url);
  }
  if (request.method === 'GET' && action === 'exportAll') {
    return handleExportAll(env, session);
  }

  return json({ error: 'Unbekannte Aktion: ' + action }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/proxy') {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: 'Serverfehler: ' + e.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
