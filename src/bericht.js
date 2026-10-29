/* ---------- Spielbericht-Auswertung (reine Rechenlogik, ohne DB-Zugriff) ----------
 *
 * Eingabe: gespeicherter Bericht { own: 'Heim'|'Gast', events: [{ t, team, typ, nr?, name? }] }
 *   typ: 'tor' | 'tor7' | 'fehl7' | 'zwei' | 'gelb' | 'rot' | 'auszeit'
 *   t = Spielzeit in Sekunden (0..3600), Halbzeit 1 = 0..1800.
 * Personen (nr/name) sind nur für die EIGENE Mannschaft vorhanden -- Gegnerdaten
 * werden bewusst nicht gespeichert.
 *
 * Annahme (vom Nutzer bestätigt): Jede 2-Minuten-Strafe läuft volle 120 s,
 * auch über die Halbzeit hinweg und unabhängig von Toren.
 */

export const STRAFE_SEKUNDEN = 120;
export const SPIELDAUER = 3600;
const SEGMENT_SEKUNDEN = 600; // Halbzeit gedrittelt: 3 x 10 Minuten
export const SEGMENT_NAMEN = [
  '1. HZ Start (0–10)', '1. HZ Mitte (10–20)', '1. HZ Ende (20–30)',
  '2. HZ Start (30–40)', '2. HZ Mitte (40–50)', '2. HZ Ende (50–60)'
];

function istTor(e) { return e.typ === 'tor' || e.typ === 'tor7'; }

export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/* Zeitlich wirksame Strafen: 'zwei' immer; 'rot' (Disqualifikation) zählt wie eine
   2-Minuten-Unterzahl, außer zur selben Zeit/Mannschaft steht schon eine 'zwei'
   (3. Zeitstrafe wird teils doppelt gelistet). */
function strafenListe(events) {
  const liste = [];
  events.forEach(function (e) {
    if (e.typ === 'zwei') liste.push({ s: e.t, team: e.team });
  });
  events.forEach(function (e) {
    if (e.typ !== 'rot') return;
    const doppelt = liste.some(function (p) { return p.team === e.team && p.s === e.t; });
    if (!doppelt) liste.push({ s: e.t, team: e.team });
  });
  return liste;
}

