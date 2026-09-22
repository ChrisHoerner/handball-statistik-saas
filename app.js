/* ---------- Konfiguration ---------- */
const WURF_ZONEN = ['9m', '6m', 'Außen', 'Kreis', 'Konter', '7m'];
const BALLGEWINN = ['Techn. Fehler provoziert', 'Pass abgefangen', 'Rausprellen', 'Block'];
const FEHLER = ['Fehlpass', 'Schritte', 'Stürmerfoul', 'Kreisfehler', 'Doppeltipp', 'Ballverlust'];
const EINZEL = ['Assist', '7m geholt', '7m verursacht', '2min geholt', '2min verursacht'];

/* ---------- Kleine ID-Hilfe ---------- */
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}

/* ---------- IndexedDB ----------
 * Version 2: 'roster' (reiner Server-Snapshot) wird durch 'kader' +
 * 'kader_runde' ersetzt -- diese sind offline beschreibbar (Kader
 * verwalten) und bilden zusammen den Live-Kader (siehe computeRoster()).
 * 'roster' bleibt als Store bestehen (Altlast, wird nicht mehr befuellt),
 * damit ein Upgrade auf Version 2 bei bestehenden Installationen nicht
 * durch Schema-Aenderung an bestehenden Stores bricht.
 */
let dbPromise = new Promise(function (resolve, reject) {
  const req = indexedDB.open('spielstatistik', 2);
  req.onupgradeneeded = function () {
    const db = req.result;
    if (!db.objectStoreNames.contains('roster')) db.createObjectStore('roster', { keyPath: 'SpielerinID' });
    if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'SpielID' });
    if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'AktionID' });
    if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('kader')) db.createObjectStore('kader', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('kader_runde')) db.createObjectStore('kader_runde', { keyPath: 'id' });
  };
  req.onsuccess = function () { resolve(req.result); };
  req.onerror = function () { reject(req.error); };
});

function store(name, mode) {
  return dbPromise.then(function (db) { return db.transaction(name, mode || 'readonly').objectStore(name); });
}
function idbGetAll(name) {
  return store(name).then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.getAll();
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbGet(name, key) {
  return store(name).then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.get(key);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbPut(name, value) {
  return store(name, 'readwrite').then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.put(value);
      r.onsuccess = function () { res(value); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbDelete(name, key) {
  return store(name, 'readwrite').then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.delete(key);
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbClear(name) {
  return store(name, 'readwrite').then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.clear();
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  });
}

/* ---------- Zugang / Rollen ----------
 * Codes werden serverseitig gegen D1 geprüft (siehe /api/proxy?action=login
 * im Worker) -- hier liegt nichts mehr im Klartext. Login braucht einmalig
 * Internet, wie "Kader jetzt laden"; danach läuft die Session offline weiter,
 * solange der Token gültig ist (180 Tage, siehe Worker SESSION_TTL_TAGE).
 */

/* ---------- Feste Adresse des eigenen Worker-Endpunkts ---------- */
const API_BASE = '/api/proxy';

/* ---------- fetch mit Session-Token, für alle API_BASE-Aufrufe ---------- */
function authFetch(url, options) {
  const opts = options || {};
  opts.headers = Object.assign({}, opts.headers, state.sessionToken ? { 'Authorization': 'Bearer ' + state.sessionToken } : {});
  return fetch(url, opts);
}

/* ---------- Kunden-Erkennung über den URL-Pfad (kein Login-Feld nötig) ----------
 * .../sg-zeiskam -> Slug "sg-zeiskam". Nur beim Login relevant -- danach
 * identifiziert allein das Session-Token den Kunden (siehe Worker).
 */
/* ---------- Verein/Mannschaft-Erkennung über den URL-Pfad ----------
 * .../sg-zeiskam/damen -> vereinSlug "sg-zeiskam", mannschaftSlug "damen".
 * Nur beim Login relevant -- danach identifiziert allein das Session-Token
 * die Mannschaft (siehe Worker).
 */
function getSlugsFromPath() {
  const parts = location.pathname.split('/').filter(Boolean);
  return { verein: parts[0] || '', mannschaft: parts[1] || '' };
}

/* ---------- App-Zustand (nur im Speicher) ---------- */
const state = {
  roster: [],
  currentGameId: null,
  currentHalbzeit: '1',
  selectedPlayerId: null,
  runde: '',
  activeRosterNames: null,
  syncing: false,
  role: null,
  nutzerName: null,
  sessionToken: null,
  vereinSlug: getSlugsFromPath().verein,
  mannschaftSlug: getSlugsFromPath().mannschaft
};

/* ---------- Initialisierung ---------- */
window.addEventListener('load', init);

async function init() {
  document.getElementById('tabbar').style.display = '';
  bindUI();

  const savedRole = await idbGet('settings', 'role');
  const savedToken = await idbGet('settings', 'sessionToken');
  if (savedRole && savedRole.value && savedToken && savedToken.value) {
    state.role = savedRole.value;
    state.sessionToken = savedToken.value;
    const savedName = await idbGet('settings', 'nutzerName');
    state.nutzerName = savedName ? savedName.value : (state.role === 'admin' ? 'Admin' : 'Nutzer');
  }
  applyRoleRestrictions();
  updateLoginScreenView();

  if (state.role) {
    await postLoginInit();
  } else {
    showScreen('login');
  }
}

function updateLoginScreenView() {
  document.getElementById('loginForm').style.display = state.role ? 'none' : '';
  document.getElementById('logoutForm').style.display = state.role ? '' : 'none';
  if (state.role) {
    document.getElementById('loggedInAs').textContent = 'Angemeldet als: ' + state.nutzerName + (state.role === 'admin' ? ' (Admin)' : '');
    return;
  }
  const slugEl = document.getElementById('kundeSlugHint');
  const codeInput = document.getElementById('loginCode');
  const loginBtn = document.getElementById('btnLogin');
  if (state.vereinSlug && state.mannschaftSlug) {
    slugEl.textContent = 'Verein: ' + state.vereinSlug + ' / Mannschaft: ' + state.mannschaftSlug;
    codeInput.disabled = false;
    loginBtn.disabled = false;
  } else {
    slugEl.textContent = 'Kein Vereins-/Mannschafts-Link erkannt. Bitte den Link deiner Mannschaft verwenden (z. B. .../sg-zeiskam/damen).';
    codeInput.disabled = true;
    loginBtn.disabled = true;
  }
}

async function postLoginInit() {
  document.getElementById('statusbar').style.display = '';

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('SW-Fehler', e); });
  }

  const s2 = await idbGet('settings', 'runde');
  const s3 = await idbGet('settings', 'currentGameId');
  state.runde = s2 ? s2.value : '';
  state.currentGameId = s3 ? s3.value : null;

  document.getElementById('rundeSelect').value = state.runde;
  document.getElementById('gRunde').value = state.runde;

  await refreshRoster();

  await renderGameList();
  if (state.currentGameId) {
    const currentGame = await idbGet('games', state.currentGameId);
    state.activeRosterNames = (currentGame && currentGame.AktiveSpielerinnen && currentGame.AktiveSpielerinnen.length)
      ? currentGame.AktiveSpielerinnen : null;
  }
  await renderLiveScreen();
  showScreen(state.role === 'nutzer' ? 'live' : 'settings');
  updateStatusBar();
  setInterval(updateStatusBar, 5000);
  setInterval(trySync, 15000);
  window.addEventListener('online', trySync);
  window.addEventListener('offline', updateStatusBar);
}

