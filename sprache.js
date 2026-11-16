/* ---------- Spracheingabe: Text -> Erfassungs-Befehl ----------
 *
 * Reine Logik (läuft im Browser als window.SpracheParser und in Node für Tests).
 * Satzmuster, Reihenfolge der Wörter ist frei:
 *   "<Nummer> Treffer <Zone>"        "7 Treffer neun Meter"
 *   "<Nummer> Fehlwurf <Zone>"       "12 Fehlwurf Außen"
 *   "<Nummer> Parade|Gegentor <Zone>" (Torhüterin)
 *   "<Nummer> Fehlpass | Ballverlust | TF | Assist"
 *   "<Nummer> sieben Meter geholt|verursacht", "<Nummer> zwei Minuten geholt|verursacht"
 *   "<Nummer> Block | Rausprellen | Pass abgefangen | technischer Fehler provoziert"
 *   Steuerung: "rückgängig", "erste Halbzeit", "zweite Halbzeit"
 *   Aufstellung: "Aufstellung 1 7 9 12 3 5 20" (genau diese stehen auf dem Feld, alle anderen draußen)
 *   Wechsel:   "7 eingewechselt", "9 ausgewechselt", "7 für 9" (braucht laufende Videouhr)
 *   Videouhr:  "Start" / "Weiter", "Unterbrechung" / "Auszeit" / "Stopp", "Zeit zwölf dreißig", "Tempo hundertfünfzig"
 * Statt der Rückennummer geht auch ein eindeutiger Vorname.
 *
 * roster: [{ id, name, nr, tw }]  (nur Spielerinnen dieses Spiels)
 * Rückgabe: { ok, befehl, text, fehler }
 *   befehl: { typ:'event', spielerinId, aktionstyp, ergebnis } | { typ:'halbzeit', hz } | { typ:'undo' }
 */
