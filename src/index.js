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

import { analysiereBericht, kontrolliereBericht, berechneAbgleich, kaderMatcher, normName, SEGMENT_NAMEN } from './bericht.js';

const SESSION_TTL_TAGE = 180;

/* ---------- Statistik-Berechnung (identisch zur Logik aus apps-script.gs) ---------- */
const WURF_ZONEN = ['9m', '6m', 'Außen', 'Kreis', 'Konter', '7m'];
const BALLGEWINN = ['Techn. Fehler provoziert', 'Pass abgefangen', 'Rausprellen', 'Block'];
const FEHLER = ['Fehlpass', 'Schritte', 'Stürmerfoul', 'Kreisfehler', 'Doppeltipp', 'Ballverlust', 'TF'];
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
    'SELECT s.token, s.mannschaft_id, s.zugangscode_id, s.rolle, s.expires_at FROM sessions s WHERE s.token = ?'
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
  const vereinSlug = (body.vereinSlug || '').trim();
  const mannschaftSlug = (body.mannschaftSlug || '').trim();
  if (!vereinSlug || !mannschaftSlug) return json({ error: 'Kein Vereins-/Mannschafts-Link erkannt.' }, 400);
  if (!code) return json({ error: 'Code fehlt' }, 400);

  const mannschaft = await env.DB.prepare(
    `SELECT m.id FROM mannschaften m JOIN vereine v ON v.id = m.verein_id
     WHERE v.slug = ? AND m.slug = ?`
  ).bind(vereinSlug, mannschaftSlug).first();
  if (!mannschaft) return json({ error: 'Unbekannter Vereins-/Mannschafts-Link.' }, 404);

  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    'SELECT id, mannschaft_id, rolle, anzeige_name FROM zugangscodes WHERE mannschaft_id = ? AND code_hash = ? AND aktiv = 1'
  ).bind(mannschaft.id, codeHash).first();
  if (!row) return json({ error: 'Unbekannter Code' }, 401);

  const token = uid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_TAGE * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token, mannschaft_id, zugangscode_id, rolle, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(token, row.mannschaft_id, row.id, row.rolle, expiresAt).run();

  return json({ token: token, rolle: row.rolle, name: row.anzeige_name });
}

/* ---------- Kader (roster) ---------- */
async function handleRoster(request, env, session, runde) {
  const rows = await env.DB.prepare(
    `SELECT k.id AS SpielerinID, k.name AS Name, k.rueckennummer AS Rückennummer, k.position AS Position
     FROM kader k
     JOIN kader_runde kr ON kr.kader_id = k.id
     WHERE k.mannschaft_id = ? AND kr.mannschaft_id = ? AND kr.runde = ? AND kr.status = 'aktiv'`
  ).bind(session.mannschaft_id, session.mannschaft_id, runde || '').all();
  return json(rows.results || []);
}

async function handleSpieleListe(env, session) {
  const rows = await env.DB.prepare(
    'SELECT id AS SpielID, datum AS Datum, gegner AS Gegner, runde AS Runde, tore_eigene AS Tore_eigene, tore_gegner AS Tore_gegner, status AS Status FROM spiele WHERE mannschaft_id = ?'
  ).bind(session.mannschaft_id).all();
  return json(rows.results || []);
}