async function doLogout() {
  await idbPut('settings', { key: 'role', value: null });
  await idbPut('settings', { key: 'sessionToken', value: null });
  location.reload();
}

function applyRoleRestrictions() {
  const allowedForNutzer = ['live', 'game'];
  document.querySelectorAll('nav.tabbar .tab').forEach(function (btn) {
    if (btn.dataset.screen === 'login') { btn.style.display = ''; return; }
    if (!state.role) { btn.style.display = 'none'; return; }
    const allowed = state.role === 'admin' || allowedForNutzer.indexOf(btn.dataset.screen) !== -1;
    btn.style.display = allowed ? '' : 'none';
  });
  document.getElementById('newGameForm').style.display = state.role === 'admin' ? '' : 'none';
}

/* ---------- UI-Verdrahtung ---------- */
function bindUI() {
  document.querySelectorAll('nav.tabbar .tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      showScreen(btn.dataset.screen);
      if (btn.dataset.screen === 'auswertung') populateAuswertungSelects();
      if (btn.dataset.screen === 'live') renderLiveScreen();
      if (btn.dataset.screen === 'login') updateLoginScreenView();
      if (btn.dataset.screen === 'kader') renderKaderScreen();
    });
  });

  document.getElementById('btnLogin').addEventListener('click', async function () {
    const code = document.getElementById('loginCode').value.trim();
    const errorEl = document.getElementById('loginError');
    const btn = document.getElementById('btnLogin');
    if (!code) { errorEl.textContent = 'Code eingeben.'; return; }
    errorEl.textContent = '';
    btn.disabled = true;
    try {
      const res = await authFetch(API_BASE + '?action=login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, vereinSlug: state.vereinSlug, mannschaftSlug: state.mannschaftSlug })
      });
      const data = await res.json();
      if (!res.ok || data.error) { errorEl.textContent = data.error || 'Anmeldung fehlgeschlagen.'; return; }

      await idbPut('settings', { key: 'role', value: data.rolle });
      await idbPut('settings', { key: 'nutzerName', value: data.name });
      await idbPut('settings', { key: 'sessionToken', value: data.token });
      state.role = data.rolle;
      state.nutzerName = data.name;
      state.sessionToken = data.token;
      document.getElementById('loginCode').value = '';
      applyRoleRestrictions();
      updateLoginScreenView();
      await postLoginInit();
    } catch (e) {
      errorEl.textContent = 'Kein Netz? Erste Anmeldung auf diesem Gerät braucht Internet. (' + e.message + ')';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnLogout').addEventListener('click', doLogout);

  document.getElementById('btnCodeAendern').addEventListener('click', async function () {
    const alterCode = document.getElementById('codeAlt').value.trim();
    const neuerCode = document.getElementById('codeNeu').value.trim();
    const wiederholung = document.getElementById('codeNeuWiederholen').value.trim();
    const errorEl = document.getElementById('codeAendernError');
    const btn = document.getElementById('btnCodeAendern');

    if (!alterCode || !neuerCode) { errorEl.textContent = 'Beide Felder ausfüllen.'; return; }
    if (neuerCode !== wiederholung) { errorEl.textContent = 'Neue Codes stimmen nicht überein.'; return; }

    btn.disabled = true;
    errorEl.textContent = '';
    try {
      const res = await authFetch(API_BASE + '?action=changeCode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alterCode: alterCode, neuerCode: neuerCode })
      });
      const data = await res.json();
      if (!res.ok || data.error) { errorEl.textContent = data.error || 'Ändern fehlgeschlagen.'; return; }
      document.getElementById('codeAlt').value = '';
      document.getElementById('codeNeu').value = '';
      document.getElementById('codeNeuWiederholen').value = '';
      alert('Code geändert. Beim nächsten Anmelden gilt der neue Code.');
    } catch (e) {
      errorEl.textContent = 'Kein Netz? (' + e.message + ')';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async function () {
    state.runde = document.getElementById('rundeSelect').value.trim();
    await idbPut('settings', { key: 'runde', value: state.runde });
    document.getElementById('gRunde').value = state.runde;
    await refreshRoster();
    alert('Gespeichert.');
  });

  document.getElementById('btnLoadRoster').addEventListener('click', loadRosterFromBackend);
  document.getElementById('btnExportAll').addEventListener('click', exportAllCSV);

  document.getElementById('btnKaderNeu').addEventListener('click', function () { openKaderForm(null); });
  document.getElementById('btnKaderAbbrechen').addEventListener('click', closeKaderForm);
  document.getElementById('btnKaderSpeichern').addEventListener('click', saveKaderForm);

  document.getElementById('btnForceUpdate').addEventListener('click', async function () {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
      location.reload();
    } catch (e) {
      alert('Fehler beim Aktualisieren: ' + e.message);
    }
  });

  document.getElementById('btnStartGame').addEventListener('click', startNewGame);
  document.getElementById('btnEndGame').addEventListener('click', endCurrentGame);

  document.getElementById('btnSquadConfirm').addEventListener('click', async function () {
    const selection = getSquadSelection();
    const game = await idbGet('games', state.currentGameId);
    if (game) {
      game.AktiveSpielerinnen = selection;
      await idbPut('games', game);
    }
    state.activeRosterNames = selection.length ? selection : null;
    await renderLiveScreen();
    showScreen('live');
  });

  document.getElementById('btnEditSquad').addEventListener('click', async function () {
    if (!state.currentGameId) { alert('Erst ein Spiel starten.'); return; }
    const game = await idbGet('games', state.currentGameId);
    renderSquadScreen(game && game.AktiveSpielerinnen && game.AktiveSpielerinnen.length ? game.AktiveSpielerinnen : null);
    showScreen('squad');
  });

  document.getElementById('btnAuswertungAnzeigen').addEventListener('click', showAuswertung);
  document.getElementById('btnErfasserUebersicht').addEventListener('click', showErfasserUebersicht);
  document.getElementById('btnExportAuswertung').addEventListener('click', exportAuswertungCSV);
  document.getElementById('btnExportAktionen').addEventListener('click', exportAktionenCSV);

  document.getElementById('syncBtn').addEventListener('click', function () { trySync(true); });

  document.querySelectorAll('#halbzeitToggle button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#halbzeitToggle button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.currentHalbzeit = btn.dataset.hz;
    });
  });
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  document.getElementById('screen-' + name).classList.add('active');
  document.querySelectorAll('nav.tabbar .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.screen === name); });
}

