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
      if (e.zweiVerursacht !== s.zwei) hinweise.push(label + ': 2-Minuten-Strafen laut Spielbericht ' + s.zwei + ', erfasst („2min verursacht“) ' + e.zweiVerursacht + '.');
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
    if (e.treffer || e.sieben || e.zweiVerursacht) {
      hinweise.push(k.name + ': erfasst (Treffer ' + e.treffer + ', 7m-Würfe ' + e.sieben + ', 2min verursacht ' + e.zweiVerursacht + '), aber im Spielbericht ohne Einträge.');
    }
  });

  let summeTreffer = 0;
  Object.keys(erfasst.perPlayer).forEach(function (id) { summeTreffer += erfasst.perPlayer[id].treffer; });
  if (summeTreffer !== analyse.toreEigen) hinweise.unshift('Team: Tore laut Spielbericht ' + analyse.toreEigen + ', erfasst ' + summeTreffer + '.');
  if (erfasst.gegentore !== analyse.toreGegner) hinweise.unshift('Team: Gegentore laut Spielbericht ' + analyse.toreGegner + ', erfasst (Torwart „Gegentor“) ' + erfasst.gegentore + '.');
  if (erfasst.zweiGeholt !== analyse.zweiGegner) hinweise.unshift('Team: 2-Minuten-Strafen des Gegners laut Spielbericht ' + analyse.zweiGegner + ', erfasst („2min geholt“) ' + erfasst.zweiGeholt + '.');
  if (spiel && spiel.tore_eigene != null && Number(spiel.tore_eigene) !== analyse.toreEigen) {
    hinweise.unshift('Endstand: eingetragene Tore ' + spiel.tore_eigene + ', laut Spielbericht ' + analyse.toreEigen + '.');
  }
  if (spiel && spiel.tore_gegner != null && Number(spiel.tore_gegner) !== analyse.toreGegner) {
    hinweise.unshift('Endstand: eingetragene Gegentore ' + spiel.tore_gegner + ', laut Spielbericht ' + analyse.toreGegner + '.');
  }
  return { hinweise: hinweise, spielerinnen: zeilen };
}