/* ---------- Sync (POST) ---------- */
async function handleSync(request, env, session) {
  const body = await request.json();
  const results = { spiele: [], aktionen: [], kader: [], kader_runde: [], kader_remap: {} };
  const fehler = [];

  // Reihenfolge wegen Fremdschlüsseln: Kader -> Kader-Runde -> Spiele -> Aktionen
  if (Array.isArray(body.kader)) {
    for (const k of body.kader) {
      try {
        await env.DB.prepare(
          `INSERT INTO kader (id, mannschaft_id, name, rueckennummer, position)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, rueckennummer=excluded.rueckennummer, position=excluded.position`
        ).bind(k.id, session.mannschaft_id, k.Name, k.Rückennummer || '', k.Position).run();
        results.kader.push(k.id);
      } catch (e) {
        // UNIQUE(mannschaft_id, name) verletzt: Es gibt schon eine Spielerin mit diesem Namen
        // (z. B. von anderem Gerät). Diese bestehende Zeile wird übernommen und dem Client
        // ihre ID zurückgemeldet (kader_remap), statt den Sync scheitern zu lassen.
        const vorhanden = await env.DB.prepare('SELECT id FROM kader WHERE mannschaft_id = ? AND name = ?')
          .bind(session.mannschaft_id, k.Name).first();
        if (vorhanden) {
          await env.DB.prepare('UPDATE kader SET rueckennummer = ?, position = ? WHERE id = ? AND mannschaft_id = ?')
            .bind(k.Rückennummer || '', k.Position, vorhanden.id, session.mannschaft_id).run();
          results.kader_remap[k.id] = vorhanden.id;
        } else {
          fehler.push('Kader "' + k.Name + '": ' + e.message);
        }
      }
    }
  }

  if (Array.isArray(body.kader_runde)) {
    for (const r of body.kader_runde) {
      const kaderId = results.kader_remap[r.kader_id] || r.kader_id;
      try {
        const vorhanden = await env.DB.prepare(
          'SELECT id FROM kader_runde WHERE mannschaft_id = ? AND kader_id = ? AND runde = ?'
        ).bind(session.mannschaft_id, kaderId, r.Runde).first();
        if (vorhanden && vorhanden.id !== r.id) {
          // Es gibt schon einen Eintrag für diese Spielerin+Runde -> nur Status übernehmen.
          await env.DB.prepare('UPDATE kader_runde SET status = ? WHERE id = ? AND mannschaft_id = ?')
            .bind(r.Status, vorhanden.id, session.mannschaft_id).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO kader_runde (id, mannschaft_id, kader_id, runde, status)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status`
          ).bind(r.id, session.mannschaft_id, kaderId, r.Runde, r.Status).run();
        }
        results.kader_runde.push(r.id);
      } catch (e) {
        fehler.push('Kader-Runde: ' + e.message);
      }
    }
  }

  if (Array.isArray(body.spiele)) {
    for (const s of body.spiele) {
      await env.DB.prepare(
        `INSERT INTO spiele (id, mannschaft_id, datum, gegner, runde, tore_eigene, tore_gegner, status, aktive_spielerinnen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET datum=excluded.datum, gegner=excluded.gegner, runde=excluded.runde,
           tore_eigene=excluded.tore_eigene, tore_gegner=excluded.tore_gegner, status=excluded.status,
           aktive_spielerinnen=excluded.aktive_spielerinnen`
      ).bind(
        s.SpielID, session.mannschaft_id, s.Datum, s.Gegner, s.Runde,
        s.Tore_eigene === '' ? null : s.Tore_eigene,
        s.Tore_gegner === '' ? null : s.Tore_gegner,
        s.Status || '',
        JSON.stringify(s.AktiveSpielerinnen || [])
      ).run();
      results.spiele.push(s.SpielID);
    }
  }

  if (Array.isArray(body.aktionen)) {
    // Hat das Spiel einen Spielbericht, kommen "2min verursacht" ausschließlich daraus --
    // spät synchronisierte Tablet-Einträge werden bestätigt, aber nicht gespeichert (sonst doppelt).
    await stelleSpielberichtSchemaSicher(env);
    const berichtSpiele = {};
    for (const a of body.aktionen) {
      if (a.Aktionstyp !== '2min verursacht' || berichtSpiele[a.SpielID] !== undefined) continue;
      const hat = await env.DB.prepare('SELECT 1 AS x FROM spielbericht WHERE spiel_id = ? AND mannschaft_id = ?')
        .bind(a.SpielID, session.mannschaft_id).first();
      berichtSpiele[a.SpielID] = !!hat;
    }
    for (const a of body.aktionen) {
      if (a.Aktionstyp === '2min verursacht' && berichtSpiele[a.SpielID]) {
        results.aktionen.push(a.AktionID);
        continue;
      }
      await env.DB.prepare(
        `INSERT INTO aktionen (id, mannschaft_id, spiel_id, spielerin_id, halbzeit, aktionstyp, ergebnis, quelle, zeitstempel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind(
        a.AktionID, session.mannschaft_id, a.SpielID, a.SpielerinID, a.Halbzeit, a.Aktionstyp, a.Ergebnis, a.Quelle, a.Zeitstempel
      ).run();
      results.aktionen.push(a.AktionID);
    }
  }

  return json({ status: 'ok', results: results, fehler: fehler });
}

async function handleAktionenSpiel(env, session, spielId) {
  const rows = await env.DB.prepare(
    `SELECT id AS AktionID, spiel_id AS SpielID, spielerin_id AS SpielerinID, halbzeit AS Halbzeit,
            aktionstyp AS Aktionstyp, ergebnis AS Ergebnis, quelle AS Quelle, zeitstempel AS Zeitstempel
     FROM aktionen WHERE mannschaft_id = ? AND spiel_id = ?`
  ).bind(session.mannschaft_id, spielId).all();
  return json(rows.results || []);
}

/* Liefert die Aktionen für einen Zeitraum: entweder ein einzelnes Spiel
   (zeitraum = SpielID) oder eine ganze Runde (zeitraum = 'runde', runde-Name
   zusätzlich nötig -- fasst alle Spiele dieser Runde zusammen). */
async function ladeAktionenFuerZeitraum(env, session, zeitraum, runde) {
  if (zeitraum !== 'runde') {
    const rows = await env.DB.prepare(
      'SELECT spielerin_id, halbzeit, aktionstyp, ergebnis FROM aktionen WHERE mannschaft_id = ? AND spiel_id = ?'
    ).bind(session.mannschaft_id, zeitraum).all();
    return rows.results || [];
  }
  const spiele = await env.DB.prepare(
    'SELECT id FROM spiele WHERE mannschaft_id = ? AND runde = ?'
  ).bind(session.mannschaft_id, runde || '').all();
  const spielIds = (spiele.results || []).map(function (s) { return s.id; });
  if (!spielIds.length) return [];
  const platzhalter = spielIds.map(function () { return '?'; }).join(',');
  const rows = await env.DB.prepare(
    `SELECT spielerin_id, halbzeit, aktionstyp, ergebnis FROM aktionen WHERE mannschaft_id = ? AND spiel_id IN (${platzhalter})`
  ).bind(session.mannschaft_id, ...spielIds).all();
  return rows.results || [];
}

async function handleAuswertung(request, env, session, url) {
  const scope = url.searchParams.get('scope');
  const zeitraum = url.searchParams.get('zeitraum');
  const runde = url.searchParams.get('runde');
  if (!zeitraum) return json({ error: 'zeitraum fehlt' }, 400);

  const aktionen = await ladeAktionenFuerZeitraum(env, session, zeitraum, runde);

  if (scope === 'team') {
    const kader = await env.DB.prepare('SELECT id, position FROM kader WHERE mannschaft_id = ?').bind(session.mannschaft_id).all();
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
    const kaderRow = await env.DB.prepare('SELECT position FROM kader WHERE mannschaft_id = ? AND id = ?').bind(session.mannschaft_id, spielerinId).first();
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
    'SELECT id AS SpielerinID, name AS Name, rueckennummer AS Rückennummer, position AS Position FROM kader WHERE mannschaft_id = ?'
  ).bind(session.mannschaft_id).all();
  const kaderRunde = await env.DB.prepare(
    'SELECT kader_id AS SpielerinID, runde AS Runde, status AS Status FROM kader_runde WHERE mannschaft_id = ?'
  ).bind(session.mannschaft_id).all();
  const spiele = await env.DB.prepare(
    'SELECT id AS SpielID, datum AS Datum, gegner AS Gegner, runde AS Runde, tore_eigene AS Tore_eigene, tore_gegner AS Tore_gegner, status AS Status FROM spiele WHERE mannschaft_id = ?'
  ).bind(session.mannschaft_id).all();
  const aktionen = await env.DB.prepare(
    'SELECT id AS AktionID, spiel_id AS SpielID, spielerin_id AS SpielerinID, halbzeit AS Halbzeit, aktionstyp AS Aktionstyp, ergebnis AS Ergebnis, quelle AS Quelle, zeitstempel AS Zeitstempel FROM aktionen WHERE mannschaft_id = ?'
  ).bind(session.mannschaft_id).all();

  await stelleSpielberichtSchemaSicher(env);
  const berichte = await env.DB.prepare('SELECT spiel_id, daten FROM spielbericht WHERE mannschaft_id = ?')
    .bind(session.mannschaft_id).all();
  const berichtEreignisse = [];
  (berichte.results || []).forEach(function (b) {
    const d = JSON.parse(b.daten);
    (d.events || []).forEach(function (e) {
      berichtEreignisse.push({ SpielID: b.spiel_id, Eigene_Seite: d.own, Sekunden: e.t, Team: e.team, Typ: e.typ, Nr: e.nr || '', Name: e.name || '' });
    });
  });

  return json({
    kader: kader.results || [],
    kader_runde: kaderRunde.results || [],
    spiele: spiele.results || [],
    aktionen: aktionen.results || [],
    spielbericht_ereignisse: berichtEreignisse
  });
}

/* ---------- Spielbericht (PDF "Acta Completa", vom Client eingelesen) ----------
 * Gespeichert wird nur der eigene Spielverlauf-Ausschnitt (Ereignisse, Personen nur der
 * eigenen Mannschaft). Tabelle wird beim ersten Zugriff automatisch angelegt, damit keine
 * manuelle Migration nötig ist (steht zusätzlich in d1-schema.sql).
 */
let spielberichtSchemaBereit = false;
async function stelleSpielberichtSchemaSicher(env) {
  if (spielberichtSchemaBereit) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS spielbericht (
       spiel_id TEXT PRIMARY KEY,
       mannschaft_id INTEGER NOT NULL REFERENCES mannschaften(id),
       daten TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_spielbericht_mannschaft ON spielbericht(mannschaft_id)').run();
  spielberichtSchemaBereit = true;
}

const BERICHT_TYPEN = ['tor', 'tor7', 'fehl7', 'zwei', 'gelb', 'rot', 'auszeit'];

async function handleSpielberichtSpeichern(request, env, session) {
  if (session.rolle !== 'admin') return json({ error: 'Nur Admin darf Spielberichte hochladen.' }, 403);
  await stelleSpielberichtSchemaSicher(env);
  const body = await request.json();
  const spielId = body.spielId;
  const own = body.own === 'Gast' ? 'Gast' : (body.own === 'Heim' ? 'Heim' : null);
  if (!spielId || !own || !Array.isArray(body.events) || !body.events.length) {
    return json({ error: 'spielId, own und events sind nötig.' }, 400);
  }
  const spiel = await env.DB.prepare('SELECT id FROM spiele WHERE id = ? AND mannschaft_id = ?')
    .bind(spielId, session.mannschaft_id).first();
  if (!spiel) return json({ error: 'Spiel nicht gefunden – ist es schon synchronisiert?' }, 404);

  // Defensiv bereinigen: nur bekannte Typen, Personen nur für die eigene Mannschaft
  const events = [];
  for (const e of body.events) {
    if (BERICHT_TYPEN.indexOf(e.typ) === -1 || (e.team !== 'Heim' && e.team !== 'Gast')) continue;
    const t = Number(e.t);
    if (!(t >= 0 && t <= 7200)) continue;
    const ev = { t: t, team: e.team, typ: e.typ };
    if (e.team === own) { ev.nr = String(e.nr || '').slice(0, 4); ev.name = String(e.name || '').slice(0, 80); }
    events.push(ev);
  }
  const m = body.meta || {};
  const meta = {
    spielnummer: String(m.spielnummer || '').slice(0, 40), datum: String(m.datum || '').slice(0, 10),
    heim: String(m.heim || '').slice(0, 80), gast: String(m.gast || '').slice(0, 80),
    endstand: Array.isArray(m.endstand) ? m.endstand.map(Number) : null,
    halbzeit: Array.isArray(m.halbzeit) ? m.halbzeit.map(Number) : null
  };
  await env.DB.prepare(
    `INSERT INTO spielbericht (spiel_id, mannschaft_id, daten) VALUES (?, ?, ?)
     ON CONFLICT(spiel_id) DO UPDATE SET daten = excluded.daten, created_at = datetime('now')`
  ).bind(spielId, session.mannschaft_id, JSON.stringify({ own: own, meta: meta, events: events })).run();

  const zwei = await uebernehme2MinAusBericht(env, session, spielId, own, events);
  return json({ status: 'ok', ereignisse: events.length, zweiUebernommen: zwei.uebernommen, zweiUebersprungen: zwei.uebersprungen });
}

/* "2min verursacht" kommt 1:1 aus dem Spielbericht: erfasste Einträge dieses Spiels werden ersetzt
   durch die Zeitstrafen der eigenen Spielerinnen laut Bericht (Quelle "Spielbericht"). */
async function uebernehme2MinAusBericht(env, session, spielId, own, events) {
  const kader = (await env.DB.prepare('SELECT id, name, rueckennummer FROM kader WHERE mannschaft_id = ?')
    .bind(session.mannschaft_id).all()).results || [];
  const nachName = {}, nachNr = {};
  kader.forEach(function (k) {
    nachName[normName(k.name)] = k;
    const nr = String(k.rueckennummer || '').trim();
    if (nr) nachNr[nr] = nachNr[nr] ? null : k;
  });

  const neu = [];
  const uebersprungen = [];
  events.forEach(function (e) {
    if (e.typ !== 'zwei' || e.team !== own) return;
    const k = nachName[normName(e.name)] || nachNr[String(e.nr)] || null;
    if (!k) { uebersprungen.push('#' + e.nr + ' ' + e.name); return; }
    neu.push({ id: crypto.randomUUID(), spielerinId: k.id, halbzeit: e.t < 1800 ? '1' : '2' });
  });

  // Nichts schreiben, wenn der Bestand schon dem Bericht entspricht (je Spielerin und Halbzeit)
  const vorhanden = (await env.DB.prepare(
    "SELECT spielerin_id, halbzeit FROM aktionen WHERE mannschaft_id = ? AND spiel_id = ? AND aktionstyp = '2min verursacht'"
  ).bind(session.mannschaft_id, spielId).all()).results || [];
  const schluessel = function (id, hz) { return id + '|' + hz; };
  const a1 = vorhanden.map(function (v) { return schluessel(v.spielerin_id, String(v.halbzeit)); }).sort().join(',');
  const a2 = neu.map(function (n) { return schluessel(n.spielerinId, n.halbzeit); }).sort().join(',');
  if (a1 === a2) return { uebernommen: neu.length, uebersprungen: uebersprungen, geaendert: false };

  const stmts = [
    env.DB.prepare("DELETE FROM aktionen WHERE mannschaft_id = ? AND spiel_id = ? AND aktionstyp = '2min verursacht'")
      .bind(session.mannschaft_id, spielId)
  ];
  const jetzt = new Date().toISOString();
  neu.forEach(function (n) {
    stmts.push(env.DB.prepare(
      `INSERT INTO aktionen (id, mannschaft_id, spiel_id, spielerin_id, halbzeit, aktionstyp, ergebnis, quelle, zeitstempel)
       VALUES (?, ?, ?, ?, ?, '2min verursacht', '', 'Spielbericht', ?)`
    ).bind(n.id, session.mannschaft_id, spielId, n.spielerinId, n.halbzeit, jetzt));
  });
  await env.DB.batch(stmts);
  return { uebernommen: neu.length, uebersprungen: uebersprungen };
}

function summiere(ziel, quelle) {
  ziel.sek += quelle.sek; ziel.tore += quelle.tore; ziel.gegentore += quelle.gegentore; ziel.phasen += quelle.phasen;
}

async function handleBerichtAuswertung(env, session, url) {
  await stelleSpielberichtSchemaSicher(env);
  const zeitraum = url.searchParams.get('zeitraum');
  const runde = url.searchParams.get('runde');
  if (!zeitraum) return json({ error: 'zeitraum fehlt' }, 400);

  let spiele;
  if (zeitraum === 'runde') {
    spiele = (await env.DB.prepare(
      'SELECT id, datum, gegner, tore_eigene, tore_gegner FROM spiele WHERE mannschaft_id = ? AND runde = ? ORDER BY datum'
    ).bind(session.mannschaft_id, runde || '').all()).results || [];
  } else {
    spiele = (await env.DB.prepare(
      'SELECT id, datum, gegner, tore_eigene, tore_gegner FROM spiele WHERE mannschaft_id = ? AND id = ?'
    ).bind(session.mannschaft_id, zeitraum).all()).results || [];
  }
  if (!spiele.length) return json({ spiele: [], ohneBericht: [], gesamt: null });

  const kader = (await env.DB.prepare('SELECT id, name, rueckennummer FROM kader WHERE mannschaft_id = ?')
    .bind(session.mannschaft_id).all()).results || [];

  const gesamt = {
    ueberzahl: { sek: 0, tore: 0, gegentore: 0, phasen: 0 },
    unterzahl: { sek: 0, tore: 0, gegentore: 0, phasen: 0 },
    drittel: SEGMENT_NAMEN.map(function (n) { return { name: n, tore: 0, gegentore: 0 }; }),
    strafen: {}
  };
  const ergebnis = [];
  const ohneBericht = [];

  for (const sp of spiele) {
    const row = await env.DB.prepare('SELECT daten FROM spielbericht WHERE spiel_id = ? AND mannschaft_id = ?')
      .bind(sp.id, session.mannschaft_id).first();
    if (!row) { ohneBericht.push({ spielId: sp.id, datum: sp.datum, gegner: sp.gegner }); continue; }
    const bericht = JSON.parse(row.daten);
    const analyse = analysiereBericht(bericht);
    // "2min verursacht" immer aus dem Bericht ableiten (auch für früher hochgeladene Berichte)
    try { await uebernehme2MinAusBericht(env, session, sp.id, bericht.own, bericht.events || []); } catch (err) { /* Auswertung trotzdem liefern */ }

    const akt = (await env.DB.prepare('SELECT spielerin_id, aktionstyp, ergebnis FROM aktionen WHERE mannschaft_id = ? AND spiel_id = ?')
      .bind(session.mannschaft_id, sp.id).all()).results || [];
    const erfasst = { perPlayer: {}, gegentore: 0, zweiGeholt: 0 };
    akt.forEach(function (a) {
      const p = erfasst.perPlayer[a.spielerin_id] || (erfasst.perPlayer[a.spielerin_id] = { treffer: 0, sieben: 0, zweiVerursacht: 0 });
      if (WURF_ZONEN.indexOf(a.aktionstyp) !== -1) {
        if (a.ergebnis === 'Treffer') p.treffer++;
        if (a.aktionstyp === '7m' && (a.ergebnis === 'Treffer' || a.ergebnis === 'Fehlwurf')) p.sieben++;
        if (a.ergebnis === 'Gegentor') erfasst.gegentore++;
      }
      if (a.aktionstyp === '2min verursacht') p.zweiVerursacht++;
      if (a.aktionstyp === '2min geholt') erfasst.zweiGeholt++;
    });
    const kontrolle = kontrolliereBericht(analyse, kader, erfasst, sp);

    summiere(gesamt.ueberzahl, analyse.ueberzahl);
    summiere(gesamt.unterzahl, analyse.unterzahl);
    analyse.drittel.forEach(function (d, i) { gesamt.drittel[i].tore += d.tore; gesamt.drittel[i].gegentore += d.gegentore; });
    kontrolle.spielerinnen.forEach(function (z) {
      const key = normNameServer(z.name);
      const g = gesamt.strafen[key] || (gesamt.strafen[key] = { nr: z.nr, name: z.name, zwei: 0, gelb: 0, rot: 0, erfasstZwei: 0, erfasstMoeglich: true });
      g.zwei += z.acta.zwei; g.gelb += z.acta.gelb; g.rot += z.acta.rot;
      if (z.erfasst) g.erfasstZwei += z.erfasst.zwei; else g.erfasstMoeglich = false;
    });

    ergebnis.push({
      spielId: sp.id, datum: sp.datum, gegner: sp.gegner, own: bericht.own, meta: bericht.meta,
      ueberzahl: analyse.ueberzahl, unterzahl: analyse.unterzahl, drittel: analyse.drittel,
      toreEigen: analyse.toreEigen, toreGegner: analyse.toreGegner, hinweise: kontrolle.hinweise
    });
  }
  gesamt.strafen = Object.keys(gesamt.strafen).map(function (k) { return gesamt.strafen[k]; })
    .filter(function (g) { return g.zwei || g.gelb || g.rot || g.erfasstZwei; })
    .sort(function (a, b) { return (b.zwei + b.gelb + b.rot) - (a.zwei + a.gelb + a.rot) || a.name.localeCompare(b.name, 'de'); });
  return json({ spiele: ergebnis, ohneBericht: ohneBericht, gesamt: ergebnis.length ? gesamt : null });
}

function normNameServer(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

/* ---------- Tore-Abgleich Spielbericht <-> Erfassung (nur Admin) ---------- */
async function handleAbgleich(env, session, url) {
  if (session.rolle !== 'admin') return json({ error: 'Nur Admin darf Tore abgleichen.' }, 403);
  await stelleSpielberichtSchemaSicher(env);
  const spielId = url.searchParams.get('spielId');
  if (!spielId) return json({ error: 'spielId fehlt' }, 400);
  const row = await env.DB.prepare('SELECT daten FROM spielbericht WHERE spiel_id = ? AND mannschaft_id = ?')
    .bind(spielId, session.mannschaft_id).first();
  if (!row) return json({ error: 'Für dieses Spiel liegt kein Spielbericht vor.' }, 404);
  const bericht = JSON.parse(row.daten);
  const own = bericht.own;

  const kader = (await env.DB.prepare('SELECT id, name, rueckennummer FROM kader WHERE mannschaft_id = ?')
    .bind(session.mannschaft_id).all()).results || [];
  const finde = kaderMatcher(kader);
  const nameById = {};
  kader.forEach(function (k) { nameById[k.id] = k.name; });

  // Tore aus dem Bericht mit Zwischenstand (eigene : gegnerische)
  const events = (bericht.events || []).slice().sort(function (a, b) { return a.t - b.t; });
  let tEigen = 0, tGegner = 0;
  const acta = [];
  events.forEach(function (e) {
    if (e.typ !== 'tor' && e.typ !== 'tor7') return;
    if (e.team === own) {
      tEigen++;
      const k = finde(e.nr, e.name);
      acta.push({ t: e.t, typ: e.typ, kaderId: k ? k.id : null, nr: e.nr, name: e.name, stand: tEigen + ':' + tGegner });
    } else { tGegner++; }
  });

  const zonenSql = WURF_ZONEN.map(function () { return '?'; }).join(',');
  const rows = (await env.DB.prepare(
    `SELECT id, spielerin_id, aktionstyp, zeitstempel, halbzeit FROM aktionen
     WHERE mannschaft_id = ? AND spiel_id = ? AND ergebnis = 'Treffer' AND aktionstyp IN (${zonenSql})`
  ).bind(session.mannschaft_id, spielId, ...WURF_ZONEN).all()).results || [];
  const erfasst = rows.map(function (r) {
    return { id: r.id, spielerinId: r.spielerin_id, name: nameById[r.spielerin_id] || r.spielerin_id, zone: r.aktionstyp, ts: Date.parse(r.zeitstempel) || 0, halbzeit: r.halbzeit };
  }).sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); });

  // Erste erfasste Aktion je Halbzeit (beliebiger Typ) -> Notanker, falls kein Tor übereinstimmt
  const alle = (await env.DB.prepare('SELECT halbzeit, MIN(zeitstempel) AS erste FROM aktionen WHERE mannschaft_id = ? AND spiel_id = ? GROUP BY halbzeit')
    .bind(session.mannschaft_id, spielId).all()).results || [];
  const ersteTsProHz = {};
  alle.forEach(function (r) { ersteTsProHz[String(r.halbzeit) === '2' ? '2' : '1'] = Date.parse(r.erste) || null; });
  const ergebnis = berechneAbgleich(acta, erfasst, ersteTsProHz);
  return json({ bericht: ergebnis.bericht, erfasst: ergebnis.erfasst, karten: ergebnis.karten, zonen: WURF_ZONEN });
}

async function handleAbgleichAnwenden(request, env, session) {
  if (session.rolle !== 'admin') return json({ error: 'Nur Admin darf Tore abgleichen.' }, 403);
  const body = await request.json();
  const spielId = body.spielId;
  const op = body.op || {};
  if (!spielId || !op.op) return json({ error: 'spielId und op sind nötig.' }, 400);
  const quelle = 'Spielbericht-Abgleich';

  async function holeTreffer(aktionId) {
    const a = await env.DB.prepare('SELECT id, aktionstyp, ergebnis FROM aktionen WHERE id = ? AND mannschaft_id = ? AND spiel_id = ?')
      .bind(aktionId, session.mannschaft_id, spielId).first();
    if (!a || WURF_ZONEN.indexOf(a.aktionstyp) === -1 || a.ergebnis !== 'Treffer') return null;
    return a;
  }
  async function pruefeSpielerin(id) {
    const k = await env.DB.prepare('SELECT id FROM kader WHERE id = ? AND mannschaft_id = ?').bind(id, session.mannschaft_id).first();
    return !!k;
  }

  if (op.op === 'add') {
    if (WURF_ZONEN.indexOf(op.zone) === -1) return json({ error: 'Zone ist Pflicht.' }, 400);
    if (!(await pruefeSpielerin(op.spielerinId))) return json({ error: 'Spielerin nicht gefunden.' }, 404);
    const ts = Number(op.ts) > 0 ? new Date(Number(op.ts)).toISOString() : new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO aktionen (id, mannschaft_id, spiel_id, spielerin_id, halbzeit, aktionstyp, ergebnis, quelle, zeitstempel)
       VALUES (?, ?, ?, ?, ?, ?, 'Treffer', ?, ?)`
    ).bind(crypto.randomUUID(), session.mannschaft_id, spielId, op.spielerinId, op.halbzeit === '2' ? '2' : '1', op.zone, quelle, ts).run();
    return json({ status: 'ok' });
  }

  const a = await holeTreffer(op.aktionId);
  if (!a) return json({ error: 'Erfasster Treffer nicht gefunden (evtl. schon geändert).' }, 404);

  if (op.op === 'delete') {
    await env.DB.prepare('DELETE FROM aktionen WHERE id = ? AND mannschaft_id = ?').bind(a.id, session.mannschaft_id).run();
  } else if (op.op === 'tofehl') {
    await env.DB.prepare("UPDATE aktionen SET ergebnis = 'Fehlwurf', quelle = ? WHERE id = ? AND mannschaft_id = ?")
      .bind(quelle, a.id, session.mannschaft_id).run();
  } else if (op.op === 'reassign') {
    if (!(await pruefeSpielerin(op.spielerinId))) return json({ error: 'Spielerin nicht gefunden.' }, 404);
    const zone = op.zone && WURF_ZONEN.indexOf(op.zone) !== -1 ? op.zone : a.aktionstyp;
    await env.DB.prepare('UPDATE aktionen SET spielerin_id = ?, aktionstyp = ?, quelle = ? WHERE id = ? AND mannschaft_id = ?')
      .bind(op.spielerinId, zone, quelle, a.id, session.mannschaft_id).run();
  } else if (op.op === 'setzone') {
    if (WURF_ZONEN.indexOf(op.zone) === -1) return json({ error: 'Zone ist Pflicht.' }, 400);
    await env.DB.prepare('UPDATE aktionen SET aktionstyp = ?, quelle = ? WHERE id = ? AND mannschaft_id = ?')
      .bind(op.zone, quelle, a.id, session.mannschaft_id).run();
  } else {
    return json({ error: 'Unbekannte Operation: ' + op.op }, 400);
  }
  return json({ status: 'ok' });
}

/* ---------- Eigenen Code ändern (kein Eingriff durch den Anbieter nötig) ---------- */
async function handleChangeCode(request, env, session) {
  const body = await request.json();
  const alterCode = (body.alterCode || '').trim();
  const neuerCode = (body.neuerCode || '').trim();
  if (!alterCode || !neuerCode) return json({ error: 'Beide Felder ausfüllen.' }, 400);
  if (neuerCode.length < 4) return json({ error: 'Neuer Code muss mindestens 4 Zeichen haben.' }, 400);

  const row = await env.DB.prepare('SELECT code_hash FROM zugangscodes WHERE id = ? AND mannschaft_id = ?')
    .bind(session.zugangscode_id, session.mannschaft_id).first();
  if (!row) return json({ error: 'Zugangscode nicht gefunden.' }, 404);

  const alterHash = await sha256Hex(alterCode);
  if (alterHash !== row.code_hash) return json({ error: 'Aktueller Code ist falsch.' }, 401);

  const neuerHash = await sha256Hex(neuerCode);
  const kollision = await env.DB.prepare(
    'SELECT id FROM zugangscodes WHERE mannschaft_id = ? AND code_hash = ? AND id != ? AND aktiv = 1'
  ).bind(session.mannschaft_id, neuerHash, session.zugangscode_id).first();
  if (kollision) return json({ error: 'Dieser Code wird bereits von einer anderen Rolle in eurer Mannschaft genutzt.' }, 409);

  await env.DB.prepare('UPDATE zugangscodes SET code_hash = ? WHERE id = ?').bind(neuerHash, session.zugangscode_id).run();
  return json({ status: 'ok' });
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
  if (request.method === 'POST' && action === 'spielbericht') {
    return handleSpielberichtSpeichern(request, env, session);
  }
  if (request.method === 'GET' && action === 'abgleich') {
    return handleAbgleich(env, session, url);
  }
  if (request.method === 'POST' && action === 'abgleichAnwenden') {
    return handleAbgleichAnwenden(request, env, session);
  }
  if (request.method === 'GET' && action === 'berichtAuswertung') {
    return handleBerichtAuswertung(env, session, url);
  }
  if (request.method === 'POST' && action === 'changeCode') {
    return handleChangeCode(request, env, session);
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