/* ---------- Kader vom Backend importieren (braucht Internet) ----------
 * Übergangs-Funktion für den bestehenden Kunden, solange dessen Kader noch
 * im Google Sheet gepflegt wird. Schreibt importierte Spielerinnen in die
 * lokalen 'kader'/'kader_runde'-Stores (synced:true, da sie vom Server
 * kommen) statt in einen separaten Snapshot-Store -- ab hier läuft alles
 * über dieselbe lokale Datenbasis wie "Kader verwalten".
 * Namensabgleich mit bereits lokal angelegten Spielerinnen verhindert
 * Duplikate beim Import.
 */
async function loadRosterFromBackend() {
  const runde = document.getElementById('rundeSelect').value.trim();
  document.getElementById('rosterStatus').textContent = 'Lade …';
  try {
    const res = await authFetch(API_BASE + '?action=roster&runde=' + encodeURIComponent(runde));
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const existingKader = await idbGetAll('kader');
    const existingByName = {};
    existingKader.forEach(function (k) { existingByName[k.Name] = k; });
    const existingRunde = await idbGetAll('kader_runde');
    const rundeByKaderId = {};
    existingRunde.filter(function (r) { return r.Runde === runde; }).forEach(function (r) { rundeByKaderId[r.kader_id] = r; });

    for (const p of data) {
      let kaderEntry = existingByName[p.Name];
      if (!kaderEntry) {
        kaderEntry = { id: uid(), Name: p.Name, Rückennummer: p.Rückennummer, Position: p.Position, synced: true };
      } else {
        kaderEntry.Rückennummer = p.Rückennummer;
        kaderEntry.Position = p.Position;
      }
      await idbPut('kader', kaderEntry);

      const rundeEntry = rundeByKaderId[kaderEntry.id] || { id: uid(), kader_id: kaderEntry.id, Runde: runde, Status: 'aktiv', synced: true };
      rundeEntry.Status = 'aktiv';
      await idbPut('kader_runde', rundeEntry);
    }

    await refreshRoster();
    renderPlayerStrip();
  } catch (e) {
    document.getElementById('rosterStatus').textContent = 'Fehler beim Laden – kein Netz? (' + e.message + ')';
  }
}

/* ---------- Kader (lokal, offline-fähig) ----------
 * state.roster ist kein eigener Store mehr, sondern das Ergebnis eines
 * Joins aus 'kader' (Stammdaten) und 'kader_runde' (Status je Runde) --
 * exakt die gleiche Logik wie zuvor server-seitig in getRoster()
 * (apps-script.gs), nur jetzt aus lokalen Daten berechnet, damit
 * "Kader verwalten" offline sofort wirkt.
 */
async function computeRoster() {
  const kader = await idbGetAll('kader');
  const kaderRunde = await idbGetAll('kader_runde');
  const aktivIds = new Set(
    kaderRunde.filter(function (r) { return r.Runde === state.runde && r.Status === 'aktiv'; })
      .map(function (r) { return r.kader_id; })
  );
  return {
    kaderGesamt: kader,
    roster: kader
      .filter(function (k) { return aktivIds.has(k.id); })
      .map(function (k) { return { SpielerinID: k.id, Name: k.Name, Rückennummer: k.Rückennummer, Position: k.Position }; })
  };
}

async function refreshRoster() {
  const result = await computeRoster();
  state.roster = result.roster;
  updateRosterStatus(result.kaderGesamt.length);
}

function updateRosterStatus(kaderGesamtCount) {
  const el = document.getElementById('rosterStatus');
  if (!kaderGesamtCount) {
    el.textContent = 'Noch kein Kader gepflegt -- unter "Kader jetzt laden" importieren oder im Tab "Kader" manuell anlegen.';
    return;
  }
  el.textContent = state.roster.length + ' von ' + kaderGesamtCount + ' Spielerinnen aktiv in der aktuellen Runde.';
}

let kaderEditingId = null;

async function renderKaderScreen() {
  document.getElementById('kaderRundeLabel').textContent = state.runde || '(keine Runde eingestellt)';
  const kader = (await idbGetAll('kader')).sort(function (a, b) { return a.Name.localeCompare(b.Name, 'de'); });
  const kaderRunde = await idbGetAll('kader_runde');
  const statusByKaderId = {};
  kaderRunde.filter(function (r) { return r.Runde === state.runde; }).forEach(function (r) { statusByKaderId[r.kader_id] = r; });

  const el = document.getElementById('kaderList');
  el.innerHTML = '';
  kader.forEach(function (k) {
    const rundeEntry = statusByKaderId[k.id];
    const aktiv = rundeEntry ? rundeEntry.Status === 'aktiv' : false;

    const row = document.createElement('div');
    row.className = 'action-group';
    row.style.cssText = 'margin-bottom:0.5rem; display:flex; align-items:center; gap:0.6rem;';

    const info = document.createElement('div');
    info.style.flex = '1';
    info.innerHTML = '<strong>' + (k.Rückennummer ? '#' + k.Rückennummer + ' ' : '') + k.Name + '</strong>' +
      (k.Position === 'TW' ? ' (TW)' : '') +
      (k.synced ? '' : ' · <span style="color:var(--warn)">nicht synchronisiert</span>');
    row.appendChild(info);

    const toggleLabel = document.createElement('label');
    toggleLabel.style.cssText = 'display:flex; align-items:center; gap:0.4rem; font-size:0.85rem; color:var(--text-dim);';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = aktiv;
    toggle.style.cssText = 'width:1.2rem;height:1.2rem;';
    toggle.addEventListener('change', function () { setKaderRundeStatus(k.id, toggle.checked); });
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(document.createTextNode('aktiv'));
    row.appendChild(toggleLabel);

    const editBtn = document.createElement('button');
    editBtn.className = 'secondary-btn';
    editBtn.textContent = 'Bearbeiten';
    editBtn.addEventListener('click', function () { openKaderForm(k); });
    row.appendChild(editBtn);

    el.appendChild(row);
  });
  if (!kader.length) {
    el.innerHTML = '<p class="aus-empty">Noch keine Spielerin angelegt.</p>';
  }
}

function openKaderForm(existing) {
  kaderEditingId = existing ? existing.id : null;
  document.getElementById('kaderFormTitle').textContent = existing ? 'Spielerin bearbeiten' : 'Neue Spielerin';
  document.getElementById('kName').value = existing ? existing.Name : '';
  document.getElementById('kNummer').value = existing ? (existing.Rückennummer || '') : '';
  document.getElementById('kPosition').value = existing ? existing.Position : 'Feld';
  document.getElementById('kaderFormError').textContent = '';
  document.getElementById('kaderForm').style.display = '';
}

function closeKaderForm() {
  document.getElementById('kaderForm').style.display = 'none';
  kaderEditingId = null;
}