(function (root) {
  const ZONEN_WURF = ['Treffer', 'Fehlwurf', 'Parade', 'Gegentor'];

  function normalisiere(s) {
    return String(s || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/(sieben|neun|sechs)meter/g, '$1 meter')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  const EINER = { null: 0, ein: 1, eins: 1, eine: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
    zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13, vierzehn: 14, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19 };
  const ZEHNER = { zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };

  function zahlAusWort(w) {
    if (/^\d{1,2}$/.test(w)) return parseInt(w, 10);
    if (Object.prototype.hasOwnProperty.call(EINER, w)) return EINER[w];
    if (Object.prototype.hasOwnProperty.call(ZEHNER, w)) return ZEHNER[w];
    const m = /^(ein|zwei|drei|vier|fuenf|sechs|sieben|acht|neun)und(zwanzig|dreissig|vierzig|fuenfzig|sechzig|siebzig|achtzig|neunzig)$/.exec(w);
    return m ? EINER[m[1]] + ZEHNER[m[2]] : null;
  }

  // Muster in Reihenfolge: Spezielleres zuerst. Treffer werden aus dem Text entfernt.
  const AKTIONEN = [
    { re: /\btechnisch\w* fehler provoziert\b|\bprovoziert\b/, typ: 'Techn. Fehler provoziert', gruppe: 'feld' },
    { re: /\b(sieben|7) (meter|m) (geholt|verursacht)\b/, typ: function (m) { return '7m ' + m[3]; }, gruppe: 'feld' },
    { re: /\b(zwei|2) (minuten|minute|min) (geholt|verursacht)\b/, typ: function (m) { return '2min ' + m[3]; }, gruppe: 'feld' },
    { re: /\bgegen ?tor\b/, typ: 'Gegentor', gruppe: 'tw', wurf: true },
    { re: /\bparade\b|\bgehalten\b/, typ: 'Parade', gruppe: 'tw', wurf: true },
    { re: /\bfehl ?wurf\b/, typ: 'Fehlwurf', gruppe: 'feld', wurf: true },
    { re: /\btreffer\b|\btor\b/, typ: 'Treffer', gruppe: 'feld', wurf: true },
    { re: /\bfehl ?pass\b/, typ: 'Fehlpass', gruppe: 'alle' },
    { re: /\bball ?verlust\b/, typ: 'Ballverlust', gruppe: 'feld' },
    { re: /\btechnisch\w* fehler\b|\bt ?f\b/, typ: 'TF', gruppe: 'feld' },
    { re: /\bassist\b|\bvorlage\b/, typ: 'Assist', gruppe: 'alle' },
    { re: /\braus ?prellen\b/, typ: 'Rausprellen', gruppe: 'feld' },
    { re: /\b(pass )?abgefangen\b/, typ: 'Pass abgefangen', gruppe: 'feld' },
    { re: /\bblock\b|\bgeblockt\b/, typ: 'Block', gruppe: 'feld' }
  ];
  const ZONEN = [
    { re: /\b(neun|9) (meter|m)\b/, zone: '9m' },
    { re: /\b(sechs|6) (meter|m)\b/, zone: '6m' },
    { re: /\b(sieben|7) (meter|m)\b/, zone: '7m' },
    { re: /\baussen\b/, zone: 'Außen' },
    { re: /\bkreis\w*\b/, zone: 'Kreis' },
    { re: /\b(konter|gegenstoss)\b/, zone: 'Konter' }
  ];

  // "hundertfünfzig", "150", "anderthalb", "doppelt" -> Prozent (25..300) oder null
  function prozentAusText(tokens) {
    const j = tokens.join('');
    if (/^\d{2,3}$/.test(j)) return parseInt(j, 10);
    if (j === 'anderthalb') return 150;
    if (j === 'doppelt' || j === 'doppeltes') return 200;
    if (j === 'normal') return 100;
    if (j === 'halb') return 50;
    const m = /^(zwei)?hundert(.*)$/.exec(j);
    if (m) {
      const rest = m[2] ? zahlAusWort(m[2]) : 0;
      return rest === null ? null : (m[1] ? 200 : 100) + rest;
    }
    const z = zahlAusWort(j);
    return z;
  }

  // Uhr-Befehle (Videozeit): start / stopp / zeit mm ss / tempo prozent
  function parseUhr(t) {
    if (/^(start|los|weiter|anpfiff|spielbeginn)$/.test(t)) return { ok: true, befehl: { typ: 'uhr', aktion: 'start' }, beschreibung: 'Uhr läuft' };
    if (/^(unterbrechung|unterbrochen|stopp|stop|auszeit|pause|halt)$/.test(t)) return { ok: true, befehl: { typ: 'uhr', aktion: 'stopp' }, beschreibung: 'Uhr angehalten' };
    let m = /^zeit (.+)$/.exec(t);
    if (m) {
      const zahlen = m[1].split(' ').filter(function (w) { return !/^(uhr|minuten|minute|sekunden|sekunde|und|null)$/.test(w) || w === 'null'; })
        .map(zahlAusWort).filter(function (n) { return n !== null; });
      const mm = zahlen[0], ss = zahlen.length > 1 ? zahlen[1] : 0;
      if (!zahlen.length || zahlen.length > 2 || mm > 60 || ss > 59) return { ok: false, fehler: 'Zeit nicht verstanden (z. B. „Zeit zwölf dreißig“).' };
      return { ok: true, befehl: { typ: 'uhr', aktion: 'setze', sek: mm * 60 + ss }, beschreibung: 'Zeit ' + mm + ':' + String(ss).padStart(2, '0') };
    }
    m = /^(tempo|geschwindigkeit|speed) (.+)$/.exec(t);
    if (m) {
      const p = prozentAusText(m[2].split(' '));
      if (p === null || p < 25 || p > 300) return { ok: false, fehler: 'Tempo nicht verstanden (z. B. „Tempo hundertfünfzig“).' };
      return { ok: true, befehl: { typ: 'uhr', aktion: 'tempo', prozent: p }, beschreibung: 'Tempo ' + p + ' %' };
    }
    return null;
  }

  // tokens (normalisiert) -> genau eine Spielerin (Rückennummer, sonst eindeutiger Vorname)
  function findeSpielerin(tokens, roster) {
    const nummern = [];
    tokens.forEach(function (w) { const n = zahlAusWort(w); if (n !== null) nummern.push(n); });
    if (nummern.length > 1) return { fehler: 'Mehrere Zahlen erkannt (' + nummern.join(', ') + ').' };
    if (nummern.length === 1) {
      const treffer = roster.filter(function (p) { return String(p.nr).trim() === String(nummern[0]); });
      if (!treffer.length) return { fehler: 'Nr. ' + nummern[0] + ' ist nicht im Kader dieses Spiels.' };
      if (treffer.length > 1) return { fehler: 'Nr. ' + nummern[0] + ' ist doppelt vergeben.' };
      return { spielerin: treffer[0] };
    }
    const namen = roster.filter(function (p) {
      return normalisiere(p.name).split(' ').some(function (teil) { return teil.length >= 3 && tokens.indexOf(teil) !== -1; });
    });
    if (namen.length === 1) return { spielerin: namen[0] };
    if (namen.length > 1) return { fehler: 'Name nicht eindeutig: ' + namen.map(function (p) { return p.name; }).join(', ') + '.' };
    return { fehler: 'Keine Spielerin erkannt (Rückennummer sagen).' };
  }

  // Aufstellung: Liste von Rückennummern/Vornamen -> Spielerinnen. Zusammengezogene Ziffern ("179") werden
  // nur akzeptiert, wenn sie sich eindeutig in Rückennummern des Kaders zerlegen lassen.
  function parseAufstellung(rest, roster) {
    const nrs = {};
    roster.forEach(function (p) { if (String(p.nr).trim() !== '') nrs[String(p.nr).trim()] = (nrs[String(p.nr).trim()] || []).concat(p); });
    function zerlege(str) {
      if (!str.length) return [[]];
      let out = [];
      [2, 1].forEach(function (len) {
        const teil = str.slice(0, len);
        if (teil.length === len && nrs[String(parseInt(teil, 10))] && String(parseInt(teil, 10)) === teil) {
          zerlege(str.slice(len)).forEach(function (r) { out.push([teil].concat(r)); });
        }
      });
      return out;
    }
    const gefunden = [];
    const tokens = rest.split(' ').filter(function (w) { return w && !/^(und|nummer|nr|spielerinnen|spielerin)$/.test(w); });
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      let teile = [w];
      if (/^\d{3,}$/.test(w)) {
        const z = zerlege(w);
        if (z.length !== 1) return { fehler: 'Ziffern „' + w + '“ nicht eindeutig trennbar – Nummern einzeln sagen.' };
        teile = z[0];
      }
      for (const tw of teile) {
        const f = findeSpielerin([tw], roster);
        if (f.fehler) return { fehler: f.fehler };
        if (gefunden.some(function (p) { return p.id === f.spielerin.id; })) return { fehler: bezeichnung(f.spielerin) + ' doppelt genannt.' };
        gefunden.push(f.spielerin);
      }
    }
    if (!gefunden.length) return { fehler: 'Aufstellung: keine Spielerinnen erkannt.' };
    if (gefunden.length > 7) return { fehler: 'Aufstellung: ' + gefunden.length + ' Spielerinnen genannt, höchstens 7 möglich.' };
    return { spielerinnen: gefunden };
  }

  function bezeichnung(p) { return (p.nr ? '#' + p.nr + ' ' : '') + p.name; }

  function parse(text, roster) {
    let t = normalisiere(text);
    const res = function (o) { o.text = t; return o; };
    if (!t) return res({ ok: false, fehler: 'Nichts verstanden.' });

    const uhr = parseUhr(t);
    if (uhr) return res(uhr);
    const auf = /^(startaufstellung|aufstellung|auf dem feld)\s+(.+)$/.exec(t);
    if (auf) {
      const a = parseAufstellung(auf[2], roster);
      if (a.fehler) return res({ ok: false, fehler: a.fehler });
      return res({ ok: true, befehl: { typ: 'aufstellung', ids: a.spielerinnen.map(function (p) { return p.id; }) },
        beschreibung: 'Aufstellung: ' + a.spielerinnen.map(function (p) { return p.nr ? '#' + p.nr : p.name; }).join(', ') });
    }
    if (/\b(rueckgaengig|zurueck|loeschen)\b/.test(t)) return res({ ok: true, befehl: { typ: 'undo' }, beschreibung: 'Letzte Aktion rückgängig' });
    if (/\b(erste|1) halbzeit\b|\bhalbzeit (eins|1)\b/.test(t)) return res({ ok: true, befehl: { typ: 'halbzeit', hz: '1' }, beschreibung: '1. Halbzeit' });
    if (/\b(zweite|2) halbzeit\b|\bhalbzeit (zwei|2)\b/.test(t)) return res({ ok: true, befehl: { typ: 'halbzeit', hz: '2' }, beschreibung: '2. Halbzeit' });

    // Aktion(en)
    const gefunden = [];
    AKTIONEN.forEach(function (a) {
      const m = a.re.exec(t);
      if (!m) return;
      gefunden.push({ typ: typeof a.typ === 'function' ? a.typ(m) : a.typ, gruppe: a.gruppe, wurf: !!a.wurf });
      t = t.replace(a.re, ' ');
    });
    t = t.replace(/\s+/g, ' ').trim();
    if (gefunden.length === 0) {
      // Wechsel: "7 eingewechselt", "9 ausgewechselt", "7 für 9"
      const bereinigt = t.replace(/\b(nummer|nr)\b/g, ' ').replace(/\s+/g, ' ').trim();
      const fuer = /^(.+) fuer (.+)$/.exec(bereinigt);
      if (fuer) {
        const rein = findeSpielerin(fuer[1].split(' ').filter(Boolean), roster);
        const raus = findeSpielerin(fuer[2].split(' ').filter(Boolean), roster);
        if (rein.fehler) return res({ ok: false, fehler: 'Wechsel (rein): ' + rein.fehler });
        if (raus.fehler) return res({ ok: false, fehler: 'Wechsel (raus): ' + raus.fehler });
        if (rein.spielerin.id === raus.spielerin.id) return res({ ok: false, fehler: 'Wechsel: rein und raus sind dieselbe Spielerin.' });
        return res({ ok: true, befehl: { typ: 'wechsel', ein: rein.spielerin.id, aus: raus.spielerin.id }, beschreibung: bezeichnung(rein.spielerin) + ' für ' + bezeichnung(raus.spielerin) });
      }
      const ein = /\b(eingewechselt|einwechslung|einwechseln|rein|kommt)\b/.test(bereinigt);
      const aus = /\b(ausgewechselt|auswechslung|auswechseln|raus|geht)\b/.test(bereinigt);
      if (ein !== aus) {
        const rest = bereinigt.replace(/\b(eingewechselt|einwechslung|einwechseln|rein|kommt|ausgewechselt|auswechslung|auswechseln|raus|geht)\b/g, ' ').split(' ').filter(Boolean);
        const f = findeSpielerin(rest, roster);
        if (f.fehler) return res({ ok: false, fehler: f.fehler });
        return res({ ok: true, befehl: { typ: 'wechsel', ein: ein ? f.spielerin.id : null, aus: aus ? f.spielerin.id : null },
          beschreibung: bezeichnung(f.spielerin) + (ein ? ' eingewechselt' : ' ausgewechselt') });
      }
      return res({ ok: false, fehler: 'Keine Aktion erkannt.' });
    }
    if (gefunden.length > 1) return res({ ok: false, fehler: 'Mehrere Aktionen erkannt (' + gefunden.map(function (g) { return g.typ; }).join(', ') + ') – bitte einzeln sprechen.' });
    const akt = gefunden[0];

    // Zone
    const zonen = [];
    ZONEN.forEach(function (z) {
      if (z.re.test(t)) { zonen.push(z.zone); t = t.replace(z.re, ' '); }
    });
    t = t.replace(/\s+/g, ' ').trim();
    if (zonen.length > 1) return res({ ok: false, fehler: 'Mehrere Zonen erkannt (' + zonen.join(', ') + ').' });
    const zone = zonen[0] || null;
    if (akt.wurf && !zone) return res({ ok: false, fehler: akt.typ + ': Zone fehlt (9m, 6m, Außen, Kreis, Konter, 7m).' });
    if (!akt.wurf && zone) return res({ ok: false, fehler: akt.typ + ': Zone „' + zone + '“ passt nicht dazu.' });

    // Spielerin: Rückennummer, sonst Vorname
    const fs = findeSpielerin(t.split(' ').filter(Boolean), roster);
    if (fs.fehler) return res({ ok: false, fehler: fs.fehler });
    const kandidat = fs.spielerin;

    if (akt.gruppe === 'tw' && !kandidat.tw) return res({ ok: false, fehler: akt.typ + ' gilt nur für Torhüterinnen, ' + kandidat.name + ' ist Feldspielerin.' });
    if (akt.gruppe === 'feld' && kandidat.tw) return res({ ok: false, fehler: akt.typ + ' gilt nur für Feldspielerinnen, ' + kandidat.name + ' ist Torhüterin.' });

    const label = (kandidat.nr ? '#' + kandidat.nr + ' ' : '') + kandidat.name;
    if (akt.wurf) {
      return res({ ok: true, befehl: { typ: 'event', spielerinId: kandidat.id, aktionstyp: zone, ergebnis: akt.typ }, beschreibung: label + ' · ' + akt.typ + ' ' + zone });
    }
    return res({ ok: true, befehl: { typ: 'event', spielerinId: kandidat.id, aktionstyp: akt.typ, ergebnis: '' }, beschreibung: label + ' · ' + akt.typ });
  }

  const api = { parse: parse, prozentAusText: prozentAusText, normalisiere: normalisiere, zahlAusWort: zahlAusWort };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpracheParser = api;
})(typeof self !== 'undefined' ? self : this);
