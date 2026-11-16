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

  function parse(text, roster) {
    let t = normalisiere(text);
    const res = function (o) { o.text = t; return o; };
    if (!t) return res({ ok: false, fehler: 'Nichts verstanden.' });

    const uhr = parseUhr(t);
    if (uhr) return res(uhr);
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
    if (gefunden.length === 0) return res({ ok: false, fehler: 'Keine Aktion erkannt.' });
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
    const tokens = t.split(' ').filter(Boolean);
    const nummern = [];
    tokens.forEach(function (w) { const n = zahlAusWort(w); if (n !== null) nummern.push(n); });
    let kandidat = null;
    if (nummern.length > 1) return res({ ok: false, fehler: 'Mehrere Zahlen erkannt (' + nummern.join(', ') + ').' });
    if (nummern.length === 1) {
      const treffer = roster.filter(function (p) { return String(p.nr).trim() === String(nummern[0]); });
      if (!treffer.length) return res({ ok: false, fehler: 'Nr. ' + nummern[0] + ' ist nicht im Kader dieses Spiels.' });
      if (treffer.length > 1) return res({ ok: false, fehler: 'Nr. ' + nummern[0] + ' ist doppelt vergeben.' });
      kandidat = treffer[0];
    } else {
      const namen = roster.filter(function (p) {
        return normalisiere(p.name).split(' ').some(function (teil) { return teil.length >= 3 && tokens.indexOf(teil) !== -1; });
      });
      if (namen.length === 1) kandidat = namen[0];
      else if (namen.length > 1) return res({ ok: false, fehler: 'Name nicht eindeutig: ' + namen.map(function (p) { return p.name; }).join(', ') + '.' });
      else return res({ ok: false, fehler: 'Keine Spielerin erkannt (Rückennummer sagen).' });
    }

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