async function saveKaderForm() {
  const name = document.getElementById('kName').value.trim();
  const nummer = document.getElementById('kNummer').value.trim();
  const position = document.getElementById('kPosition').value;
  const errorEl = document.getElementById('kaderFormError');

  if (!name) { errorEl.textContent = 'Name fehlt.'; return; }

  const alleKader = await idbGetAll('kader');
  const duplikat = alleKader.find(function (k) { return k.Name === name && k.id !== kaderEditingId; });
  if (duplikat) { errorEl.textContent = 'Name existiert bereits im Kader.'; return; }

  let kaderEntry;
  if (kaderEditingId) {
    kaderEntry = alleKader.find(function (k) { return k.id === kaderEditingId; });
    kaderEntry.Name = name;
    kaderEntry.Rückennummer = nummer;
    kaderEntry.Position = position;
    kaderEntry.synced = false;
  } else {
    kaderEntry = { id: uid(), Name: name, Rückennummer: nummer, Position: position, synced: false };
  }
  await idbPut('kader', kaderEntry);

  // Neue Spielerin ist ohne zweiten Schritt sofort aktiv in der laufenden Runde.
  if (!kaderEditingId && state.runde) {
    const kaderRundeAlle = await idbGetAll('kader_runde');
    const bestehend = kaderRundeAlle.find(function (r) { return r.kader_id === kaderEntry.id && r.Runde === state.runde; });
    await idbPut('kader_runde', bestehend || { id: uid(), kader_id: kaderEntry.id, Runde: state.runde, Status: 'aktiv', synced: false });
  }

  closeKaderForm();
  await refreshRoster();
  await renderKaderScreen();
  trySync();
}

async function setKaderRundeStatus(kaderId, aktiv) {
  if (!state.runde) { alert('Erst eine Runde in den Einstellungen setzen.'); return; }
  const kaderRundeAlle = await idbGetAll('kader_runde');
  let entry = kaderRundeAlle.find(function (r) { return r.kader_id === kaderId && r.Runde === state.runde; });
  if (!entry) entry = { id: uid(), kader_id: kaderId, Runde: state.runde, Status: 'aktiv' };
  entry.Status = aktiv ? 'aktiv' : 'inaktiv';
  entry.synced = false;
  await idbPut('kader_runde', entry);
  await refreshRoster();
  trySync();
}

/* ---------- Spiel anlegen ---------- */
let startingGame = false;

async function startNewGame() {
  if (startingGame) return;
  const datum = document.getElementById('gDatum').value || new Date().toISOString().slice(0, 10);
  const gegner = document.getElementById('gGegner').value.trim();
  const runde = document.getElementById('gRunde').value.trim() || state.runde;
  if (!gegner) { alert('Bitte Gegner eintragen.'); return; }

  startingGame = true;
  const btn = document.getElementById('btnStartGame');
  btn.disabled = true;
  try {
    const spiel = { SpielID: uid(), Datum: datum, Gegner: gegner, Runde: runde, Tore_eigene: '', Tore_gegner: '', Status: 'läuft', synced: false };
    await idbPut('games', spiel);
    state.currentGameId = spiel.SpielID;
    await idbPut('settings', { key: 'currentGameId', value: spiel.SpielID });

    await renderGameList();
    renderSquadScreen(null);
    showScreen('squad');
    trySync();
  } finally {
    btn.disabled = false;
    startingGame = false;
  }
}

function renderSquadScreen(preselected) {
  const el = document.getElementById('squadList');
  el.innerHTML = '';
  state.roster.forEach(function (p) {
    const checked = preselected ? preselected.indexOf(p.Name) !== -1 : true;
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0;border-bottom:1px solid #333a46;';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.name = p.Name;
    box.checked = checked;
    box.style.cssText = 'width:1.3rem;height:1.3rem;flex-shrink:0;';
    const label = document.createElement('span');
    label.textContent = (p.Rückennummer ? '#' + p.Rückennummer + ' ' : '') + p.Name + (p.Position === 'TW' ? ' (TW)' : '');
    row.appendChild(box);
    row.appendChild(label);
    el.appendChild(row);
  });
}

function getSquadSelection() {
  return Array.from(document.querySelectorAll('#squadList input[type=checkbox]:checked')).map(function (cb) { return cb.dataset.name; });
}

async function endCurrentGame() {
  if (!state.currentGameId) return;
  const game = await idbGet('games', state.currentGameId);
  if (!game) return;
  game.Tore_eigene = document.getElementById('eTore').value.trim();
  game.Tore_gegner = document.getElementById('eGegentore').value.trim();
  game.Status = 'beendet';
  game.synced = false;
  await idbPut('games', game);

  state.currentGameId = null;
  await idbPut('settings', { key: 'currentGameId', value: null });

  await renderGameList();
  await renderLiveScreen();
  showScreen(state.role === 'admin' ? 'game' : 'live');
  trySync();
}

function toreOderFragezeichen(v) {
  return (v === '' || v === undefined || v === null) ? '?' : v;
}

function renderGamesInto(containerId, games, onContinue) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  games.forEach(function (g) {
    const row = document.createElement('div');
    row.className = 'action-group';
    row.style.marginBottom = '0.5rem';
    const status = g.Status === 'beendet' ? ('beendet · ' + toreOderFragezeichen(g.Tore_eigene) + ':' + toreOderFragezeichen(g.Tore_gegner)) : 'läuft';
    row.innerHTML = '<strong>' + g.Gegner + '</strong> · ' + g.Datum + ' · ' + status + ' · ' + (g.synced ? 'synchronisiert' : 'noch nicht synchronisiert');
    const canContinue = state.role === 'admin' || g.Status !== 'beendet';
    if (canContinue) {
      const btn = document.createElement('button');
      btn.className = 'secondary-btn';
      btn.style.marginTop = '0.5rem';
      btn.textContent = g.SpielID === state.currentGameId ? 'Aktuell ausgewählt' : 'Fortsetzen';
      btn.addEventListener('click', function () { onContinue(g); });
      row.appendChild(btn);
    }
    el.appendChild(row);
  });
}