export function analysiereBericht(bericht) {
  const own = bericht.own === 'Gast' ? 'Gast' : 'Heim';
  const opp = own === 'Heim' ? 'Gast' : 'Heim';
  const events = (bericht.events || []).slice().sort(function (a, b) { return a.t - b.t; });
  const strafen = strafenListe(events);

  function zustandBei(t) {
    let nOwn = 0, nOpp = 0;
    strafen.forEach(function (p) {
      if (p.s <= t && t < p.s + STRAFE_SEKUNDEN) { if (p.team === own) nOwn++; else nOpp++; }
    });
    if (nOwn > nOpp) return 'unterzahl';
    if (nOpp > nOwn) return 'ueberzahl';
    return 'gleich';
  }

  // Dauer je Zustand: Intervallgrenzen = Strafbeginn/-ende
  const grenzen = [0, SPIELDAUER];
  strafen.forEach(function (p) {
    grenzen.push(Math.min(p.s, SPIELDAUER), Math.min(p.s + STRAFE_SEKUNDEN, SPIELDAUER));
  });
  const sortiert = Array.from(new Set(grenzen)).sort(function (a, b) { return a - b; });
  const zustand = {
    ueberzahl: { sek: 0, tore: 0, gegentore: 0, phasen: 0 },
    unterzahl: { sek: 0, tore: 0, gegentore: 0, phasen: 0 },
    gleich: { sek: 0, tore: 0, gegentore: 0, phasen: 0 }
  };
  for (let i = 0; i < sortiert.length - 1; i++) {
    zustand[zustandBei(sortiert[i])].sek += sortiert[i + 1] - sortiert[i];
  }
  // Phasen = Anzahl der Strafen, die eine Über-/Unterzahl auslösen (Strafen des Gegners bzw. eigene)
  strafen.forEach(function (p) { zustand[p.team === own ? 'unterzahl' : 'ueberzahl'].phasen++; });

  // Drittel je Halbzeit
  const drittel = SEGMENT_NAMEN.map(function (name) { return { name: name, tore: 0, gegentore: 0, standEigen: 0, standGegner: 0 }; });
  const spielerinnen = {};

  events.forEach(function (e) {
    if (istTor(e)) {
      const z = zustandBei(e.t);
      const seg = Math.min(Math.floor(e.t / SEGMENT_SEKUNDEN), 5);
      if (e.team === own) { zustand[z].tore++; drittel[seg].tore++; } else { zustand[z].gegentore++; drittel[seg].gegentore++; }
    }
    if (e.team === own && (e.name || e.nr)) {
      const key = String(e.nr) + '|' + normName(e.name);
      const s = spielerinnen[key] || (spielerinnen[key] = { nr: e.nr, name: e.name, tore: 0, tore7: 0, fehl7: 0, zwei: 0, gelb: 0, rot: 0 });
      if (istTor(e)) s.tore++;
      if (e.typ === 'tor7') s.tore7++;
      if (e.typ === 'fehl7') s.fehl7++;
      if (e.typ === 'zwei') s.zwei++;
      if (e.typ === 'gelb') s.gelb++;
      if (e.typ === 'rot') s.rot++;
    }
  });

  let cumEigen = 0, cumGegner = 0;
  drittel.forEach(function (d) {
    cumEigen += d.tore; cumGegner += d.gegentore;
    d.standEigen = cumEigen; d.standGegner = cumGegner;
  });

  const toreEigen = events.filter(function (e) { return istTor(e) && e.team === own; }).length;
  const toreGegner = events.filter(function (e) { return istTor(e) && e.team === opp; }).length;
  const zweiGegner = events.filter(function (e) { return e.typ === 'zwei' && e.team === opp; }).length;

  return {
    ueberzahl: zustand.ueberzahl,
    unterzahl: zustand.unterzahl,
    gleichzahl: zustand.gleich,
    drittel: drittel,
    spielerinnen: Object.keys(spielerinnen).map(function (k) { return spielerinnen[k]; }),
    toreEigen: toreEigen,
    toreGegner: toreGegner,
    zweiGegner: zweiGegner
  };
}

/* Kontrolle gegen die eigene Erfassung.
 * kader:   [{ id, name, rueckennummer }]
 * erfasst: { perPlayer: { [kaderId]: { treffer, sieben, zweiVerursacht } }, gegentore, zweiGeholt }
 * spiel:   { tore_eigene, tore_gegner } (manuell am Spielende eingetragen, kann null sein)
 * Rückgabe: { hinweise: [string], spielerinnen: [{ nr, name, kaderId, acta: {...}, erfasst: {...} }] }
 */
