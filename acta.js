/* ---------- Spielbericht-PDF (Acta Completa) einlesen ----------
 *
 * Eingabe: pages = Array je PDF-Seite mit Textelementen { s: Text, x, y } (pdf.js getTextContent).
 * Ausgabe: { meta, events, warnungen }
 *   events: [{ t (Sek.), team: 'Heim'|'Gast', typ, nr, name }]
 *   typ: 'tor' | 'tor7' | 'fehl7' | 'zwei' | 'gelb' | 'rot' | 'auszeit'
 *
 * Aufbau des Berichts (Stand: Spielbericht 24.10.2026): Seite 1 Kopfdaten, Seiten 3+ der
 * Spielverlauf als Tabelle in zwei Hälften nebeneinander (links zuerst, dann rechts).
 * Jede Zeile hat eine Spielzeit "mm:ss"; mehrzeilige Zellen werden über den
 * nächstgelegenen Zeiteintrag zugeordnet.
 *
 * Läuft im Browser (window.ActaParser) und in Node (module.exports) für Tests.
 */
(function (root) {
  function sek(mmss) {
    const m = /^(\d+):(\d\d)$/.exec(mmss);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  function kopfWert(items, label) {
    const l = items.find(function (i) { return i.s.trim() === label; });
    if (!l) return '';
    const kandidaten = items.filter(function (i) { return Math.abs(i.y - l.y) <= 3 && i.x > l.x + 5; })
      .sort(function (a, b) { return a.x - b.x; });
    return kandidaten.length ? kandidaten[0].s.trim() : '';
  }

  function typAusText(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t === 'Tor') return 'tor';
    if (t === 'Siebenmeter Tor') return 'tor7';
    if (t === 'Siebenmeter Fehlwurf') return 'fehl7';
    if (t === 'Zwei Minuten') return 'zwei';
    if (t === 'Verwarnung') return 'gelb';
    if (/^Disqualifikation|^Rote Karte/i.test(t)) return 'rot';
    if (t === 'Auszeit') return 'auszeit';
    return null;
  }

  function personAusText(text) {
    const m = /^(\d+|[A-Z])\s+(.+)$/.exec(text.replace(/\s+/g, ' ').trim());
    return m ? { nr: m[1], name: m[2] } : { nr: '', name: '' };
  }

  function parseSpielverlaufSeite(items, events) {
    // Tabellenhälften über die Kopfzeilen-Einträge "Team" bestimmen
    const heads = items.filter(function (i) { return i.s.trim() === 'Team'; }).sort(function (a, b) { return a.x - b.x; });
    heads.forEach(function (h, idx) {
      const xMin = h.x - 8;
      const xMax = idx + 1 < heads.length ? heads[idx + 1].x - 8 : Infinity;
      const half = items.filter(function (i) { return i.x >= xMin && i.x < xMax && i.y < h.y - 5 && i.y > 35; });
      const rel = half.map(function (i) { return { s: i.s.trim(), dx: i.x - h.x, y: i.y }; });

      const anker = rel.filter(function (i) { return /^\d\d:\d\d$/.test(i.s) && i.dx >= 26 && i.dx < 62; });
      if (!anker.length) return;
      const zeilen = anker.map(function (a) { return { t: sek(a.s), y: a.y, team: '', ereignis: [], person: [] }; });

      rel.forEach(function (i) {
        if (/^\d\d:\d\d$/.test(i.s) && i.dx >= 26 && i.dx < 62) return; // Anker selbst
        let best = null, bestD = Infinity;
        zeilen.forEach(function (z) { const d = Math.abs(z.y - i.y); if (d < bestD) { bestD = d; best = z; } });
        if (!best || bestD > 16) return;
        if (i.dx < 26) { if (i.s === 'Heim' || i.s === 'Gast') best.team = i.s; }
        else if (i.dx < 90 && /^\d+:\d+$/.test(i.s)) { /* Zwischenstand: nicht benötigt */ }
        else if (i.dx < 186) best.ereignis.push(i);
        else best.person.push(i);
      });

      zeilen.forEach(function (z) {
        z.ereignis.sort(function (a, b) { return b.y - a.y; });
        z.person.sort(function (a, b) { return b.y - a.y; });
        const typ = typAusText(z.ereignis.map(function (i) { return i.s; }).join(' '));
        if (!typ || !z.team) return;
        const p = personAusText(z.person.map(function (i) { return i.s; }).join(' '));
        events.push({ t: z.t, team: z.team, typ: typ, nr: p.nr, name: p.name });
      });
    });
  }

  function parseActaPages(pages) {
    const warnungen = [];
    const kopf = pages[0] || [];
    const endstandText = kopfWert(kopf, 'Endstand');
    const es = /^(\d+):(\d+)\s*\((\d+)-(\d+)\)/.exec(endstandText);
    const datumText = kopfWert(kopf, 'Datum');
    const dm = /(\d\d)\.(\d\d)\.(\d{4})/.exec(datumText);
    const meta = {
      spielnummer: kopfWert(kopf, 'Spielnummer'),
      datum: dm ? dm[3] + '-' + dm[2] + '-' + dm[1] : '',
      heim: kopfWert(kopf, 'Heimmannschaft'),
      gast: kopfWert(kopf, 'Gastmannschaft'),
      endstand: es ? [parseInt(es[1], 10), parseInt(es[2], 10)] : null,
      halbzeit: es ? [parseInt(es[3], 10), parseInt(es[4], 10)] : null
    };
    if (!meta.heim || !meta.gast) warnungen.push('Mannschaftsnamen im Kopf des Berichts nicht gefunden.');
    if (!meta.endstand) warnungen.push('Endstand im Kopf des Berichts nicht gefunden.');

    const events = [];
    pages.forEach(function (items) {
      if (items.some(function (i) { return i.s.trim() === 'Spielverlauf' || (i.s.trim() === 'Team' && i.y > 600); })) {
        parseSpielverlaufSeite(items, events);
      }
    });
    events.sort(function (a, b) { return a.t - b.t; });

    // Plausibilitätsprüfung: Tore aus dem Spielverlauf müssen zum Endstand / Halbzeitstand passen
    function toreBis(team, bisSek) {
      return events.filter(function (e) { return e.team === team && (e.typ === 'tor' || e.typ === 'tor7') && e.t < bisSek; }).length;
    }
    if (!events.length) warnungen.push('Kein Spielverlauf gefunden – ist das ein Spielbericht (Acta Completa)?');
    if (meta.endstand) {
      const h = toreBis('Heim', 99999), g = toreBis('Gast', 99999);
      if (h !== meta.endstand[0] || g !== meta.endstand[1]) {
        warnungen.push('Tore im Spielverlauf (' + h + ':' + g + ') passen nicht zum Endstand (' + meta.endstand[0] + ':' + meta.endstand[1] + ').');
      }
    }
    if (meta.halbzeit) {
      const h1 = toreBis('Heim', 1800), g1 = toreBis('Gast', 1800);
      if (h1 !== meta.halbzeit[0] || g1 !== meta.halbzeit[1]) {
        warnungen.push('Halbzeitstand im Spielverlauf (' + h1 + ':' + g1 + ') passt nicht zum Bericht (' + meta.halbzeit[0] + ':' + meta.halbzeit[1] + ').');
      }
    }
    return { meta: meta, events: events, warnungen: warnungen };
  }

  /* Für den Upload: Personen des Gegners werden entfernt (Datensparsamkeit, keine Gegnerauswertung). */
  function fuerUpload(parsed, own) {
    return {
      own: own,
      meta: parsed.meta,
      events: parsed.events.map(function (e) {
        return e.team === own
          ? { t: e.t, team: e.team, typ: e.typ, nr: e.nr, name: e.name }
          : { t: e.t, team: e.team, typ: e.typ };
      })
    };
  }

  const api = { parseActaPages: parseActaPages, fuerUpload: fuerUpload };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ActaParser = api;
})(typeof self !== 'undefined' ? self : this);