async function fetchRemoteSpiele() {
  if (!navigator.onLine) return null;
  try {
    const res = await authFetch(API_BASE + '?action=spiele');
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

async function mergedGames() {
  const localGames = await idbGetAll('games');
  const remoteGames = await fetchRemoteSpiele();

  if (remoteGames !== null) {
    const remoteIds = {};
    remoteGames.forEach(function (g) { remoteIds[g.SpielID] = true; });
    // Früher synchronisierte, jetzt im Sheet fehlende Spiele auch lokal entfernen
    // (dort gelöscht) – nur möglich, weil wir hier sicher wissen, dass der
    // Serverabgleich gerade erfolgreich war (remoteGames !== null).
    const toRemove = localGames.filter(function (g) { return g.synced && g.SpielID !== state.currentGameId && !remoteIds[g.SpielID]; });
    for (const g of toRemove) { await idbDelete('games', g.SpielID); }
  }

  const currentLocal = remoteGames !== null ? await idbGetAll('games') : localGames;
  const merged = {};
  (remoteGames || []).forEach(function (g) { merged[g.SpielID] = Object.assign({ synced: true }, g); });
  currentLocal.forEach(function (g) { merged[g.SpielID] = g; });
  return Object.keys(merged).map(function (k) { return merged[k]; });
}

async function continueGame(g) {
  const existing = await idbGet('games', g.SpielID);
  if (!existing) {
    await idbPut('games', Object.assign({ AktiveSpielerinnen: null, synced: true }, g));
  }
  state.currentGameId = g.SpielID;
  await idbPut('settings', { key: 'currentGameId', value: g.SpielID });
  const gameRecord = existing || g;
  state.activeRosterNames = (gameRecord.AktiveSpielerinnen && gameRecord.AktiveSpielerinnen.length) ? gameRecord.AktiveSpielerinnen : null;
  await renderLiveScreen();
  showScreen('live');
}

async function renderGameList() {
  const games = (await mergedGames()).sort(function (a, b) { return (b.Datum || '').localeCompare(a.Datum || ''); });
  renderGamesInto('gameList', games, continueGame);
  renderEndGameSection();
}

function renderEndGameSection() {
  const section = document.getElementById('endGameSection');
  section.style.display = state.currentGameId ? '' : 'none';
}

/* ---------- Live-Erfassung ---------- */
async function updateLiveScore() {
  const el = document.getElementById('liveScore');
  if (!state.currentGameId) { el.textContent = '–  :  –'; return; }
  const events = (await idbGetAll('events')).filter(function (e) { return e.SpielID === state.currentGameId; });
  const eigene = events.filter(function (e) { return e.Ergebnis === 'Treffer'; }).length;
  const gegner = events.filter(function (e) { return e.Ergebnis === 'Gegentor'; }).length;
  el.textContent = eigene + '  :  ' + gegner;
}

async function renderLiveScreen() {
  const picker = document.getElementById('liveGamePicker');
  const mainArea = document.getElementById('liveMainArea');

  if (!state.currentGameId) {
    picker.style.display = '';
    mainArea.style.display = 'none';
    const games = (await mergedGames())
      .filter(function (g) { return g.Status !== 'beendet'; })
      .sort(function (a, b) { return (b.Datum || '').localeCompare(a.Datum || ''); });
    renderGamesInto('liveGameList', games, continueGame);
    return;
  }

  picker.style.display = 'none';
  mainArea.style.display = '';
  const game = await idbGet('games', state.currentGameId);
  document.getElementById('liveGameName').textContent = game ? (game.Gegner || '') : '';
  renderPlayerStrip();
  renderWurfRows();
  renderGrid('ballgewinnGrid', BALLGEWINN);
  renderGrid('fehlerGrid', FEHLER);
  renderGrid('einzelGrid', EINZEL);
  renderEventList();
  updateLiveScore();
  renderEndGameSection();
  const selected = state.roster.find(function (r) { return r.SpielerinID === state.selectedPlayerId; });
  toggleTwView(selected ? selected.Position === 'TW' : false);
}

function renderPlayerStrip() {
  const elFeld = document.getElementById('playerStripFeld');
  const elTW = document.getElementById('playerStripTW');
  elFeld.innerHTML = '';
  elTW.innerHTML = '';
  const list = state.activeRosterNames
    ? state.roster.filter(function (p) { return state.activeRosterNames.indexOf(p.Name) !== -1; })
    : state.roster;
  const byName = function (a, b) { return a.Name.localeCompare(b.Name, 'de'); };
  const feld = list.filter(function (p) { return p.Position !== 'TW'; }).sort(byName);
  const tw = list.filter(function (p) { return p.Position === 'TW'; }).sort(byName);

  function buildChip(p) {
    const chip = document.createElement('button');
    chip.className = 'player-chip' + (p.SpielerinID === state.selectedPlayerId ? ' selected' : '');
    chip.innerHTML = (p.Rückennummer ? '<span class="num">#' + p.Rückennummer + '</span>' : '') + p.Name;
    chip.addEventListener('click', function () {
      state.selectedPlayerId = p.SpielerinID;
      renderPlayerStrip();
      toggleTwView(p.Position === 'TW');
    });
    return chip;
  }

  const half = Math.ceil(feld.length / 2);
  const row1 = document.createElement('div');
  row1.className = 'player-row';
  feld.slice(0, half).forEach(function (p) { row1.appendChild(buildChip(p)); });
  elFeld.appendChild(row1);
  if (feld.length > half) {
    const row2 = document.createElement('div');
    row2.className = 'player-row';
    feld.slice(half).forEach(function (p) { row2.appendChild(buildChip(p)); });
    elFeld.appendChild(row2);
  }

  tw.forEach(function (p) { elTW.appendChild(buildChip(p)); });
}

function toggleTwView(isTw) {
  document.getElementById('wurfGroup').style.display = isTw ? 'none' : '';
  document.getElementById('twGroup').style.display = isTw ? '' : 'none';
  document.getElementById('ballgewinnGrid').closest('.action-group').style.display = isTw ? 'none' : '';
  document.getElementById('fehlerGrid').closest('.action-group').style.display = isTw ? 'none' : '';
  document.getElementById('einzelGrid').closest('.action-group').style.display = isTw ? 'none' : '';
  if (isTw) renderTwRows();
}

/* Reihenfolge und Paarung exakt wie im bestätigten Vereins-Layout:
   Außen+Kreis / 6m+9m / 7m+Konter -- unabhängig von der internen
   WURF_ZONEN-Reihenfolge, die für Auswertung/Export weiterläuft. */
const COURT_ROWS = [['Außen', 'Kreis'], ['6m', '9m'], ['7m', 'Konter']];

function buildZoneTile(zone, hitLabel, missLabel, hitValue, missValue) {
  const tile = document.createElement('div');
  tile.className = 'zone-tile';
  const label = document.createElement('div');
  label.className = 'zone-label';
  label.textContent = zone;
  const btns = document.createElement('div');
  btns.className = 'zone-buttons';
  const missBtn = document.createElement('button');
  missBtn.className = 'btn-fehlwurf';
  missBtn.textContent = missLabel;
  missBtn.addEventListener('click', function () { addEvent(zone, missValue); });
  const hitBtn = document.createElement('button');
  hitBtn.className = 'btn-treffer';
  hitBtn.textContent = hitLabel;
  hitBtn.addEventListener('click', function () { addEvent(zone, hitValue); });
  btns.appendChild(missBtn);
  btns.appendChild(hitBtn);
  tile.appendChild(label);
  tile.appendChild(btns);
  return tile;
}

function renderCourtGrid(containerId, hitLabel, missLabel) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  COURT_ROWS.forEach(function (pair) {
    const row = document.createElement('div');
    row.className = 'court-row court-row-2';
    pair.forEach(function (zone) {
      row.appendChild(buildZoneTile(zone, hitLabel, missLabel, hitLabel, missLabel));
    });
    el.appendChild(row);
  });
}

function renderWurfRows() {
  renderCourtGrid('wurfRows', 'Treffer', 'Fehlwurf');
}

function renderTwRows() {
  renderCourtGrid('twRows', 'Parade', 'Gegentor');
  const el = document.getElementById('twRows');
  const extra = document.createElement('div');
  extra.className = 'btn-grid';
  extra.style.marginTop = '0.6rem';
  ['Assist', 'Fehlpass'].forEach(function (typ) {
    const btn = document.createElement('button');
    btn.textContent = typ;
    btn.addEventListener('click', function () { addEvent(typ, ''); });
    extra.appendChild(btn);
  });
  el.appendChild(extra);
}

function renderGrid(elementId, items) {
  const el = document.getElementById(elementId);
  el.innerHTML = '';
  items.forEach(function (typ) {
    const btn = document.createElement('button');
    btn.textContent = typ;
    btn.addEventListener('click', function () { addEvent(typ, ''); });
    el.appendChild(btn);
  });
}

const recentEvents = [];

async function addEvent(aktionstyp, ergebnis) {
  if (!state.currentGameId) { alert('Erst ein Spiel starten (Tab "Spiel").'); return; }
  if (!state.selectedPlayerId) { alert('Erst eine Spielerin oben auswählen.'); return; }
  const event = {
    AktionID: uid(),
    SpielID: state.currentGameId,
    SpielerinID: state.selectedPlayerId,
    Halbzeit: state.currentHalbzeit,
    Aktionstyp: aktionstyp,
    Ergebnis: ergebnis,
    Quelle: state.nutzerName || 'manuell',
    Zeitstempel: new Date().toISOString(),
    synced: false
  };
  await idbPut('events', event);
  recentEvents.unshift(event);
  if (recentEvents.length > 8) recentEvents.pop();
  renderEventList();
  updateStatusBar();
  updateLiveScore();
  trySync();
}

function playerName(id) {
  const p = state.roster.find(function (r) { return r.SpielerinID === id; });
  return p ? p.Name : id;
}

function renderEventList() {
  const ul = document.getElementById('eventList');
  ul.innerHTML = '';
  recentEvents.forEach(function (ev) {
    const li = document.createElement('li');
    const label = playerName(ev.SpielerinID) + ' · ' + ev.Aktionstyp + (ev.Ergebnis ? ' (' + ev.Ergebnis + ')' : '') + ' · HZ' + ev.Halbzeit;
    li.innerHTML = '<span>' + label + '</span>';
    const undoBtn = document.createElement('button');
    undoBtn.className = 'undo-btn';
    undoBtn.textContent = '↩ Rückgängig';
    undoBtn.addEventListener('click', async function () {
      await idbDelete('events', ev.AktionID);
      const idx = recentEvents.indexOf(ev);
      if (idx !== -1) recentEvents.splice(idx, 1);
      renderEventList();
      updateStatusBar();
      updateLiveScore();
      if (ev.synced) alert('Achtung: Diese Aktion war schon synchronisiert und muss im Google Sheet manuell gelöscht werden.');
    });
    li.appendChild(undoBtn);
    ul.appendChild(li);
  });
}

/* ---------- Sync ---------- */
async function trySync(manual) {
  if (state.syncing) { if (manual) alert('Synchronisierung läuft schon.'); return; }
  state.syncing = true;
  try {
    await trySyncInner(manual);
  } finally {
    state.syncing = false;
  }
}

async function trySyncInner(manual) {
  if (!navigator.onLine) { updateStatusBar(); if (manual) alert('Kein Netz gerade.'); return; }

  const games = (await idbGetAll('games')).filter(function (g) { return !g.synced; });
  const events = (await idbGetAll('events')).filter(function (e) { return !e.synced; });
  // TODO(Schritt 3, D1-Cutover): Der aktuelle Apps-Script-Endpunkt kennt
  // 'kader'/'kader_runde' noch nicht -- diese Einträge werden gesendet,
  // vom Backend aber ignoriert und bleiben bis zum D1-Cutover bewusst
  // als "nicht synchronisiert" stehen (sichtbar in der Statusleiste).
  const kaderChanges = (await idbGetAll('kader')).filter(function (k) { return !k.synced; });
  const kaderRundeChanges = (await idbGetAll('kader_runde')).filter(function (r) { return !r.synced; });
  if (!games.length && !events.length && !kaderChanges.length && !kaderRundeChanges.length) {
    updateStatusBar(); if (manual) alert('Alles schon synchron.'); return;
  }

  try {
    const res = await authFetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ spiele: games, aktionen: events, kader: kaderChanges, kader_runde: kaderRundeChanges })
    });
    const data = await res.json();
    if (data.status !== 'ok') throw new Error('Backend meldet Fehler');

    const confirmedSpiele = (data.results && data.results.spiele) || [];
    const confirmedAktionen = (data.results && data.results.aktionen) || [];
    const confirmedKader = (data.results && data.results.kader) || [];
    const confirmedKaderRunde = (data.results && data.results.kader_runde) || [];

    for (const g of games) {
      if (confirmedSpiele.indexOf(g.SpielID) !== -1) {
        g.synced = true;
        await idbPut('games', g);
      }
    }
    for (const e of events) {
      if (confirmedAktionen.indexOf(e.AktionID) !== -1) {
        e.synced = true;
        await idbPut('events', e);
        const r = recentEvents.find(function (r) { return r.AktionID === e.AktionID; });
        if (r) r.synced = true;
      }
    }
    for (const k of kaderChanges) {
      if (confirmedKader.indexOf(k.id) !== -1) { k.synced = true; await idbPut('kader', k); }
    }
    for (const r of kaderRundeChanges) {
      if (confirmedKaderRunde.indexOf(r.id) !== -1) { r.synced = true; await idbPut('kader_runde', r); }
    }
    await renderGameList();
    updateStatusBar();
    if (manual) alert('Synchronisiert.');
  } catch (e) {
    updateStatusBar();
    if (manual) alert('Sync fehlgeschlagen: ' + e.message);
  }
}