export function kontrolliereBericht(analyse, kader, erfasst, spiel) {
  const hinweise = [];
  const nachName = {};
  const nachNr = {};
  kader.forEach(function (k) {
    nachName[normName(k.name)] = k;
    const nr = String(k.rueckennummer || '').trim();
    if (nr) nachNr[nr] = nachNr[nr] ? null : k; // doppelte Nummern nicht eindeutig
  });

  const zeilen = [];
  const benutzt = {};
  analyse.spielerinnen.forEach(function (s) {
    const k = nachName[normName(s.name)] || nachNr[String(s.nr)] || null;
    const e = k ? (erfasst.perPlayer[k.id] || { treffer: 0, sieben: 0, zweiVerursacht: 0 }) : null;
    if (k) benutzt[k.id] = true;
    const label = '#' + s.nr + ' ' + s.name;
    if (!k) {
      if (s.tore || s.zwei || s.gelb || s.rot || s.tore7 || s.fehl7) {
        hinweise.push(label + ': im Kader nicht gefunden (Name/Nummer prüfen).');
      }
    } else {
      if (e.treffer !== s.tore) hinweise.push(label + ': Tore laut Spielbericht ' + s.tore + ', erfasst ' + e.treffer + '.');
      if (e.sieben !== s.tore7 + s.fehl7) hinweise.push(label + ': 7m-Würfe laut Spielbericht ' + (s.tore7 + s.fehl7) + ', erfasst ' + e.sieben + '.');
      // 2-Minuten-Strafen: kein Hinweis, "2min verursacht" wird automatisch aus dem Bericht übernommen
    }
    zeilen.push({
      nr: s.nr, name: s.name, kaderId: k ? k.id : null,
      acta: { tore: s.tore, tore7: s.tore7, fehl7: s.fehl7, zwei: s.zwei, gelb: s.gelb, rot: s.rot },
      erfasst: e ? { treffer: e.treffer, sieben: e.sieben, zwei: e.zweiVerursacht } : null
    });
  });
  // Erfasste Aktionen von Spielerinnen, die im Spielbericht gar nicht vorkommen
  kader.forEach(function (k) {
    const e = erfasst.perPlayer[k.id];
    if (!e || benutzt[k.id]) return;
    if (e.treffer || e.sieben) {
      hinweise.push(k.name + ': erfasst (Treffer ' + e.treffer + ', 7m-Würfe ' + e.sieben + '), aber im Spielbericht ohne Einträge.');
    }
  });

  let summeTreffer = 0;
  Object.keys(erfasst.perPlayer).forEach(function (id) { summeTreffer += erfasst.perPlayer[id].treffer; });
  if (summeTreffer !== analyse.toreEigen) hinweise.unshift('Team: Tore laut Spielbericht ' + analyse.toreEigen + ', erfasst ' + summeTreffer + '.');
  if (erfasst.gegentore !== analyse.toreGegner) hinweise.unshift('Team: Gegentore laut Spielbericht ' + analyse.toreGegner + ', erfasst (Torwart „Gegentor“) ' + erfasst.gegentore + '.');
  if (spiel && spiel.tore_eigene != null && Number(spiel.tore_eigene) !== analyse.toreEigen) {
    hinweise.unshift('Endstand: eingetragene Tore ' + spiel.tore_eigene + ', laut Spielbericht ' + analyse.toreEigen + '.');
  }
  if (spiel && spiel.tore_gegner != null && Number(spiel.tore_gegner) !== analyse.toreGegner) {
    hinweise.unshift('Endstand: eingetragene Gegentore ' + spiel.tore_gegner + ', laut Spielbericht ' + analyse.toreGegner + '.');
  }
  return { hinweise: hinweise, spielerinnen: zeilen };
}

/* ---------- Tore-Abgleich: Spielbericht <-> Erfassung ----------
 * Vergleicht die Reihenfolge der eigenen Tore im Bericht mit der Reihenfolge der erfassten
 * Treffer (Längste gemeinsame Teilfolge über "Spielerin + 7m/Feld") und leitet daraus Karten ab:
 *   fehlt  = Tor im Bericht, in der Erfassung nicht vorhanden  (Zone muss gewählt werden)
 *   falsch = erfasster Treffer vermutlich der falschen Spielerin zugeordnet
 *   zone   = richtige Spielerin, aber 7m-/Feldtor-Zuordnung passt nicht
 *   viel   = erfasster Treffer ohne Entsprechung im Bericht
 *            (Standard: löschen, wenn <= DOPPEL_SEKUNDEN von einem anderen Treffer entfernt, sonst Fehlwurf)
 *
 * acta:    [{ t, typ:'tor'|'tor7', kaderId|null, nr, name, stand }] in Spielzeit-Reihenfolge
 * erfasst: [{ id, spielerinId, name, zone, ts(ms) }] in Erfassungs-Reihenfolge
 */
export const DOPPEL_SEKUNDEN = 8;


/* Spielzeit-Schätzung für einen erfassten Treffer ohne Entsprechung im Bericht.
 * Messpunkte: übereinstimmende Tore (Erfassungs-Uhrzeit <-> Spielzeit laut Bericht).
 * Zwischen zwei Messpunkten wird linear interpoliert, die Halbzeit der Aktion begrenzt den Bereich.
 * Ohne Messpunkte: Abstand zur ersten erfassten Aktion derselben Halbzeit. */
