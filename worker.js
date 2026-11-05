// Vocab Cards — Cloudflare Worker
// Serves the flashcard app at "/" and finds pictures for each word.
//
// Optional secrets (Worker > Settings > Variables and Secrets):
//   ACCESS_CODE  – a passcode the app must send; stops strangers using your Worker
//   PIXABAY_KEY  – free key from pixabay.com/api/docs  (adds Pixabay results)
//   PEXELS_KEY   – free key from pexels.com/api        (adds Pexels results)
// ARASAAC and Openverse need no key.

const UA = "vocab-cards/1.0 (personal flashcard app)";
const IMG_HOSTS = ["static.arasaac.org", "api.openverse.org", "pixabay.com", "cdn.pixabay.com", "images.pexels.com"];
const MAX_CANDS = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }

    if (url.pathname.startsWith("/api/")) {
      if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
        return json({ error: "access code required" }, 401);
      }
      if (url.pathname === "/api/ping") return json({ ok: true, pixabay: !!env.PIXABAY_KEY, pexels: !!env.PEXELS_KEY });
      if (url.pathname === "/api/search") return json(await search(url.searchParams, env));
      if (url.pathname === "/api/img") return proxyImage(url.searchParams.get("u"));
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---------- search ----------
async function search(p, env) {
  const photo = clip(p.get("q") || p.get("en"));
  const picto = clip(p.get("picto") || p.get("en") || photo);
  const en = clip(p.get("en"));
  const type = p.get("type") === "abstract" ? "abstract" : "concrete";
  const style = p.get("style") === "photos" ? "photos" : "drawings";
  if (!photo && !picto) return { cands: [] };

  let cands = await runPlan(plan(type, style, photo, picto), env);

  // Nothing found: retry with the plain English meaning.
  if (!cands.length && en && en !== photo && en !== picto) {
    cands = await runPlan(plan(type, style, en, en), env);
  }
  return { cands: cands.slice(0, MAX_CANDS) };
}

// Order of sources, best first.
function plan(type, style, photo, picto) {
  if (style === "drawings") {
    return [
      ["arasaac", picto],
      ["pixabay", photo, "illustration"],
      ["openverse", photo, "illustration"],
      ["openverse", photo, ""],
      ["pexels", photo],
    ];
  }
  if (type === "abstract") {
    return [["arasaac", picto], ["pixabay", photo, "all"], ["openverse", photo, ""], ["pexels", photo]];
  }
  return [["pixabay", photo, "photo"], ["openverse", photo, ""], ["pexels", photo], ["arasaac", picto]];
}