async function updateStatusBar() {
  const dot = document.getElementById('statusDot');
  const online = navigator.onLine;
  dot.classList.toggle('online', online);
  dot.classList.toggle('offline', !online);

  const games = (await idbGetAll('games')).filter(function (g) { return !g.synced; }).length;
  const events = (await idbGetAll('events')).filter(function (e) { return !e.synced; }).length;
  const kaderPending = (await idbGetAll('kader')).filter(function (k) { return !k.synced; }).length;
  const kaderRundePending = (await idbGetAll('kader_runde')).filter(function (r) { return !r.synced; }).length;
  const pending = games + events + kaderPending + kaderRundePending;
  document.getElementById('pending').textContent = online
    ? (pending ? pending + ' Einträge warten auf Sync' : 'Alles synchron')
    : (pending ? pending + ' Einträge lokal gespeichert (offline)' : 'Offline · keine ausstehenden Einträge');
}

/* ---------- Auswertung ---------- */

async function populateAuswertungSelects() {
  const spielerinSelect = document.getElementById('ausSpielerin');
  spielerinSelect.innerHTML = '';
  state.roster.forEach(function (p) {
    const opt = document.createElement('option');
    opt.value = p.SpielerinID;
    opt.textContent = p.Name;
    spielerinSelect.appendChild(opt);
  });

  const zeitraumSelect = document.getElementById('ausZeitraum');
  zeitraumSelect.innerHTML = '<option value="runde">Ganze Runde (' + (state.runde || '–') + ')</option>';

  try {
    const res = await authFetch(API_BASE + '?action=spiele');
    const spiele = await res.json();
    spiele
      .filter(function (s) { return s.Runde === state.runde; })
      .sort(function (a, b) { return (a.Datum || '').localeCompare(b.Datum || ''); })
      .forEach(function (s) {
        const opt = document.createElement('option');
        opt.value = s.SpielID;
        opt.textContent = s.Datum + ' · ' + s.Gegner;
        opt.dataset.datum = s.Datum;
        opt.dataset.gegner = s.Gegner;
        zeitraumSelect.appendChild(opt);
      });
  } catch (e) {
    // Kein Netz gerade -> nur "Ganze Runde" bleibt wählbar, kein harter Fehler.
  }
}