function schaetzeSpielzeit(e, prevTs, prevT, nextTs, nextT, ersteTsProHz) {
  const hz2 = String(e.halbzeit) === '2';
  const halbStart = hz2 ? 1800 : 0, halbEnde = hz2 ? 3600 : 1800;
  let von = Math.max(prevT == null ? 0 : prevT, halbStart);
  let bis = Math.min(nextT == null ? 3600 : nextT, halbEnde);
  if (bis < von) { von = halbStart; bis = halbEnde; } // Messpunkte widersprechen der Halbzeit-Angabe
  let est;
  if (prevTs != null && nextTs != null && nextTs > prevTs) {
    est = prevT + (e.ts - prevTs) / (nextTs - prevTs) * (nextT - prevT);
  } else if (prevTs != null) {
    est = prevT + (e.ts - prevTs) / 1000;
  } else if (nextTs != null) {
    est = nextT - (nextTs - e.ts) / 1000;
  } else {
    const erste = ersteTsProHz[hz2 ? '2' : '1'];
    est = halbStart + (erste != null ? (e.ts - erste) / 1000 : 0);
  }
  est = Math.min(Math.max(est, von), bis);
  return { von: Math.round(von), bis: Math.round(bis), ca: Math.round(est) };
}

export function berechneAbgleich(acta, erfasst, ersteTsProHz) {
  ersteTsProHz = ersteTsProHz || {};
  const A = acta.map(function (a) {
    return Object.assign({}, a, { key: (a.kaderId || ('u:' + a.nr)) + '|' + (a.typ === 'tor7' ? '7' : 'F') });
  });
  const E = erfasst.map(function (e) {
    return Object.assign({}, e, { key: e.spielerinId + '|' + (e.zone === '7m' ? '7' : 'F') });
  });
  const n = A.length, m = E.length;

  const dp = [];
  for (let i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i].key === E[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const treffer = [];
  { let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i].key === E[j].key) { treffer.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }

  const karten = [];
  function naheAnderen(e) {
    return E.some(function (o) { return o !== e && Math.abs(o.ts - e.ts) <= DOPPEL_SEKUNDEN * 1000; });
  }
  function verarbeiteLuecke(as, es, prevTs, nextTs, prevT, nextT, hatPrev, hatNext) {
    const asRest = as.slice(), esRest = es.slice();
    const paare = [];
    // 1) gleiche Spielerin, aber 7m/Feld passt nicht
    es.forEach(function (e) {
      const a = asRest.find(function (x) { return x.kaderId && x.kaderId === e.spielerinId && x.key !== e.key; });
      if (a) { paare.push({ art: 'zone', a: a, e: e }); asRest.splice(asRest.indexOf(a), 1); esRest.splice(esRest.indexOf(e), 1); }
    });
    // 2) andere Spielerin, gleicher Tor-Typ (7m/Feld), in Reihenfolge
    esRest.slice().forEach(function (e) {
      const eTyp = e.key.split('|')[1];
      const a = asRest.find(function (x) { return x.kaderId && x.key.split('|')[1] === eTyp; });
      if (a) { paare.push({ art: 'falsch', a: a, e: e }); asRest.splice(asRest.indexOf(a), 1); esRest.splice(esRest.indexOf(e), 1); }
    });
    paare.forEach(function (p) {
      karten.push({
        art: p.art,
        erfasst: { id: p.e.id, spielerinId: p.e.spielerinId, name: p.e.name, zone: p.e.zone, ts: p.e.ts },
        bericht: { t: p.a.t, typ: p.a.typ, kaderId: p.a.kaderId, nr: p.a.nr, name: p.a.name, stand: p.a.stand },
        zoneVorschlag: p.a.typ === 'tor7' ? '7m' : null
      });
    });
    asRest.forEach(function (a, q) {
      let ts = null;
      if (prevTs != null && nextTs != null) ts = Math.round(prevTs + (nextTs - prevTs) * (q + 1) / (asRest.length + 1));
      else if (prevTs != null) ts = prevTs + 1000 * (q + 1);
      else if (nextTs != null) ts = nextTs - 1000 * (asRest.length - q);
      karten.push({
        art: 'fehlt',
        bericht: { t: a.t, typ: a.typ, kaderId: a.kaderId, nr: a.nr, name: a.name, stand: a.stand },
        zoneFix: a.typ === 'tor7' ? '7m' : null,
        halbzeit: a.t < 1800 ? '1' : '2',
        ts: ts
      });
    });
    esRest.forEach(function (e) {
      const doppelt = naheAnderen(e);
      karten.push({
        art: 'viel',
        erfasst: { id: e.id, spielerinId: e.spielerinId, name: e.name, zone: e.zone, ts: e.ts },
        standard: doppelt ? 'delete' : 'tofehl',
        zeit: schaetzeSpielzeit(e, hatPrev ? prevTs : null, prevT, hatNext ? nextTs : null, nextT, ersteTsProHz),
        grund: doppelt ? 'Weniger als ' + DOPPEL_SEKUNDEN + ' s von einem anderen erfassten Treffer entfernt (vermutlich nicht rückgängig gemacht).' : ''
      });
    });
  }

  const anker = treffer.map(function (p) { return { ts: E[p[1]].ts, t: A[p[0]].t }; });
  let i0 = 0, j0 = 0, prevTs = null, prevT = 0, hatPrev = false;
  treffer.forEach(function (p) {
    verarbeiteLuecke(A.slice(i0, p[0]), E.slice(j0, p[1]), prevTs, E[p[1]].ts, prevT, A[p[0]].t, hatPrev, true);
    i0 = p[0] + 1; j0 = p[1] + 1; prevTs = E[p[1]].ts; prevT = A[p[0]].t; hatPrev = true;
  });
  verarbeiteLuecke(A.slice(i0), E.slice(j0), prevTs, null, prevT, 3600, hatPrev, false);

  // Nur Reihenfolge vertauscht (z. B. zwei Tablets): "fehlt" und "viel" derselben Spielerin/Tor-Art heben sich auf.
  const entfernen = {};
  karten.forEach(function (k, q) {
    if (k.art !== 'viel') return;
    const key = k.erfasst.spielerinId + '|' + (k.erfasst.zone === '7m' ? '7' : 'F');
    const r = karten.findIndex(function (x, idx) {
      return !entfernen[idx] && x.art === 'fehlt' && x.bericht.kaderId &&
        (x.bericht.kaderId + '|' + (x.bericht.typ === 'tor7' ? '7' : 'F')) === key;
    });
    if (r !== -1) { entfernen[q] = true; entfernen[r] = true; }
  });
  const gefiltert = karten.filter(function (k, idx) { return !entfernen[idx]; });

  return { karten: gefiltert, bericht: n, erfasst: m, uebereinstimmend: treffer.length, anker: anker };
}