async function runPlan(steps, env) {
  const results = await Promise.all(steps.map(([src, q, opt]) => SOURCES[src](q, opt, env).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of results) {
    for (const c of list.slice(0, 2)) {           // top 2 from each source keeps variety
      if (c.url && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
    }
  }
  return out;
}

const SOURCES = {
  async arasaac(q) {
    if (!q) return [];
    const r = await get(`https://api.arasaac.org/v1/pictograms/en/search/${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const list = await r.json();
    return (Array.isArray(list) ? list : []).slice(0, 3).map((x) => ({
      source: "ARASAAC",
      url: `https://static.arasaac.org/pictograms/${x._id}/${x._id}_500.png`,
      credit: "Pictogram by Sergio Palao for ARASAAC (Government of Aragón), CC BY-NC-SA",
      link: "https://arasaac.org",
    }));
  },

  async openverse(q, category) {
    if (!q) return [];
    let u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=5&mature=false`;
    if (category) u += `&category=${category}`;
    const r = await get(u);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).map((x) => ({
      source: "Openverse",
      url: x.thumbnail || `https://api.openverse.org/v1/images/${x.id}/thumb/`,
      credit: x.attribution || [x.title, x.creator, x.license && `CC ${String(x.license).toUpperCase()}`].filter(Boolean).join(" · "),
      link: x.foreign_landing_url || "",
    }));
  },

  async pixabay(q, imageType, env) {
    if (!q || !env.PIXABAY_KEY) return [];
    const u = `https://pixabay.com/api/?key=${env.PIXABAY_KEY}&q=${encodeURIComponent(q)}&image_type=${imageType || "all"}&safesearch=true&per_page=5`;
    const r = await get(u);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.hits || []).map((x) => ({
      source: "Pixabay",
      url: x.webformatURL,
      credit: `Image by ${x.user} via Pixabay`,
      link: x.pageURL,
    }));
  },

  async pexels(q, _opt, env) {
    if (!q || !env.PEXELS_KEY) return [];
    const r = await get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5`, { Authorization: env.PEXELS_KEY });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.photos || []).map((x) => ({
      source: "Pexels",
      url: x.src && (x.src.medium || x.src.large),
      credit: `Photo by ${x.photographer} on Pexels`,
      link: x.url,
    }));
  },
};

// ---------- image proxy (so the app can save pictures on your phone) ----------
async function proxyImage(raw) {
  let u;
  try { u = new URL(raw || ""); } catch { return new Response("bad url", { status: 400 }); }
  if (u.protocol !== "https:" || !IMG_HOSTS.includes(u.hostname)) return new Response("host not allowed", { status: 403 });
  const r = await fetch(u.toString(), { headers: { "User-Agent": UA }, cf: { cacheTtl: 86400, cacheEverything: true }, redirect: "follow" });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return new Response("not an image", { status: 502 });
  return new Response(r.body, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}

// ---------- helpers ----------
function get(u, headers = {}) {
  return fetch(u, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, cf: { cacheTtl: 3600 } });
}
function clip(s) { return String(s || "").trim().slice(0, 100); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

// ---------- the app page ----------
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Vocab Cards</title>
<style>
:root{--bg:#f5f2ea;--card:#fffdf8;--ink:#1d1b18;--muted:#6f6a61;--line:#e2dccf;--accent:#b93a28;--accent-ink:#fff;--ok:#2f7a4f;--warn:#9a5b00}
@media (prefers-color-scheme: dark){:root{--bg:#151412;--card:#1f1e1b;--ink:#f1ede4;--muted:#a49e93;--line:#35322c;--accent:#e0624c;--accent-ink:#fff;--ok:#62b585;--warn:#e0a54a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top)) 16px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
header h1{font-size:17px;margin:0;font-weight:700;letter-spacing:.02em}
header h1 span{color:var(--accent)}
nav{display:flex;gap:4px}
nav button{background:none;border:0;color:var(--muted);font:inherit;font-size:14px;padding:6px 10px;border-radius:8px}
nav button.on{color:var(--ink);background:var(--line)}
main{max-width:560px;margin:0 auto;padding:16px 16px calc(32px + env(safe-area-inset-bottom))}
h2{font-size:20px;margin:4px 0 12px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:13px}
button{font:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:15px;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.btn.danger{color:var(--accent)}
.btn:disabled{opacity:.5}
.row{display:flex;gap:8px;margin-top:10px}
.row .btn{flex:1}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
.deck{display:flex;align-items:center;justify-content:space-between;gap:10px}
.deck b{display:block;font-size:16px}
.deck .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.deck .acts .btn{min-height:38px;padding:0 12px;font-size:14px}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 6px}
input[type=text],input[type=password],textarea,select{width:100%;font:inherit;font-size:16px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
textarea{min-height:180px;font-family:ui-monospace,Menlo,monospace;font-size:13px}
.check{display:flex;align-items:center;gap:10px;margin-top:12px;color:var(--ink)}
.check input{width:20px;height:20px}
.log{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;color:var(--muted);margin-top:12px;max-height:220px;overflow:auto}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:12px}
.bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .2s}
.studyhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.link{background:none;border:0;color:var(--accent);padding:0;font-size:15px;cursor:pointer}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;min-height:380px;padding:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;-webkit-user-select:none;position:relative}
.pic{width:100%;max-height:300px;object-fit:contain;border-radius:12px;background:#fff}
.pic.bw{filter:grayscale(1) contrast(1.15)}
.nopic{width:100%;height:200px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.jp{font-size:40px;font-weight:700;line-height:1.2;margin-top:14px}
.card > .jp:first-child{margin-top:0;font-size:52px}
.sub{color:var(--muted);font-size:18px;margin-top:2px}
.en{font-size:20px;margin-top:10px}
.pos{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
.ex{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:16px;width:100%}
.credit{margin-top:12px;font-size:11px;color:var(--muted);word-break:break-word}
.credit a{color:var(--muted)}
.hint{position:absolute;bottom:10px;left:0;right:0;font-size:12px;color:var(--muted)}
.note{font-size:14px;padding:10px 12px;border-radius:12px;background:var(--line);margin-top:12px}
.ok{color:var(--ok)}.warn{color:var(--warn)}
.empty ol{padding-left:20px;margin:0}
.empty li{margin-bottom:6px}
</style>
</head>
<body>
<header>
  <h1>Vocab <span>Cards</span></h1>
  <nav>
    <button data-act="go" data-arg="decks">Decks</button>
    <button data-act="go" data-arg="add">Add</button>
    <button data-act="go" data-arg="settings">Settings</button>
  </nav>
</header>
<main id="app"></main>
<script>
(function(){
var app = document.getElementById('app');
var S = { view: 'decks', decks: [], deck: null, order: [], i: 0, flipped: false, busy: false, result: null };
var settings = loadSettings();
var urlMap = new WeakMap();

function loadSettings(){
  var d = { code: '', style: 'drawings', bw: true, front: 'picture' };
  try { var s = JSON.parse(localStorage.getItem('vc-settings') || '{}'); for (var k in s) d[k] = s[k]; } catch (e) {}
  return d;
}
function saveSettings(){ try { localStorage.setItem('vc-settings', JSON.stringify(settings)); } catch (e) {} }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
function enc(s){ return encodeURIComponent(s || ''); }

/* ---------- storage (IndexedDB, on this device) ---------- */
var dbp = null;
function db(){
  if (!dbp) dbp = new Promise(function(res, rej){
    var r = indexedDB.open('vocab-cards', 1);
    r.onupgradeneeded = function(){ r.result.createObjectStore('decks', { keyPath: 'id' }); };
    r.onsuccess = function(){ res(r.result); };
    r.onerror = function(){ rej(r.error); };
  });
  return dbp;
}
function store(mode, fn){
  return db().then(function(d){
    return new Promise(function(res, rej){
      var t = d.transaction('decks', mode);
      var req = fn(t.objectStore('decks'));
      t.oncomplete = function(){ res(req ? req.result : undefined); };
      t.onerror = function(){ rej(t.error); };
      t.onabort = function(){ rej(t.error); };
    });
  });
}
function getDecks(){ return store('readonly', function(s){ return s.getAll(); }); }
function putDeck(d){ return store('readwrite', function(s){ return s.put(d); }); }
function delDeck(id){ return store('readwrite', function(s){ return s.delete(id); }); }

/* ---------- server calls ---------- */
function api(path){
  return fetch(path, { headers: { 'x-access-code': settings.code || '' } }).then(function(r){
    if (r.status === 401) throw new Error('The access code is wrong or missing. Set it in Settings.');
    if (!r.ok) throw new Error('Server error ' + r.status);
    return r;
  });
}

/* ---------- import ---------- */
function parseInput(text){
  var t = String(text || '').trim();
  var a = t.indexOf('{'), b = t.indexOf('[');
  var start = a < 0 ? b : (b < 0 ? a : Math.min(a, b));
  if (start < 0) throw new Error('No JSON found. Paste the whole reply from Claude.');
  var end = t.charAt(start) === '{' ? t.lastIndexOf('}') : t.lastIndexOf(']');
  var obj;
  try { obj = JSON.parse(t.slice(start, end + 1)); } catch (e) { throw new Error('That JSON is incomplete or broken. Copy the reply again.'); }
  var words = Array.isArray(obj) ? obj : (obj.words || []);
  words = words.filter(function(w){ return w && (w.jp || w.kana); });
  if (!words.length) throw new Error('Found JSON but no words in it.');
  return { words: words, corrections: obj.corrections || [], unreadable: obj.unreadable || [], count: obj.count };
}
function toCard(w){
  return {
    jp: w.jp || w.kana, kana: w.kana || '', kanji: w.kanji || '', en: w.en || '', pos: w.pos || '',
    type: w.type === 'abstract' ? 'abstract' : 'concrete',
    photo_query: w.photo_query || w.en || '', picto_query: w.picto_query || w.en || '',
    example_jp: w.example_jp || '', example_en: w.example_en || '',
    cands: [], pick: 0, img: null
  };
}
function findImage(c){
  var q = '/api/search?q=' + enc(c.photo_query) + '&picto=' + enc(c.picto_query) + '&en=' + enc(c.en) +
          '&type=' + enc(c.type) + '&style=' + enc(settings.style);
  return api(q).then(function(r){ return r.json(); }).then(function(d){
    c.cands = d.cands || [];
    return pickImage(c, 0);
  });
}
function pickImage(c, start){
  var n = c.cands.length, tries = 0;
  if (!n) return Promise.resolve(false);
  function attempt(k){
    if (tries >= n) return Promise.resolve(false);
    tries++;
    var j = ((k % n) + n) % n;
    return api('/api/img?u=' + enc(c.cands[j].url))
      .then(function(r){ return r.blob(); })
      .then(function(blob){
        if (!blob.size || (blob.type && blob.type.indexOf('image') !== 0)) throw new Error('not an image');
        c.img = blob; c.pick = j; return true;
      })
      .catch(function(err){
        if (err && /access code/.test(err.message)) throw err;
        return attempt(j + 1);
      });
  }
  return attempt(start);
}
function buildDeck(name, parsed, onProgress){
  var deck = { id: 'd' + Date.now(), name: name, created: Date.now(), cards: parsed.words.map(toCard) };
  var n = deck.cards.length, next = 0, done = 0, missing = [];
  function lane(){
    if (next >= n) return Promise.resolve();
    var c = deck.cards[next++];
    return findImage(c).then(function(ok){
      done++;
      if (!ok) missing.push(c.jp);
      onProgress(done, n, c.jp + (ok ? '' : '  — no picture found'));
    }).then(lane);
  }
  return Promise.all([lane(), lane(), lane()])
    .then(function(){ return putDeck(deck); })
    .then(function(){ return { deck: deck, missing: missing }; });
}

/* ---------- backup ---------- */
function blobToDataURL(b){
  return new Promise(function(res){ var r = new FileReader(); r.onload = function(){ res(r.result); }; r.onerror = function(){ res(null); }; r.readAsDataURL(b); });
}
function exportDeck(deck){
  return Promise.all(deck.cards.map(function(c){ return c.img ? blobToDataURL(c.img) : null; })).then(function(datas){
    var out = { app: 'vocab-cards', version: 1, deck: { id: deck.id, name: deck.name, created: deck.created,
      cards: deck.cards.map(function(c, k){ var o = {}; for (var key in c) if (key !== 'img') o[key] = c[key]; o.imgData = datas[k]; return o; }) } };
    var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = deck.name.replace(/[^\w\-ぁ-んァ-ン一-龯 ]+/g, '').trim().replace(/\s+/g, '-') + '.vocabcards.json';
    document.body.appendChild(a); a.click(); a.remove();
  });
}
function restoreBackup(text){
  var obj = JSON.parse(text);
  if (!obj || obj.app !== 'vocab-cards' || !obj.deck) throw new Error('That is not a Vocab Cards backup file.');
  var d = obj.deck;
  return Promise.all(d.cards.map(function(c){
    var data = c.imgData; delete c.imgData;
    if (!data) { c.img = null; return c; }
    return fetch(data).then(function(r){ return r.blob(); }).then(function(b){ c.img = b; return c; });
  })).then(function(cards){ d.cards = cards; return putDeck(d).then(function(){ return d; }); });
}

/* ---------- views ---------- */
function setNav(){
  var btns = document.querySelectorAll('nav button');
  for (var k = 0; k < btns.length; k++) {
    var v = btns[k].getAttribute('data-arg');
    btns[k].className = (v === S.view || (v === 'decks' && S.view === 'study')) ? 'on' : '';
  }
}
function render(){
  setNav();
  if (S.view === 'decks') return renderDecks();
  if (S.view === 'add') return renderAdd();
  if (S.view === 'settings') return renderSettings();
  if (S.view === 'study') return renderStudy();
}
function renderDecks(){
  getDecks().then(function(list){
    S.decks = list.sort(function(a, b){ return b.created - a.created; });
    if (!S.decks.length) {
      app.innerHTML = '<h2>Your decks</h2><div class="panel empty"><p>No decks yet. To add a page from your vocab book:</p><ol>' +
        '<li>Open a new Claude chat, attach a photo of the page, and ask for flashcard data.</li>' +
        '<li>Copy Claude\'s whole reply.</li>' +
        '<li>Tap <b>Add</b> here, paste it, and tap <b>Build deck</b>.</li></ol>' +
        (settings.code ? '' : '<p class="note">If you set an access code on the server, enter it in Settings first.</p>') +
        '</div><div class="row"><button class="btn primary" data-act="go" data-arg="add">Add a page</button></div>';
      return;
    }
    var html = '<h2>Your decks</h2>';
    S.decks.forEach(function(d){
      var pics = d.cards.filter(function(c){ return c.img; }).length;
      html += '<div class="panel deck"><div><b>' + esc(d.name) + '</b><span class="muted small">' + d.cards.length + ' words' +
        (pics < d.cards.length ? ' · ' + (d.cards.length - pics) + ' without pictures' : '') + '</span></div>' +
        '<div class="acts"><button class="btn primary" data-act="study" data-arg="' + esc(d.id) + '">Study</button>' +
        '<button class="btn" data-act="export" data-arg="' + esc(d.id) + '">Back up</button>' +
        '<button class="btn danger" data-act="delete" data-arg="' + esc(d.id) + '">Delete</button></div></div>';
    });
    html += '<div class="row"><button class="btn" data-act="study-all">Study all decks</button></div>';
    app.innerHTML = html;
  }).catch(function(e){ app.innerHTML = '<p class="warn">Could not open storage: ' + esc(e.message) + '</p>'; });
}
function renderAdd(){
  var today = new Date();
  var def = 'Page ' + (today.getMonth() + 1) + '/' + today.getDate();
  app.innerHTML = '<h2>Add a page</h2><div class="panel">' +
    '<label for="dname">Deck name</label><input type="text" id="dname" value="' + esc(def) + '">' +
    '<label for="paste">Paste Claude\'s reply</label><textarea id="paste" placeholder="{ &quot;words&quot;: [ ... ] }"></textarea>' +
    '<div class="row"><button class="btn primary" id="buildbtn" data-act="build">Build deck</button></div>' +
    '<div class="bar" id="bar" hidden><i></i></div><div class="log" id="log"></div><div id="result"></div></div>' +
    '<div class="panel"><b>Restore a backup</b><p class="muted small">Load a .vocabcards.json file you saved with Back up.</p>' +
    '<input type="file" id="restore" accept=".json,application/json"></div>';
  document.getElementById('restore').addEventListener('change', function(e){
    var f = e.target.files[0]; if (!f) return;
    f.text().then(restoreBackup).then(function(d){ alert('Restored "' + d.name + '".'); go('decks'); })
      .catch(function(err){ alert(err.message); });
  });
}
function doBuild(){
  if (S.busy) return;
  var name = (document.getElementById('dname').value || '').trim() || 'Untitled page';
  var log = document.getElementById('log'), bar = document.getElementById('bar'), out = document.getElementById('result');
  var btn = document.getElementById('buildbtn');
  var parsed;
  try { parsed = parseInput(document.getElementById('paste').value); }
  catch (e) { log.innerHTML = '<span class="warn">' + esc(e.message) + '</span>'; return; }
  S.busy = true; btn.disabled = true; bar.hidden = false; out.innerHTML = '';
  log.textContent = 'Found ' + parsed.words.length + ' words' +
    (parsed.count && parsed.count !== parsed.words.length ? ' (Claude counted ' + parsed.count + ' on the page)' : '') + '. Finding pictures…\n';
  buildDeck(name, parsed, function(done, n, line){
    bar.firstChild.style.width = Math.round(done / n * 100) + '%';
    log.textContent += done + '/' + n + '  ' + line + '\n';
    log.scrollTop = log.scrollHeight;
  }).then(function(r){
    var notes = '';
    if (parsed.corrections.length) notes += '<div class="note"><b>Corrections Claude made:</b><br>' + parsed.corrections.map(fmt).join('<br>') + '</div>';
    if (parsed.unreadable.length) notes += '<div class="note"><b>Couldn\'t read:</b><br>' + parsed.unreadable.map(fmt).join('<br>') + '</div>';
    out.innerHTML = '<p class="ok" style="margin-top:12px">Saved "' + esc(r.deck.name) + '" with ' + r.deck.cards.length + ' cards' +
      (r.missing.length ? ', ' + r.missing.length + ' without pictures' : '') + '.</p>' + notes +
      '<div class="row"><button class="btn primary" data-act="study" data-arg="' + esc(r.deck.id) + '">Study now</button></div>';
  }).catch(function(e){
    log.textContent += '\nStopped: ' + e.message;
  }).then(function(){ S.busy = false; btn.disabled = false; });
}
function fmt(x){ return esc(typeof x === 'string' ? x : JSON.stringify(x)); }
function renderSettings(){
  app.innerHTML = '<h2>Settings</h2><div class="panel">' +
    '<label for="code">Access code</label><input type="password" id="code" data-set="code" value="' + esc(settings.code) + '" autocomplete="off">' +
    '<p class="muted small" style="margin-top:6px">Only needed if you set ACCESS_CODE on your Worker.</p>' +
    '<label for="style">Pictures for new decks</label><select id="style" data-set="style">' +
      '<option value="drawings"' + (settings.style === 'drawings' ? ' selected' : '') + '>Drawings and pictograms</option>' +
      '<option value="photos"' + (settings.style === 'photos' ? ' selected' : '') + '>Photos for things, pictograms for ideas</option></select>' +
    '<label for="front">Card front</label><select id="front" data-set="front">' +
      '<option value="picture"' + (settings.front === 'picture' ? ' selected' : '') + '>Picture (recall the Japanese)</option>' +
      '<option value="word"' + (settings.front === 'word' ? ' selected' : '') + '>Japanese (recall the meaning)</option></select>' +
    '<label class="check"><input type="checkbox" data-set="bw"' + (settings.bw ? ' checked' : '') + '> Show pictures in black and white</label>' +
    '</div><div class="row"><button class="btn" data-act="ping">Check server</button></div><div class="log" id="pinglog"></div>';
}
function cardWord(c){
  var extra = [c.kanji, c.kana].filter(function(x, k, arr){ return x && x !== c.jp && arr.indexOf(x) === k; });
  return '<div class="jp">' + esc(c.jp) + '</div>' + (extra.length ? '<div class="sub">' + esc(extra.join(' · ')) + '</div>' : '');
}
function imgURL(c){
  if (!c.img) return '';
  var u = urlMap.get(c.img);
  if (!u) { u = URL.createObjectURL(c.img); urlMap.set(c.img, u); }
  return u;
}
function renderStudy(){
  var d = S.deck;
  if (!d || !d.cards.length) { S.view = 'decks'; return render(); }
  var c = d.cards[S.order[S.i]];
  var u = imgURL(c);
  var pic = u ? '<img class="pic' + (settings.bw ? ' bw' : '') + '" src="' + u + '" alt="">' : '<div class="nopic">No picture</div>';
  var cand = c.cands[c.pick];
  var credit = cand ? '<div class="credit">' + esc(cand.credit || cand.source) + (cand.link ? ' · <a href="' + esc(cand.link) + '" target="_blank" rel="noopener">source</a>' : '') + '</div>' : '';
  var front = settings.front === 'word' ? cardWord(c) : pic;
  var back = pic + cardWord(c) + '<div class="en">' + esc(c.en) + '</div>' + (c.pos ? '<div class="pos">' + esc(c.pos) + '</div>' : '') +
    (c.example_jp ? '<div class="ex"><div>' + esc(c.example_jp) + '</div><div class="muted small">' + esc(c.example_en) + '</div></div>' : '') + credit;
  app.innerHTML = '<div class="studyhead"><button class="link" data-act="go" data-arg="decks">‹ ' + esc(d.name) + '</button>' +
    '<span class="muted small">' + (S.i + 1) + ' / ' + d.cards.length + '</span></div>' +
    '<div class="card" data-act="flip">' + (S.flipped ? back : front + '<div class="hint">Tap to flip</div>') + '</div>' +
    '<div class="row"><button class="btn" data-act="prev">‹ Prev</button><button class="btn primary" data-act="next">Next ›</button></div>' +
    '<div class="row"><button class="btn" data-act="shuffle">Shuffle</button><button class="btn" data-act="reroll">Different picture</button></div>';
}
function startStudy(deck){
  S.deck = deck; S.order = deck.cards.map(function(_, k){ return k; }); S.i = 0; S.flipped = false; go('study');
}
function shuffle(arr){ for (var k = arr.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = arr[k]; arr[k] = arr[j]; arr[j] = t; } return arr; }
function go(v){ S.view = v; window.scrollTo(0, 0); render(); }

/* ---------- actions ---------- */
var actions = {
  go: function(arg){ go(arg); },
  build: doBuild,
  study: function(id){ getDecks().then(function(list){ var d = list.filter(function(x){ return x.id === id; })[0]; if (d) startStudy(d); }); },
  'study-all': function(){
    getDecks().then(function(list){
      var all = { id: '__all__', name: 'All decks', created: 0, cards: [], owners: [] };
      list.forEach(function(d){ d.cards.forEach(function(c, k){ all.cards.push(c); all.owners.push([d, k]); }); });
      startStudy(all); S.order = shuffle(S.order); render();
    });
  },
  export: function(id){ var d = S.decks.filter(function(x){ return x.id === id; })[0]; if (d) exportDeck(d); },
  delete: function(id){
    var d = S.decks.filter(function(x){ return x.id === id; })[0];
    if (d && confirm('Delete "' + d.name + '"? This can\'t be undone unless you have a backup.')) delDeck(id).then(renderDecks);
  },
  flip: function(){ S.flipped = !S.flipped; renderStudy(); },
  next: function(){ S.i = (S.i + 1) % S.order.length; S.flipped = false; renderStudy(); },
  prev: function(){ S.i = (S.i - 1 + S.order.length) % S.order.length; S.flipped = false; renderStudy(); },
  shuffle: function(){ shuffle(S.order); S.i = 0; S.flipped = false; renderStudy(); },
  reroll: function(arg, el){
    var c = S.deck.cards[S.order[S.i]];
    if (c.cands.length < 2) { alert('No other pictures were found for this word.'); return; }
    el.disabled = true; el.textContent = 'Loading…';
    pickImage(c, c.pick + 1).then(function(){ return saveCard(c); }).then(renderStudy)
      .catch(function(e){ alert(e.message); renderStudy(); });
  },
  ping: function(){
    var log = document.getElementById('pinglog'); log.textContent = 'Checking…';
    api('/api/ping').then(function(r){ return r.json(); }).then(function(d){
      log.textContent = 'Server OK.\nARASAAC and Openverse: on\nPixabay: ' + (d.pixabay ? 'on' : 'off (no PIXABAY_KEY)') + '\nPexels: ' + (d.pexels ? 'on' : 'off (no PEXELS_KEY)');
    }).catch(function(e){ log.textContent = e.message; });
  }
};
function saveCard(c){
  if (S.deck.id !== '__all__') return putDeck(S.deck);
  var k = S.order[S.i], owner = S.deck.owners[k];
  owner[0].cards[owner[1]] = c;
  return putDeck(owner[0]);
}
document.addEventListener('click', function(e){
  if (e.target.closest('a')) return;
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var fn = actions[el.getAttribute('data-act')];
  if (fn) fn(el.getAttribute('data-arg'), el);
});
document.addEventListener('change', function(e){
  var key = e.target.getAttribute && e.target.getAttribute('data-set');
  if (!key) return;
  settings[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  saveSettings();
});
document.addEventListener('input', function(e){
  if (e.target.id === 'code') { settings.code = e.target.value; saveSettings(); }
});
document.addEventListener('keydown', function(e){
  if (S.view !== 'study') return;
  if (e.key === 'ArrowRight') actions.next();
  else if (e.key === 'ArrowLeft') actions.prev();
  else if (e.key === ' ') { e.preventDefault(); actions.flip(); }
});
render();
})();
</script>
</body>
</html>
`;