let lastAuswertungExport = null;

function selectedSpielInfo() {
  const sel = document.getElementById('ausZeitraum');
  const opt = sel.options[sel.selectedIndex];
  return { datum: (opt && opt.dataset.datum) || '', gegner: (opt && opt.dataset.gegner) || '' };
}

async function showAuswertung() {
  const el = document.getElementById('ausErgebnis');
  const zeitraum = document.getElementById('ausZeitraum').value;
  const spielerinId = document.getElementById('ausSpielerin').value;
  const teamGesamt = document.getElementById('ausTeamGesamt').checked;
  const spielInfo = selectedSpielInfo();
  el.innerHTML = '<p class="aus-empty">Lade …</p>';

  const rundeParam = zeitraum === 'runde' ? '&runde=' + encodeURIComponent(state.runde) : '';

  if (teamGesamt) {
    try {
      const res = await authFetch(API_BASE + '?action=auswertung&scope=team&zeitraum=' + encodeURIComponent(zeitraum) + rundeParam);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      lastAuswertungExport = { type: 'team', data: data, spielInfo: spielInfo };
      renderTeamAuswertung(el, data);
    } catch (e) {
      el.innerHTML = '<p class="aus-empty">Fehler beim Laden – kein Netz? (' + e.message + ')</p>';
      lastAuswertungExport = null;
    }
    return;
  }

  try {
    const res = await authFetch(API_BASE + '?action=auswertung&scope=spielerin&spielerinId=' + encodeURIComponent(spielerinId) + '&zeitraum=' + encodeURIComponent(zeitraum) + rundeParam);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastAuswertungExport = { type: 'spielerin', data: data, zeitraum: zeitraum, spielInfo: spielInfo };
    renderAuswertung(el, data);
  } catch (e) {
    el.innerHTML = '<p class="aus-empty">Fehler beim Laden – kein Netz? (' + e.message + ')</p>';
    lastAuswertungExport = null;
  }
}

/* Eine Zonen-Kachel wie in der Erfassung, aber statt zweier Tipp-Buttons
   eine kleine Tabelle mit HZ1/HZ2/Gesamt + Quote. */
function auswertungZoneTileHtml(zone, hz1, hz2, gesamt, isTW) {
  const erfolgLabel = isTW ? 'Paraden' : 'Treffer';
  const missLabel = isTW ? 'Gegentore' : 'Fehlwurf';
  function zeile(label, stats) {
    const v = stats[zone + '_Versuche'] || 0;
    const e = stats[zone + '_Erfolg'] || 0;
    const quote = v ? (Math.round((e / v) * 1000) / 10) + '%' : '–';
    return '<tr><td>' + label + '</td><td>' + e + '</td><td>' + (v - e) + '</td><td>' + quote + '</td></tr>';
  }
  return '<div class="zone-tile ausz-tile"><div class="zone-label">' + zone + '</div>' +
    '<table class="ausz-table"><tr><th></th><th>' + erfolgLabel + '</th><th>' + missLabel + '</th><th>Quote</th></tr>' +
    zeile('HZ1', hz1) + zeile('HZ2', hz2) + zeile('Gesamt', gesamt) +
    '</table></div>';
}

function auswertungCourtHtml(hz1, hz2, gesamt, isTW) {
  let html = '';
  COURT_ROWS.forEach(function (pair) {
    html += '<div class="court-row court-row-2">';
    pair.forEach(function (zone) { html += auswertungZoneTileHtml(zone, hz1, hz2, gesamt, isTW); });
    html += '</div>';
  });
  return html;
}

function simpleTableHtml(title, items, row) {
  let t = '<div class="aus-section-title">' + title + '</div><table class="aus-table">';
  items.forEach(function (k) { t += '<tr><td>' + k + '</td><td>' + (row[k] || 0) + '</td></tr>'; });
  t += '</table>';
  return t;
}

function renderAuswertung(el, data) {
  const isTW = data.position === 'TW';
  let html = auswertungCourtHtml(data.HZ1, data.HZ2, data.Gesamt, isTW);
  html += isTW
    ? simpleTableHtml('Einzelereignisse', ['Assist', 'Fehlpass'], data.Gesamt)
    : simpleTableHtml('Ballgewinn', BALLGEWINN, data.Gesamt) + simpleTableHtml('Eigener Fehler', FEHLER, data.Gesamt) + simpleTableHtml('Einzelereignisse', EINZEL, data.Gesamt);
  el.innerHTML = html;
}

function renderTeamAuswertung(el, data) {
  function block(titel, teil, isTW) {
    let html = '<h2 style="margin-top:1.2rem">' + titel + '</h2>' + auswertungCourtHtml(teil.HZ1, teil.HZ2, teil.Gesamt, isTW);
    html += isTW
      ? simpleTableHtml('Einzelereignisse', ['Assist', 'Fehlpass'], teil.Gesamt)
      : simpleTableHtml('Ballgewinn', BALLGEWINN, teil.Gesamt) + simpleTableHtml('Eigener Fehler', FEHLER, teil.Gesamt) + simpleTableHtml('Einzelereignisse', EINZEL, teil.Gesamt);
    return html;
  }
  el.innerHTML = block('Angriff (Feldspielerinnen)', data.Feld, false) + block('Abwehr / Torwart', data.TW, true);
}

/* ---------- CSV-Export ---------- */

function toCSVValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.indexOf(';') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadCSV(filename, rows) {
  const csv = rows.map(function (row) { return row.map(toCSVValue).join(';'); }).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function statsRowsForCSV(hz1, hz2, gesamt, isTW) {
  const out = [];
  out.push(['Zone', 'Halbzeit', isTW ? 'Paraden' : 'Treffer', isTW ? 'Gegentore' : 'Fehlwurf', 'Quote']);
  WURF_ZONEN.forEach(function (z) {
    [['HZ1', hz1], ['HZ2', hz2], ['Gesamt', gesamt]].forEach(function (pair) {
      const label = pair[0], stats = pair[1];
      const v = stats[z + '_Versuche'] || 0;
      const e = stats[z + '_Erfolg'] || 0;
      const q = v ? (Math.round((e / v) * 1000) / 10) + '%' : '';
      out.push([z, label, e, v - e, q]);
    });
  });
  out.push([]);
  if (isTW) {
    out.push(['Einzelereignisse (gesamtes Spiel/Runde)']);
    ['Assist', 'Fehlpass'].forEach(function (k) { out.push([k, gesamt[k] || 0]); });
  } else {
    out.push(['Ballgewinn (gesamtes Spiel/Runde)']);
    BALLGEWINN.forEach(function (k) { out.push([k, gesamt[k] || 0]); });
    out.push([]);
    out.push(['Eigener Fehler (gesamtes Spiel/Runde)']);
    FEHLER.forEach(function (k) { out.push([k, gesamt[k] || 0]); });
    out.push([]);
    out.push(['Einzelereignisse (gesamtes Spiel/Runde)']);
    EINZEL.forEach(function (k) { out.push([k, gesamt[k] || 0]); });
  }
  return out;
}

function sanitizeFilenamePart(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
}

function exportAuswertungCSV() {
  if (!lastAuswertungExport) { alert('Erst eine Auswertung anzeigen.'); return; }
  let rows = [];
  let filename = 'auswertung.csv';
  const info = lastAuswertungExport.spielInfo || { datum: '', gegner: '' };
  const praefix = info.datum
    ? sanitizeFilenamePart(info.datum) + '_' + sanitizeFilenamePart(info.gegner)
    : sanitizeFilenamePart(state.runde);

  if (lastAuswertungExport.type === 'spielerin') {
    const data = lastAuswertungExport.data;
    if (!data) { alert('Keine Daten zum Exportieren.'); return; }
    const name = document.getElementById('ausSpielerin').selectedOptions[0].textContent;
    const isTW = data.position === 'TW';
    rows.push([name + (isTW ? ' (TW)' : '')]);
    rows.push([]);
    rows = rows.concat(statsRowsForCSV(data.HZ1, data.HZ2, data.Gesamt, isTW));
    filename = praefix + '_' + sanitizeFilenamePart(name) + '_Auswertung.csv';
  } else if (lastAuswertungExport.type === 'team') {
    const data = lastAuswertungExport.data;
    ['Feld', 'TW'].forEach(function (gruppe) {
      const isTW = gruppe === 'TW';
      rows.push([isTW ? 'Abwehr / Torwart' : 'Angriff (Feldspielerinnen)']);
      rows = rows.concat(statsRowsForCSV(data[gruppe].HZ1, data[gruppe].HZ2, data[gruppe].Gesamt, isTW));
      rows.push([]);
    });
    filename = praefix + '_Team_Auswertung.csv';
  }
  downloadCSV(filename, rows);
}

async function exportAktionenCSV() {
  const zeitraum = document.getElementById('ausZeitraum').value;
  if (zeitraum === 'runde') { alert('Bitte oben ein einzelnes Spiel auswählen (nicht „Ganze Runde"), um die Einzelaktionen zu exportieren.'); return; }
  const info = selectedSpielInfo();
  try {
    const res = await authFetch(API_BASE + '?action=aktionenSpiel&spielId=' + encodeURIComponent(zeitraum));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const rows = [['AktionID', 'SpielID', 'SpielerinID', 'Halbzeit', 'Aktionstyp', 'Ergebnis', 'Quelle', 'Zeitstempel']];
    data.forEach(function (a) {
      rows.push([a.AktionID, a.SpielID, a.SpielerinID, a.Halbzeit, a.Aktionstyp, a.Ergebnis, a.Quelle, a.Zeitstempel]);
    });
    const filename = sanitizeFilenamePart(info.datum) + '_' + sanitizeFilenamePart(info.gegner) + '_Aktionen.csv';
    downloadCSV(filename, rows);
  } catch (e) {
    alert('Fehler beim Export: ' + e.message);
  }
}

/* ---------- Komplettexport (Datenhoheit -- Kunde kann jederzeit alles mitnehmen) ---------- */
async function exportAllCSV() {
  const btn = document.getElementById('btnExportAll');
  btn.disabled = true;
  try {
    const res = await authFetch(API_BASE + '?action=exportAll');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const datum = new Date().toISOString().slice(0, 10);
    const praefix = datum + '_' + sanitizeFilenamePart(state.runde || 'export');

    const tabellen = [
      { name: 'kader', spalten: ['SpielerinID', 'Name', 'Rückennummer', 'Position'], rows: data.kader },
      { name: 'kader_runde', spalten: ['SpielerinID', 'Runde', 'Status'], rows: data.kader_runde },
      { name: 'spiele', spalten: ['SpielID', 'Datum', 'Gegner', 'Runde', 'Tore_eigene', 'Tore_gegner', 'Status'], rows: data.spiele },
      { name: 'aktionen', spalten: ['AktionID', 'SpielID', 'SpielerinID', 'Halbzeit', 'Aktionstyp', 'Ergebnis', 'Quelle', 'Zeitstempel'], rows: data.aktionen }
    ];

    tabellen.forEach(function (t) {
      const csvRows = [t.spalten];
      (t.rows || []).forEach(function (r) { csvRows.push(t.spalten.map(function (s) { return r[s]; })); });
      downloadCSV(praefix + '_' + t.name + '.csv', csvRows);
    });
  } catch (e) {
    alert('Export fehlgeschlagen – kein Netz? (' + e.message + ')');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Erfasser-Übersicht (nach Quelle/Nutzer) ---------- */

async function showErfasserUebersicht() {
  const zeitraum = document.getElementById('ausZeitraum').value;
  const el = document.getElementById('ausErgebnis');
  if (zeitraum === 'runde') {
    el.innerHTML = '<p class="aus-empty">Bitte oben ein einzelnes Spiel auswählen (nicht „Ganze Runde"), um zu sehen, wer was erfasst hat.</p>';
    return;
  }
  el.innerHTML = '<p class="aus-empty">Lade …</p>';
  lastAuswertungExport = null;
  try {
    const res = await authFetch(API_BASE + '?action=aktionenSpiel&spielId=' + encodeURIComponent(zeitraum));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const counts = {};
    data.forEach(function (a) {
      const q = a.Quelle || 'unbekannt';
      counts[q] = (counts[q] || 0) + 1;
    });
    const namen = Object.keys(counts).sort();
    if (!namen.length) { el.innerHTML = '<p class="aus-empty">Keine Aktionen für dieses Spiel.</p>'; return; }
    let html = '<div class="aus-section-title">Aktionen nach Erfasser</div><table class="aus-table"><tr><th>Erfasser</th><th>Anzahl Aktionen</th></tr>';
    namen.forEach(function (k) { html += '<tr><td>' + k + '</td><td>' + counts[k] + '</td></tr>'; });
    html += '</table>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<p class="aus-empty">Fehler beim Laden: ' + e.message + '</p>';
  }
}