/* ---------- Gegentore-Abgleich ----------
 * Der Bericht nennt bei Gegner-Toren keine Person, nur die Spielzeit. Erfasste Gegentore (Torhüterin)
 * werden über die Messpunkte (übereinstimmende eigene Tore: Uhrzeit <-> Spielzeit) auf eine geschätzte
 * Spielzeit gebracht und per Reihenfolge-Abgleich (Edit-Distanz) den Berichts-Gegentoren zugeordnet.
 *   gt_viel  = erfasstes Gegentor ohne Entsprechung im Bericht (Standard: löschen bei Doppeltipp, sonst "Parade")
 *   gt_fehlt = Gegentor im Bericht ohne Entsprechung in der Erfassung (Torhüterin + Zone nötig)
 *
 * actaGegner: [{ t, stand }]   erfasst: [{ id, spielerinId, name, zone, ts, halbzeit }]   anker: [{ ts, t }]
 */
const GT_SKIP_SEKUNDEN = 60;

function ankerUmgebung(anker, ts) {
  let prev = null, next = null;
  anker.forEach(function (a) {
    if (a.ts <= ts) { if (!prev || a.ts > prev.ts) prev = a; }
    else if (!next || a.ts < next.ts) next = a;
  });
  return { prev: prev, next: next };
}

export function berechneGegentorAbgleich(actaGegner, erfasst, anker, ersteTsProHz) {
  ersteTsProHz = ersteTsProHz || {};
  anker = (anker || []).slice().sort(function (a, b) { return a.ts - b.ts; });
  const E = erfasst.slice().sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); }).map(function (e) {
    const u = ankerUmgebung(anker, e.ts);
    const z = schaetzeSpielzeit(e, u.prev ? u.prev.ts : null, u.prev ? u.prev.t : 0, u.next ? u.next.ts : null, u.next ? u.next.t : null, ersteTsProHz);
    return Object.assign({}, e, { zeit: z });
  });
  const A = actaGegner.slice().sort(function (a, b) { return a.t - b.t; });
  const n = A.length, m = E.length, S = GT_SKIP_SEKUNDEN;

  // dp[i][j] = minimale Kosten für A[i..], E[j..]
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) { dp[i][j] = 0; continue; }
      let best = Infinity;
      if (i < n) best = Math.min(best, dp[i + 1][j] + S);
      if (j < m) best = Math.min(best, dp[i][j + 1] + S);
      if (i < n && j < m) best = Math.min(best, dp[i + 1][j + 1] + Math.abs(A[i].t - E[j].zeit.ca));
      dp[i][j] = best;
    }
  }
  const aGepaart = {}, eGepaart = {};
  { let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && dp[i][j] === dp[i + 1][j + 1] + Math.abs(A[i].t - E[j].zeit.ca)) { aGepaart[i] = true; eGepaart[j] = true; i++; j++; }
      else if (i < n && dp[i][j] === dp[i + 1][j] + S) i++;
      else j++;
    }
  }

  function ts_aus_zeit(t) {
    // Umkehrung: Spielzeit -> Uhrzeit (lineare Interpolation zwischen den Messpunkten)
    const nachT = anker.slice().sort(function (a, b) { return a.t - b.t; });
    let prev = null, next = null;
    nachT.forEach(function (a) { if (a.t <= t) prev = a; else if (!next) next = a; });
    if (prev && next && next.t > prev.t) return Math.round(prev.ts + (t - prev.t) / (next.t - prev.t) * (next.ts - prev.ts));
    if (prev) return prev.ts + (t - prev.t) * 1000;
    if (next) return next.ts - (next.t - t) * 1000;
    const hz2 = t >= 1800, erste = ersteTsProHz[hz2 ? '2' : '1'];
    return erste != null ? erste + (t - (hz2 ? 1800 : 0)) * 1000 : null;
  }

  const karten = [];
  A.forEach(function (a, i) {
    if (aGepaart[i]) return;
    karten.push({ art: 'gt_fehlt', bericht: { t: a.t, stand: a.stand }, halbzeit: a.t < 1800 ? '1' : '2', ts: ts_aus_zeit(a.t) });
  });
  E.forEach(function (e, j) {
    if (eGepaart[j]) return;
    const doppelt = E.some(function (o, q) { return q !== j && Math.abs(o.ts - e.ts) <= DOPPEL_SEKUNDEN * 1000; });
    karten.push({
      art: 'gt_viel',
      erfasst: { id: e.id, spielerinId: e.spielerinId, name: e.name, zone: e.zone, ts: e.ts },
      standard: doppelt ? 'delete' : 'toparade',
      zeit: e.zeit,
      grund: doppelt ? 'Weniger als ' + DOPPEL_SEKUNDEN + ' s von einem anderen erfassten Gegentor entfernt (vermutlich nicht rückgängig gemacht).' : ''
    });
  });
  return { karten: karten, bericht: n, erfasst: m };
}

/* Spielerin des Berichts -> Kader-Eintrag (zuerst Name, dann eindeutige Rückennummer). */
export function kaderMatcher(kader) {
  const nachName = {}, nachNr = {};
  kader.forEach(function (k) {
    nachName[normName(k.name)] = k;
    const nr = String(k.rueckennummer || '').trim();
    if (nr) nachNr[nr] = nachNr[nr] ? null : k;
  });
  return function (nr, name) { return nachName[normName(name)] || nachNr[String(nr)] || null; };
}
