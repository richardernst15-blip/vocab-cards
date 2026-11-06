// Vocab Cards — Cloudflare Worker with a shared D1 database
// Serves the app at "/", stores lessons, words, pictures and each person's progress in D1.
//
// Bindings (set in wrangler.jsonc):  DB  – the D1 database
// Secrets (Worker > Settings > Variables and Secrets):
//   ACCESS_CODE  – passcode the app must send
//   PIXABAY_KEY  – optional, adds Pixabay results
//   PEXELS_KEY   – optional, adds Pexels results
// ARASAAC and Openverse need no key.

const UA = "vocab-cards/2.0 (personal flashcard app)";
const IMG_HOSTS = ["static.arasaac.org", "api.openverse.org", "pixabay.com", "cdn.pixabay.com", "images.pexels.com"];
const MAX_CANDS = 6;
const MAX_IMG_BYTES = 1500000; // D1 rows max out at 2 MB

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefs TEXT NOT NULL DEFAULT '{}', created INTEGER)",
  "CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER)",
  "CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, image_id TEXT, created INTEGER)",
  "CREATE INDEX IF NOT EXISTS cards_deck ON cards(deck_id)",
  "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT, size INTEGER, data BLOB, created INTEGER)",
  "CREATE TABLE IF NOT EXISTS progress (user_id TEXT NOT NULL, card_id TEXT NOT NULL, form TEXT NOT NULL, remembered INTEGER NOT NULL DEFAULT 0, forgotten INTEGER NOT NULL DEFAULT 0, last_reviewed INTEGER, PRIMARY KEY (user_id, card_id, form))",
];
let schemaReady = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/index.html") {
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      }
      if (path.startsWith("/img/")) return await serveImage(env, path.slice(5));
      if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });

      if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) {
        return json({ error: "access code required" }, 401);
      }
      if (path === "/api/ping") return json(await ping(env));
      if (!env.DB) return json({ error: "No D1 database is linked. Add the DB binding in wrangler.jsonc." }, 500);
      await ensureSchema(env);

      const body = request.method === "GET" || request.method === "DELETE" ? {} : await request.json().catch(() => ({}));
      const m = (re) => path.match(re);
      let r;

      if (path === "/api/state" && request.method === "GET") return json(await state(env));
      if (path === "/api/progress" && request.method === "GET") return json(await progress(env, url.searchParams.get("user")));
      if (path === "/api/review" && request.method === "POST") return json(await review(env, body));

      if (path === "/api/users" && request.method === "POST") return json(await addUser(env, body));
      if ((r = m(/^\/api\/users\/([\w-]+)$/))) {
        if (request.method === "PATCH") return json(await editUser(env, r[1], body));
        if (request.method === "DELETE") return json(await delUser(env, r[1]));
      }

      if (path === "/api/decks" && request.method === "POST") return json(await addDeck(env, body));
      if ((r = m(/^\/api\/decks\/([\w-]+)$/))) {
        if (request.method === "PATCH") return json(await editDeck(env, r[1], body));
        if (request.method === "DELETE") return json(await delDeck(env, r[1]));
      }
      if ((r = m(/^\/api\/decks\/([\w-]+)\/merge$/)) && request.method === "POST") return json(await mergeDeck(env, r[1], body.into));
      if ((r = m(/^\/api\/decks\/([\w-]+)\/cards$/)) && request.method === "POST") return json(await addCards(env, r[1], body.words || []));

      if ((r = m(/^\/api\/cards\/([\w-]+)$/))) {
        if (request.method === "PATCH") return json(await editCard(env, r[1], body));
        if (request.method === "DELETE") return json(await delCard(env, r[1]));
      }
      if ((r = m(/^\/api\/cards\/([\w-]+)\/picture$/)) && request.method === "POST") return json(await picture(env, r[1], body));
      if ((r = m(/^\/api\/cards\/([\w-]+)\/upload$/)) && request.method === "POST") return json(await uploadPicture(env, r[1], body));

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

// ---------- database ----------
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

async function ping(env) {
  const out = { ok: true, pixabay: !!env.PIXABAY_KEY, pexels: !!env.PEXELS_KEY, db: !!env.DB };
  if (env.DB) {
    await ensureSchema(env);
    const s = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM images").first();
    out.images = s.n; out.bytes = s.bytes;
  }
  return out;
}

function cardOut(row) {
  return { id: row.id, deck_id: row.deck_id, ord: row.ord, image_id: row.image_id, created: row.created, ...parse(row.data, {}) };
}
async function getCard(env, id) {
  const row = await env.DB.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
  if (!row) throw new Error("word not found");
  return row;
}

async function state(env) {
  const [u, d, c] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, prefs FROM users ORDER BY created"),
    env.DB.prepare("SELECT id, name, created FROM decks"),
    env.DB.prepare("SELECT id, deck_id, ord, data, image_id, created FROM cards ORDER BY deck_id, ord"),
  ]);
  return {
    users: u.results.map((x) => ({ id: x.id, name: x.name, prefs: parse(x.prefs, {}) })),
    decks: d.results,
    cards: c.results.map(cardOut),
  };
}

async function progress(env, user) {
  const r = await env.DB.prepare("SELECT card_id, form, remembered, forgotten, last_reviewed FROM progress WHERE user_id = ?").bind(user || "").all();
  return { rows: r.results };
}

async function review(env, body) {
  const list = (body.reviews || [body]).filter((x) => x && x.user_id && x.card_id);
  if (!list.length) return { ok: true, saved: 0 };
  const sql = "INSERT INTO progress (user_id, card_id, form, remembered, forgotten, last_reviewed) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, card_id, form) DO UPDATE SET remembered = remembered + excluded.remembered, " +
    "forgotten = forgotten + excluded.forgotten, last_reviewed = excluded.last_reviewed";
  await env.DB.batch(list.slice(0, 90).map((x) => env.DB.prepare(sql).bind(
    x.user_id, x.card_id, x.form || "meaning", x.result === "forgot" ? 0 : 1, x.result === "forgot" ? 1 : 0, x.at || now())));
  return { ok: true, saved: Math.min(list.length, 90) };
}

async function addUser(env, b) {
  const name = String(b.name || "").trim().slice(0, 40);
  if (!name) throw new Error("name required");
  const u = { id: uid(), name, prefs: b.prefs || {} };
  await env.DB.prepare("INSERT INTO users (id, name, prefs, created) VALUES (?, ?, ?, ?)").bind(u.id, name, JSON.stringify(u.prefs), now()).run();
  return u;
}
async function editUser(env, id, b) {
  if (b.name != null) await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(String(b.name).trim().slice(0, 40), id).run();
  if (b.prefs != null) await env.DB.prepare("UPDATE users SET prefs = ? WHERE id = ?").bind(JSON.stringify(b.prefs), id).run();
  return { ok: true };
}
async function delUser(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM progress WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return { ok: true };
}

async function addDeck(env, b) {
  const name = String(b.name || "").trim().slice(0, 80) || "Untitled lesson";
  const d = { id: uid(), name, created: now() };
  await env.DB.prepare("INSERT INTO decks (id, name, created) VALUES (?, ?, ?)").bind(d.id, d.name, d.created).run();
  return d;
}
async function editDeck(env, id, b) {
  await env.DB.prepare("UPDATE decks SET name = ? WHERE id = ?").bind(String(b.name || "").trim().slice(0, 80) || "Untitled lesson", id).run();
  return { ok: true };
}
async function delDeck(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM progress WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM images WHERE id IN (SELECT image_id FROM cards WHERE deck_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM cards WHERE deck_id = ?").bind(id),
    env.DB.prepare("DELETE FROM decks WHERE id = ?").bind(id),
  ]);
  return { ok: true };
}
async function mergeDeck(env, from, into) {
  if (!into || into === from) throw new Error("pick a different lesson to merge into");
  const target = await env.DB.prepare("SELECT id FROM decks WHERE id = ?").bind(into).first();
  if (!target) throw new Error("lesson not found");
  const top = await env.DB.prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM cards WHERE deck_id = ?").bind(into).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET deck_id = ?, ord = ord + ? WHERE deck_id = ?").bind(into, top.n, from),
    env.DB.prepare("DELETE FROM decks WHERE id = ?").bind(from),
  ]);
  return { ok: true };
}

const FIELDS = ["jp", "kana", "kanji", "en", "pos", "group", "type", "photo_query", "picto_query", "example_jp", "example_en", "forms"];
function cleanWord(w) {
  const d = {};
  for (const k of FIELDS) if (w[k] != null) d[k] = k === "forms" ? (typeof w.forms === "object" ? w.forms : {}) : String(w[k]).slice(0, 400);
  if (!d.jp) d.jp = d.kana || "";
  return d;
}
async function addCards(env, deckId, words) {
  const deck = await env.DB.prepare("SELECT id FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck) throw new Error("lesson not found");
  const top = await env.DB.prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM cards WHERE deck_id = ?").bind(deckId).first();
  const t = now();
  const cards = words.filter((w) => w && (w.jp || w.kana)).slice(0, 90).map((w, k) => ({
    id: uid(), deck_id: deckId, ord: top.n + k, image_id: null, created: t, ...cleanWord(w), cands: [], pick: -1,
  }));
  if (cards.length) {
    await env.DB.batch(cards.map((c) => env.DB.prepare("INSERT INTO cards (id, deck_id, ord, data, image_id, created) VALUES (?, ?, ?, ?, NULL, ?)")
      .bind(c.id, c.deck_id, c.ord, JSON.stringify(dataOf(c)), t)));
  }
  return { cards };
}
function dataOf(c) {
  const d = {};
  for (const k of FIELDS.concat(["cands", "pick", "credit", "link", "source"])) if (c[k] !== undefined) d[k] = c[k];
  return d;
}
async function editCard(env, id, b) {
  const row = await getCard(env, id);
  const d = { ...parse(row.data, {}), ...cleanWord({ ...parse(row.data, {}), ...b }) };
  const deckId = b.deck_id || row.deck_id;
  await env.DB.prepare("UPDATE cards SET data = ?, deck_id = ? WHERE id = ?").bind(JSON.stringify(d), deckId, id).run();
  return cardOut({ ...row, data: JSON.stringify(d), deck_id: deckId });
}
async function delCard(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM images WHERE id = (SELECT image_id FROM cards WHERE id = ?)").bind(id),
    env.DB.prepare("DELETE FROM progress WHERE card_id = ?").bind(id),
    env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(id),
  ]);
  return { ok: true };
}

// ---------- pictures ----------
// mode "first": search if needed and take the best match
// mode "next":  take the next match after the current one
// mode "search": search again with the word's current queries
async function picture(env, id, b) {
  const row = await getCard(env, id);
  const d = parse(row.data, {});
  const mode = b.mode || "first";
  if (mode === "search" || !Array.isArray(d.cands) || !d.cands.length) {
    const p = new URLSearchParams({ q: d.photo_query || d.en || "", picto: d.picto_query || d.en || "", en: d.en || "", type: d.type || "", style: b.style || "drawings" });
    d.cands = (await search(p, env)).cands;
    d.pick = -1;
  }
  const n = d.cands.length;
  const start = mode === "next" ? (d.pick || 0) + 1 : 0;
  for (let t = 0; t < n; t++) {
    const j = (((start + t) % n) + n) % n;
    if (mode === "next" && j === d.pick && n > 1) continue;
    const img = await fetchImage(d.cands[j].url);
    if (!img) continue;
    const imageId = uid();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO images (id, type, size, data, created) VALUES (?, ?, ?, ?, ?)").bind(imageId, img.type, img.bytes.byteLength, img.bytes, now()),
      env.DB.prepare("DELETE FROM images WHERE id = ?").bind(row.image_id || ""),
      env.DB.prepare("UPDATE cards SET image_id = ?, data = ? WHERE id = ?").bind(imageId, JSON.stringify({ ...d, pick: j, credit: d.cands[j].credit, link: d.cands[j].link, source: d.cands[j].source }), id),
    ]);
    return cardOut({ ...row, image_id: imageId, data: JSON.stringify({ ...d, pick: j, credit: d.cands[j].credit, link: d.cands[j].link, source: d.cands[j].source }) });
  }
  await env.DB.prepare("UPDATE cards SET data = ? WHERE id = ?").bind(JSON.stringify(d), id).run();
  return cardOut({ ...row, data: JSON.stringify(d) });
}

// Used when moving decks saved on a phone by the earlier version.
async function uploadPicture(env, id, b) {
  const row = await getCard(env, id);
  const m = String(b.imgData || "").match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (!m) throw new Error("not an image");
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  if (bytes.byteLength > MAX_IMG_BYTES) throw new Error("image too large");
  const imageId = uid();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO images (id, type, size, data, created) VALUES (?, ?, ?, ?, ?)").bind(imageId, m[1], bytes.byteLength, bytes, now()),
    env.DB.prepare("DELETE FROM images WHERE id = ?").bind(row.image_id || ""),
    env.DB.prepare("UPDATE cards SET image_id = ? WHERE id = ?").bind(imageId, id),
  ]);
  return cardOut({ ...row, image_id: imageId });
}

async function serveImage(env, id) {
  if (!env.DB || !/^[\w-]+$/.test(id)) return new Response("Not found", { status: 404 });
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT type, data FROM images WHERE id = ?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.data), {
    headers: { "content-type": row.type || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
}

async function fetchImage(raw) {
  let u;
  try { u = new URL(raw || ""); } catch { return null; }
  if (u.protocol !== "https:" || !IMG_HOSTS.includes(u.hostname)) return null;
  try {
    const r = await fetch(u.toString(), { headers: { "User-Agent": UA }, redirect: "follow" });
    const type = (r.headers.get("content-type") || "").split(";")[0];
    if (!r.ok || !type.startsWith("image/")) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_IMG_BYTES) return null;
    return { type, bytes };
  } catch { return null; }
}

// ---------- search (medium-size images from each source) ----------
async function search(p, env) {
  const photo = clip(p.get("q") || p.get("en"));
  const picto = clip(p.get("picto") || p.get("en") || photo);
  const en = clip(p.get("en"));
  const type = p.get("type") === "abstract" ? "abstract" : "concrete";
  const style = p.get("style") === "photos" ? "photos" : "drawings";
  if (!photo && !picto) return { cands: [] };
  let cands = await runPlan(plan(type, style, photo, picto), env);
  if (!cands.length && en && en !== photo && en !== picto) cands = await runPlan(plan(type, style, en, en), env);
  return { cands: cands.slice(0, MAX_CANDS) };
}

function plan(type, style, photo, picto) {
  if (style === "drawings") {
    return [["arasaac", picto], ["pixabay", photo, "illustration"], ["openverse", photo, "illustration"], ["openverse", photo, ""], ["pexels", photo]];
  }
  if (type === "abstract") return [["arasaac", picto], ["pixabay", photo, "all"], ["openverse", photo, ""], ["pexels", photo]];
  return [["pixabay", photo, "photo"], ["openverse", photo, ""], ["pexels", photo], ["arasaac", picto]];
}

async function runPlan(steps, env) {
  const results = await Promise.all(steps.map(([src, q, opt]) => SOURCES[src](q, opt, env).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of results) {
    for (const c of list.slice(0, 2)) if (c.url && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
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
      source: "ARASAAC", url: `https://static.arasaac.org/pictograms/${x._id}/${x._id}_500.png`,
      credit: "Pictogram by Sergio Palao for ARASAAC (Government of Aragón), CC BY-NC-SA", link: "https://arasaac.org",
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
      source: "Openverse", url: x.thumbnail || `https://api.openverse.org/v1/images/${x.id}/thumb/`,
      credit: x.attribution || [x.title, x.creator, x.license && `CC ${String(x.license).toUpperCase()}`].filter(Boolean).join(" · "),
      link: x.foreign_landing_url || "",
    }));
  },
  async pixabay(q, imageType, env) {
    if (!q || !env.PIXABAY_KEY) return [];
    const r = await get(`https://pixabay.com/api/?key=${env.PIXABAY_KEY}&q=${encodeURIComponent(q)}&image_type=${imageType || "all"}&safesearch=true&per_page=5`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.hits || []).map((x) => ({ source: "Pixabay", url: x.webformatURL, credit: `Image by ${x.user} via Pixabay`, link: x.pageURL }));
  },
  async pexels(q, _opt, env) {
    if (!q || !env.PEXELS_KEY) return [];
    const r = await get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=5`, { Authorization: env.PEXELS_KEY });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.photos || []).map((x) => ({ source: "Pexels", url: x.src && (x.src.medium || x.src.large), credit: `Photo by ${x.photographer} on Pexels`, link: x.url }));
  },
};

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
<meta name="apple-mobile-web-app-title" content="Vocab Cards">
<title>Vocab Cards</title>
<style>
:root{--bg:#f5f2ea;--card:#fffdf8;--ink:#1d1b18;--muted:#6f6a61;--line:#e2dccf;--accent:#b93a28;--accent-ink:#fff;--ok:#2f7a4f;--warn:#9a5b00}
@media (prefers-color-scheme: dark){:root{--bg:#151412;--card:#1f1e1b;--ink:#f1ede4;--muted:#a49e93;--line:#35322c;--accent:#e0624c;--accent-ink:#fff;--ok:#62b585;--warn:#e0a54a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
header{position:sticky;top:0;z-index:3;background:var(--bg);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top)) 16px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
header h1{font-size:17px;margin:0;font-weight:700;letter-spacing:.02em;white-space:nowrap}
header h1 span{color:var(--accent)}
nav{display:flex;gap:2px}
nav button{background:none;border:0;color:var(--muted);font:inherit;font-size:14px;padding:6px 9px;border-radius:8px;white-space:nowrap}
nav button.on{color:var(--ink);background:var(--line)}
main{max-width:680px;margin:0 auto;padding:16px 16px calc(32px + env(safe-area-inset-bottom))}
h2{font-size:20px;margin:4px 0 12px}
h3{font-size:16px;margin:0 0 10px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:13px}
button{font:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:15px;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.btn.danger{color:var(--accent)}
.btn.sm{min-height:36px;padding:0 12px;font-size:14px}
.btn:disabled{opacity:.5}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.row .btn{flex:1}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
summary{cursor:pointer;font-weight:600;font-size:16px;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px}
summary::-webkit-details-marker{display:none}
summary::after{content:"▾";color:var(--muted)}
details[open] summary{margin-bottom:12px}
details[open] summary::after{content:"▴"}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:7px 14px;font-size:15px;min-height:40px;cursor:pointer}
.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chip small{opacity:.7}
.list .item{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.list .item:first-child{border-top:0}
.item .grow{flex:1;min-width:0}
.item b{display:block}
.thumb{width:48px;height:48px;border-radius:8px;object-fit:contain;background:#fff;flex:none;border:1px solid var(--line)}
.thumb.empty{background:var(--bg)}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 6px}
input[type=text],input[type=password],textarea,select{width:100%;font:inherit;font-size:16px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
textarea{min-height:170px;font-family:ui-monospace,Menlo,monospace;font-size:13px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}
.check{display:flex;align-items:center;gap:10px;margin-top:10px;color:var(--ink);font-size:15px}
.check input{width:20px;height:20px;flex:none}
.userrow{display:flex;gap:8px}
.userrow select{flex:1}
.log{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;color:var(--muted);margin-top:12px;max-height:220px;overflow:auto}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:12px}
.bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .2s}
.footer{position:sticky;bottom:0;padding:10px 0 calc(8px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line);margin:0 -16px;padding-left:16px;padding-right:16px}
.footer .btn{width:100%;min-height:52px;font-size:17px}
.studyhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px}
.link{background:none;border:0;color:var(--accent);padding:0;font-size:15px;cursor:pointer;text-align:left}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;min-height:400px;padding:18px 18px 34px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;cursor:pointer;user-select:none;-webkit-user-select:none;position:relative}
.pic{width:100%;max-height:300px;object-fit:contain;border-radius:12px;background:#fff}
.pic.small{max-height:150px}
.pic.bw{filter:grayscale(1) contrast(1.15)}
.nopic{width:100%;height:160px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
.jp{font-size:40px;font-weight:700;line-height:1.2;margin-top:14px}
.jp.big{font-size:52px;margin-top:0}
.sub{color:var(--muted);font-size:18px;margin-top:2px}
.ask{margin-top:12px;font-size:15px;font-weight:600;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:4px 14px}
.en{font-size:20px;margin-top:10px}
.pos{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
.ex{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:16px;width:100%}
.stats{margin-top:10px;font-size:13px;color:var(--muted)}
.credit{margin-top:8px;font-size:11px;color:var(--muted);word-break:break-word}
.credit a{color:var(--muted)}
.hint{position:absolute;bottom:10px;left:0;right:0;font-size:12px;color:var(--muted)}
.note{font-size:14px;padding:10px 12px;border-radius:12px;background:var(--line);margin-top:12px}
.big-num{font-size:44px;font-weight:700;line-height:1}
.ok{color:var(--ok)}.warn{color:var(--warn)}
.formrow{display:grid;grid-template-columns:42% 1fr;gap:8px;align-items:center;margin-top:8px;font-size:14px}
.formrow input{padding:8px 10px}
</style>
</head>
<body>
<header>
  <h1>Vocab <span>Cards</span></h1>
  <nav>
    <button data-act="go" data-arg="study">Study</button>
    <button data-act="go" data-arg="add">Add/Edit</button>
    <button data-act="go" data-arg="settings">Settings</button>
  </nav>
</header>
<main id="app"></main>
<script>
(function(){
var app = document.getElementById('app');
var DAY = 86400000, STALE_DAYS = 14;
var settings = loadSettings();
var S = { view: 'study', data: { users: [], decks: [], cards: [] }, prog: {}, loaded: false, err: '', busy: false,
          sess: null, lessonId: null, cardId: null, addTarget: 'new', local: [], lessonsOpen: false, info: null };

/* ---------- settings (this device) ---------- */
function loadSettings(){
  var d = { code: '', style: 'drawings', bw: true, front: 'picture', userId: '',
            sel: { cats: [], lessons: [], forms: ['meaning'], order: 'random', stale: false, limit: 'all' } };
  try {
    var s = JSON.parse(localStorage.getItem('vc-settings') || '{}');
    for (var k in s) if (k !== 'sel') d[k] = s[k];
    if (s.sel) for (var j in s.sel) d.sel[j] = s.sel[j];
  } catch (e) {}
  return d;
}
function saveSettings(){ try { localStorage.setItem('vc-settings', JSON.stringify(settings)); } catch (e) {} }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
function enc(s){ return encodeURIComponent(s || ''); }
function uniq(a){ return a.filter(function(x, k){ return a.indexOf(x) === k; }); }
function byName(a, b){ return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); }

/* ---------- server ---------- */
function api(method, path, body){
  var o = { method: method, headers: { 'x-access-code': settings.code || '' } };
  if (body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
  return fetch(path, o).then(function(r){
    if (r.status === 401) throw new Error('The access code is wrong or missing. Set it in Settings.');
    return r.json().catch(function(){ return {}; }).then(function(d){
      if (!r.ok) throw new Error(d.error || ('Server error ' + r.status));
      return d;
    });
  });
}
function load(){
  return flush().then(function(){ return api('GET', '/api/state'); }).then(function(d){
    d.decks.sort(byName);
    S.data = d; S.err = '';
    if (!d.users.some(function(u){ return u.id === settings.userId; })) { settings.userId = d.users.length ? d.users[0].id : ''; saveSettings(); }
    return loadProgress();
  }).catch(function(e){ S.err = e.message; }).then(function(){ S.loaded = true; });
}
function loadProgress(){
  S.prog = {};
  if (!settings.userId) return Promise.resolve();
  return api('GET', '/api/progress?user=' + enc(settings.userId)).then(function(d){
    d.rows.forEach(function(r){ S.prog[r.card_id + '|' + r.form] = r; });
  });
}
function deckById(id){ return S.data.decks.filter(function(d){ return d.id === id; })[0]; }
function cardById(id){ return S.data.cards.filter(function(c){ return c.id === id; })[0]; }
function currentUser(){ return S.data.users.filter(function(u){ return u.id === settings.userId; })[0]; }
function deckCards(id){ return S.data.cards.filter(function(c){ return c.deck_id === id; }).sort(function(a, b){ return a.ord - b.ord; }); }
function updateCard(c, fresh){ for (var k in fresh) c[k] = fresh[k]; return c; }

/* ---------- review queue (kept on device until the server has it) ---------- */
var queue = [];
try { queue = JSON.parse(localStorage.getItem('vc-queue') || '[]'); } catch (e) {}
function saveQueue(){ try { localStorage.setItem('vc-queue', JSON.stringify(queue)); } catch (e) {} }
var flushing = null;
function flush(){
  if (flushing) return flushing;
  if (!queue.length) return Promise.resolve();
  var batch = queue.slice(0, 50);
  flushing = api('POST', '/api/review', { reviews: batch }).then(function(){
    queue.splice(0, batch.length); saveQueue(); flushing = null;
    return flush();
  }).catch(function(){ flushing = null; });
  return flushing;
}
function progOf(cardId, form){ return S.prog[cardId + '|' + form] || { remembered: 0, forgotten: 0, last_reviewed: 0 }; }
function record(it, result){
  var key = it.c.id + '|' + it.f;
  var p = S.prog[key] || (S.prog[key] = { card_id: it.c.id, form: it.f, remembered: 0, forgotten: 0, last_reviewed: 0 });
  if (result === 'forgot') p.forgotten++; else p.remembered++;
  p.last_reviewed = Date.now();
  queue.push({ user_id: S.sess.user, card_id: it.c.id, form: it.f, result: result, at: p.last_reviewed });
  saveQueue(); flush();
}
function isStale(p){ return !p.last_reviewed || Date.now() - p.last_reviewed > STALE_DAYS * DAY; }
function ago(t){
  if (!t) return 'never reviewed';
  var d = Math.floor((Date.now() - t) / DAY);
  return d < 1 ? 'reviewed today' : d === 1 ? 'reviewed yesterday' : 'reviewed ' + d + ' days ago';
}

/* ---------- word types ---------- */
var CATS = [
  ['noun', 'Nouns', ['noun']],
  ['verb', 'Verbs', ['verb']],
  ['adverb', 'Adverbs', ['adverb']],
  ['adj', 'Adjectives', ['i-adj', 'na-adj', 'adjective']],
  ['phrase', 'Phrases', ['phrase', 'expression']],
  ['prep', 'Prepositions', ['preposition', 'particle']]
];
var POS = [['noun', 'Noun'], ['verb', 'Verb'], ['i-adj', 'い-adjective'], ['na-adj', 'な-adjective'], ['adverb', 'Adverb'], ['phrase', 'Phrase'], ['preposition', 'Preposition / particle'], ['other', 'Other']];
function catOf(c){
  for (var k = 0; k < CATS.length; k++) if (CATS[k][2].indexOf(c.pos) >= 0) return CATS[k][0];
  return 'other';
}

/* ---------- conjugation ---------- */
var GODAN = { 'う': 'わいえお', 'く': 'かきけこ', 'ぐ': 'がぎげご', 'す': 'さしせそ', 'つ': 'たちてと', 'ぬ': 'なにねの', 'ぶ': 'ばびべぼ', 'む': 'まみめも', 'る': 'らりれろ' };
var TE = { 'う': ['って', 'った'], 'つ': ['って', 'った'], 'る': ['って', 'った'], 'む': ['んで', 'んだ'], 'ぶ': ['んで', 'んだ'], 'ぬ': ['んで', 'んだ'], 'く': ['いて', 'いた'], 'ぐ': ['いで', 'いだ'], 'す': ['して', 'した'] };
// Common う-verbs that end in -iru / -eru (they look like る-verbs)
var GODAN_RU = /(かえる|帰る|はいる|入る|はしる|走る|^しる|知る|要る|切る|しゃべる|^へる|減る|かぎる|限る|まいる|参る|にぎる|握る|^ける|蹴る|すべる|滑る|ちる|散る|てる|照る|ねる|練る)$/;
function guessGroup(kana, jp){
  var w = kana || jp || '';
  if (/する$/.test(w)) return 'suru';
  if (w === 'くる' || /来る$/.test(jp || '') || /[てで]くる$/.test(w)) return 'kuru';
  if (/[いきぎしじちぢにひびぴみりえけげせぜてでねへべぺめれ]る$/.test(w) && !GODAN_RU.test(w)) return 'ichidan';
  return 'godan';
}
function verbBases(w, g){
  var p, s;
  if (g === 'suru') {
    if (!/する$/.test(w)) return null;
    p = w.slice(0, -2);
    return { nai: p + 'しない', masu: p + 'し', te: p + 'して', ta: p + 'した', pot: p + 'できる', vol: p + 'しよう', ba: p + 'すれば', pass: p + 'される', caus: p + 'させる', imp: p + 'しろ' };
  }
  if (g === 'kuru') {
    if (!/(来|く)る$/.test(w)) return null;
    p = w.slice(0, -2);
    var kan = w.slice(-2, -1) === '来';
    var ko = kan ? '来' : 'こ', ki = kan ? '来' : 'き', ku = kan ? '来' : 'く';
    return { nai: p + ko + 'ない', masu: p + ki, te: p + ki + 'て', ta: p + ki + 'た', pot: p + ko + 'られる', vol: p + ko + 'よう', ba: p + ku + 'れば', pass: p + ko + 'られる', caus: p + ko + 'させる', imp: p + ko + 'い' };
  }
  if (g === 'ichidan') {
    if (!/る$/.test(w)) return null;
    s = w.slice(0, -1);
    return { nai: s + 'ない', masu: s, te: s + 'て', ta: s + 'た', pot: s + 'られる', vol: s + 'よう', ba: s + 'れば', pass: s + 'られる', caus: s + 'させる', imp: s + 'ろ' };
  }
  var end = w.slice(-1), row = GODAN[end];
  if (!row) return null;
  s = w.slice(0, -1);
  var te = TE[end];
  if (end === 'く' && (/行$/.test(s) || s === 'い' || /[てで]い$/.test(s))) te = ['って', 'った'];
  var b = { nai: s + row[0] + 'ない', masu: s + row[1], te: s + te[0], ta: s + te[1], pot: s + row[2] + 'る', vol: s + row[3] + 'う', ba: s + row[2] + 'ば', pass: s + row[0] + 'れる', caus: s + row[0] + 'せる', imp: s + row[2] };
  if (w === 'ある' || w === '有る' || w === '在る') b.nai = 'ない';
  if (/(いらっしゃ|くださ|下さ|なさ|おっしゃ)る$/.test(w)) { b.masu = s + 'い'; b.imp = s + 'い'; }
  return b;
}
var FORMS = [
  { id: 'masu', kind: 'verb', label: 'ます (polite)', v: function(b){ return b.masu + 'ます'; } },
  { id: 'masen', kind: 'verb', label: 'ません (polite negative)', v: function(b){ return b.masu + 'ません'; } },
  { id: 'mashita', kind: 'verb', label: 'ました (polite past)', v: function(b){ return b.masu + 'ました'; } },
  { id: 'masendeshita', kind: 'verb', label: 'ませんでした (polite past negative)', v: function(b){ return b.masu + 'ませんでした'; } },
  { id: 'mashou', kind: 'verb', label: 'ましょう (let\'s)', v: function(b){ return b.masu + 'ましょう'; } },
  { id: 'nai', kind: 'verb', label: 'Negative (ない)', v: function(b){ return b.nai; } },
  { id: 'ta', kind: 'verb', label: 'Past (た)', v: function(b){ return b.ta; } },
  { id: 'nakatta', kind: 'verb', label: 'Past negative (なかった)', v: function(b){ return b.nai.slice(0, -1) + 'かった'; } },
  { id: 'te', kind: 'verb', label: 'て form', v: function(b){ return b.te; } },
  { id: 'teiru', kind: 'verb', label: 'ている (doing / state)', v: function(b){ return b.te + 'いる'; } },
  { id: 'tai', kind: 'verb', label: 'たい (want to)', v: function(b){ return b.masu + 'たい'; } },
  { id: 'naide', kind: 'verb', label: 'ないで (without / don\'t)', v: function(b){ return b.nai + 'で'; } },
  { id: 'pot', kind: 'verb', label: 'Potential (can)', v: function(b){ return b.pot; } },
  { id: 'vol', kind: 'verb', label: 'Volitional (よう / おう)', v: function(b){ return b.vol; } },
  { id: 'ba', kind: 'verb', label: 'ば conditional', v: function(b){ return b.ba; } },
  { id: 'tara', kind: 'verb', label: 'たら conditional', v: function(b){ return b.ta + 'ら'; } },
  { id: 'pass', kind: 'verb', label: 'Passive', v: function(b){ return b.pass; } },
  { id: 'caus', kind: 'verb', label: 'Causative', v: function(b){ return b.caus; } },
  { id: 'imp', kind: 'verb', label: 'Command (imperative)', v: function(b){ return b.imp; } },
  { id: 'a_neg', kind: 'adj', label: 'Negative (くない / じゃない)', i: function(st){ return st + 'くない'; }, na: function(w){ return w + 'じゃない'; } },
  { id: 'a_past', kind: 'adj', label: 'Past (かった / だった)', i: function(st){ return st + 'かった'; }, na: function(w){ return w + 'だった'; } },
  { id: 'a_pastneg', kind: 'adj', label: 'Past negative (くなかった / じゃなかった)', i: function(st){ return st + 'くなかった'; }, na: function(w){ return w + 'じゃなかった'; } },
  { id: 'a_te', kind: 'adj', label: 'くて / で (and…)', i: function(st){ return st + 'くて'; }, na: function(w){ return w + 'で'; } },
  { id: 'a_adv', kind: 'adj', label: 'Adverb (く / に)', i: function(st){ return st + 'く'; }, na: function(w){ return w + 'に'; } },
  { id: 'a_noun', kind: 'adj', label: 'Before a noun (い / な)', i: function(st, w){ return w; }, na: function(w){ return w + 'な'; } },
  { id: 'a_polite', kind: 'adj', label: 'Polite (です)', i: function(st, w){ return w + 'です'; }, na: function(w){ return w + 'です'; } },
  { id: 'a_politeneg', kind: 'adj', label: 'Polite negative', i: function(st){ return st + 'くないです'; }, na: function(w){ return w + 'じゃありません'; } },
  { id: 'a_politepast', kind: 'adj', label: 'Polite past', i: function(st){ return st + 'かったです'; }, na: function(w){ return w + 'でした'; } },
  { id: 'a_ba', kind: 'adj', label: 'ければ / なら (if)', i: function(st){ return st + 'ければ'; }, na: function(w){ return w + 'なら'; } },
  { id: 'a_sou', kind: 'adj', label: 'そう (looks…)', i: function(st, w){ return /いい$/.test(w) || w === 'ない' ? st + 'さそう' : st + 'そう'; }, na: function(w){ return w + 'そう'; } }
];
var FORM = {};
FORMS.forEach(function(f){ FORM[f.id] = f; });
var DEFAULT_FORMS = ['nai', 'ta', 'nakatta', 'te', 'a_neg', 'a_past', 'a_pastneg', 'a_te'];
function formApplies(c, id){
  var f = FORM[id];
  if (!f) return false;
  return f.kind === 'verb' ? c.pos === 'verb' : (c.pos === 'i-adj' || c.pos === 'na-adj');
}
function conjugate(c, id, w){
  var f = FORM[id];
  if (!f || !w || !formApplies(c, id)) return '';
  if (f.kind === 'verb') {
    var b = verbBases(w, c.group || guessGroup(c.kana, c.jp));
    return b ? f.v(b) : '';
  }
  if (c.pos === 'i-adj') {
    if (!/い$/.test(w)) return '';
    var st = /いい$/.test(w) ? w.slice(0, -2) + 'よ' : w.slice(0, -1);
    return f.i(st, w);
  }
  return f.na(w.replace(/(\(な\)|（な）|な)$/, ''));
}
function computed(c, id){
  var outs = uniq([c.jp, c.kanji, c.kana].filter(Boolean).map(function(s){ return conjugate(c, id, s); }).filter(Boolean));
  return outs;
}
function answer(c, id){
  if (c.forms && c.forms[id]) return { main: c.forms[id], alt: '' };
  var outs = computed(c, id);
  return { main: outs[0] || '', alt: outs.slice(1).join(' · ') };
}
function userForms(u){
  var list = u && u.prefs && Array.isArray(u.prefs.forms) ? u.prefs.forms : DEFAULT_FORMS;
  return FORMS.filter(function(f){ return list.indexOf(f.id) >= 0; }).map(function(f){ return f.id; });
}

/* ---------- building a study set ---------- */
function shuffle(arr){ for (var k = arr.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var t = arr[k]; arr[k] = arr[j]; arr[j] = t; } return arr; }
function selection(){
  var sel = settings.sel;
  var lessons = sel.lessons.filter(function(id){ return deckById(id); });
  var allowed = ['meaning'].concat(userForms(currentUser()));
  var forms = sel.forms.filter(function(f){ return allowed.indexOf(f) >= 0; });
  return { cats: sel.cats, lessons: lessons, forms: forms.length ? forms : ['meaning'], order: sel.order, stale: sel.stale, limit: sel.limit };
}
function buildItems(sel){
  var cards = S.data.cards.filter(function(c){
    return (!sel.lessons.length || sel.lessons.indexOf(c.deck_id) >= 0) && (!sel.cats.length || sel.cats.indexOf(catOf(c)) >= 0);
  });
  var items = [];
  cards.forEach(function(c){
    sel.forms.forEach(function(f){
      if (f === 'meaning' || (formApplies(c, f) && answer(c, f).main)) items.push({ c: c, f: f });
    });
  });
  if (sel.stale) items = items.filter(function(it){ return isStale(progOf(it.c.id, it.f)); });
  shuffle(items);
  var P = function(it){ return progOf(it.c.id, it.f); };
  if (sel.order === 'oldest') items.sort(function(a, b){ return (P(a).last_reviewed || 0) - (P(b).last_reviewed || 0); });
  else if (sel.order === 'least') items.sort(function(a, b){ return (P(a).remembered + P(a).forgotten) - (P(b).remembered + P(b).forgotten); });
  else if (sel.order === 'forgot') items.sort(function(a, b){
    var pa = P(a), pb = P(b);
    return (pb.forgotten - pa.forgotten) || (pb.forgotten / (pb.remembered + pb.forgotten || 1) - pa.forgotten / (pa.remembered + pa.forgotten || 1));
  });
  if (sel.limit !== 'all') items = items.slice(0, +sel.limit);
  return items;
}

/* ---------- views ---------- */
function setNav(){
  var map = { study: 'study', session: 'study', summary: 'study', add: 'add', lesson: 'add', word: 'add', settings: 'settings' };
  var btns = document.querySelectorAll('nav button');
  for (var k = 0; k < btns.length; k++) btns[k].className = btns[k].getAttribute('data-arg') === map[S.view] ? 'on' : '';
}
function render(){
  setNav();
  if (!S.loaded && S.view !== 'settings') { app.innerHTML = '<p class="muted">Loading…</p>'; return; }
  if (S.err && S.view !== 'settings') {
    app.innerHTML = '<div class="panel"><p class="warn">' + esc(S.err) + '</p><div class="row"><button class="btn" data-act="go" data-arg="settings">Open Settings</button><button class="btn" data-act="reload">Try again</button></div></div>';
    return;
  }
  ({ study: renderStudy, session: renderSession, summary: renderSummary, add: renderAdd, lesson: renderLesson, word: renderWord, settings: renderSettings })[S.view]();
}
function go(v){ S.view = v; window.scrollTo(0, 0); render(); }
function chip(group, value, label, on){
  return '<button class="chip' + (on ? ' on' : '') + '" data-act="chip" data-group="' + group + '" data-arg="' + esc(value) + '">' + label + '</button>';
}
function userSelect(attr){
  return '<select ' + attr + '>' + S.data.users.map(function(u){
    return '<option value="' + esc(u.id) + '"' + (u.id === settings.userId ? ' selected' : '') + '>' + esc(u.name) + '</option>';
  }).join('') + '</select>';
}

function renderStudy(){
  var d = S.data, sel = selection(), raw = settings.sel;
  var html = '<h2>Study</h2><div class="panel"><h3>Who\'s studying?</h3>';
  html += d.users.length
    ? '<div class="userrow">' + userSelect('data-set-user') + '<button class="btn sm" data-act="add-user">+ Person</button></div>'
    : '<p class="muted">Add each person who studies, so progress is tracked separately.</p><button class="btn primary" data-act="add-user">+ Add a person</button>';
  html += '</div>';

  if (!d.cards.length) {
    html += '<div class="panel"><p>No words yet. To add a page from your vocab book:</p><ol style="padding-left:20px;margin:0">' +
      '<li>In a new Claude chat, attach a photo of the page and ask for flashcard data.</li><li>Copy Claude\'s whole reply.</li>' +
      '<li>Tap <b>Add/Edit</b>, paste it, and tap <b>Build</b>.</li></ol></div>';
    app.innerHTML = html; return;
  }

  var hasOther = d.cards.some(function(c){ return catOf(c) === 'other'; });
  html += '<div class="panel"><h3>Word types</h3><div class="chips">' +
    CATS.map(function(c){ return chip('cats', c[0], c[1], raw.cats.indexOf(c[0]) >= 0); }).join('') +
    (hasOther ? chip('cats', 'other', 'Other', raw.cats.indexOf('other') >= 0) : '') +
    '</div><p class="muted small" style="margin:8px 0 0">None selected = all types</p></div>';

  var names = sel.lessons.map(function(id){ return deckById(id).name; });
  html += '<details class="panel" data-details="lessons"' + (S.lessonsOpen ? ' open' : '') + '><summary>Lesson Selection <span class="muted small" style="font-weight:400">' +
    esc(names.length ? names.join(', ') : 'All lessons') + '</span></summary><div class="chips">' +
    d.decks.map(function(x){ return chip('lessons', x.id, esc(x.name) + ' <small>' + deckCards(x.id).length + '</small>', sel.lessons.indexOf(x.id) >= 0); }).join('') +
    '</div><p class="muted small" style="margin:8px 0 0">None selected = all lessons</p></details>';

  var forms = userForms(currentUser());
  html += '<div class="panel"><h3>What to review</h3><div class="chips">' + chip('forms', 'meaning', 'Meaning', sel.forms.indexOf('meaning') >= 0) +
    forms.map(function(f){ return chip('forms', f, esc(FORM[f].label), sel.forms.indexOf(f) >= 0); }).join('') +
    '</div><p class="muted small" style="margin:8px 0 0">Verb forms apply to verbs, adjective forms to adjectives. Add forms as you learn them in Settings.</p></div>';

  html += '<div class="panel"><h3>Order</h3><div class="chips">' +
    [['random', 'Random Shuffle'], ['oldest', 'Review Oldest to Newest'], ['least', 'Least Reviewed'], ['forgot', 'Most Forgotten']].map(function(o){
      return chip('order', o[0], o[1], sel.order === o[0]);
    }).join('') + '</div>' +
    '<div class="chips" style="margin-top:12px">' + chip('stale', '1', 'Only not reviewed in ' + STALE_DAYS + '+ days', sel.stale) + '</div>' +
    '<label for="limit">How many cards</label><select id="limit" data-set-limit>' +
    ['all', '10', '20', '30', '50', '100'].map(function(n){ return '<option value="' + n + '"' + (sel.limit === n ? ' selected' : '') + '>' + (n === 'all' ? 'All' : n) + '</option>'; }).join('') +
    '</select></div>';

  var items = buildItems(sel);
  var stale = buildItems({ cats: sel.cats, lessons: sel.lessons, forms: sel.forms, order: 'random', stale: true, limit: 'all' }).length;
  html += '<div class="footer"><p class="muted small" style="margin:0 0 6px;text-align:center">' + items.length + ' card' + (items.length === 1 ? '' : 's') + ' match' +
    (settings.userId && stale ? ' · <span class="warn">' + stale + ' not reviewed in ' + STALE_DAYS + '+ days</span>' : '') + '</p>' +
    '<button class="btn primary" data-act="start"' + (!items.length || !settings.userId ? ' disabled' : '') + '>' +
    (settings.userId ? 'Study' : 'Add a person to study') + '</button></div>';
  app.innerHTML = html;
}

function picHTML(c, cls){
  return c.image_id ? '<img class="pic' + (cls || '') + (settings.bw ? ' bw' : '') + '" src="/img/' + esc(c.image_id) + '" alt="">' : '<div class="nopic">No picture</div>';
}
function wordHTML(c, big){
  var extra = uniq([c.kanji, c.kana].filter(function(x){ return x && x !== c.jp; }));
  return '<div class="jp' + (big ? ' big' : '') + '">' + esc(c.jp) + '</div>' + (extra.length ? '<div class="sub">' + esc(extra.join(' · ')) + '</div>' : '');
}
function renderSession(){
  var s = S.sess, it = s.items[s.i], c = it.c, f = it.f;
  var p = progOf(c.id, f), front, back;
  var stats = '<div class="stats">Remembered ' + p.remembered + ' · Forgot ' + p.forgotten + ' · ' + ago(p.last_reviewed) + '</div>';
  var credit = c.credit ? '<div class="credit">' + esc(c.credit) + (c.link ? ' · <a href="' + esc(c.link) + '" target="_blank" rel="noopener">source</a>' : '') + '</div>' : '';
  var ex = c.example_jp ? '<div class="ex"><div>' + esc(c.example_jp) + '</div><div class="muted small">' + esc(c.example_en) + '</div></div>' : '';
  if (f === 'meaning') {
    front = settings.front === 'word' ? wordHTML(c, true) : picHTML(c);
    back = picHTML(c) + wordHTML(c) + '<div class="en">' + esc(c.en) + '</div>' + (c.pos ? '<div class="pos">' + esc(c.pos) + '</div>' : '') + ex + stats + credit;
  } else {
    var a = answer(c, f);
    var picOnly = f === 'masu' && c.image_id;
    front = picHTML(c, picOnly ? '' : ' small') + (picOnly ? '' : wordHTML(c)) + '<div class="ask">' + esc(FORM[f].label) + '</div>';
    back = '<div class="ask" style="margin:0 0 6px">' + esc(FORM[f].label) + '</div><div class="jp big">' + esc(a.main) + '</div>' +
      (a.alt ? '<div class="sub">' + esc(a.alt) + '</div>' : '') +
      '<div class="en">' + esc(c.jp) + ' — ' + esc(c.en) + '</div>' + stats;
  }
  var user = S.data.users.filter(function(u){ return u.id === s.user; })[0];
  app.innerHTML = '<div class="studyhead"><button class="link" data-act="end">‹ End</button>' +
    '<span class="muted small">' + esc(user ? user.name : '') + ' · ' + (s.i + 1) + ' / ' + s.items.length + '</span></div>' +
    '<div class="card" data-act="flip">' + (s.flipped ? back : front + '<div class="hint">Tap if you need to see the answer</div>') + '</div>' +
    '<div class="row"><button class="btn" data-act="prev">‹ Prev</button><button class="btn primary" data-act="next">' + (s.flipped ? 'Next ›' : 'Got it ›') + '</button></div>' +
    '<div class="row"><button class="btn sm" data-act="reroll">Different picture</button></div>';
}
function renderSummary(){
  var s = S.sess;
  app.innerHTML = '<h2>Done</h2><div class="panel" style="text-align:center"><div class="row" style="margin:0"><div style="flex:1"><div class="big-num ok">' + s.rem +
    '</div><div class="muted">remembered</div></div><div style="flex:1"><div class="big-num warn">' + s.forgot.length + '</div><div class="muted">forgot</div></div></div></div>' +
    '<div class="row">' + (s.forgot.length ? '<button class="btn primary" data-act="again">Study the ' + s.forgot.length + ' forgotten again</button>' : '') +
    '<button class="btn" data-act="go" data-arg="study">Back to Study</button></div>';
}
function startSession(items){
  S.sess = { items: items, i: 0, flipped: false, done: {}, rem: 0, forgot: [], user: settings.userId };
  go('session');
}
function advance(dir){
  var s = S.sess;
  if (dir > 0 && !s.done[s.i]) {
    var it = s.items[s.i], res = s.flipped ? 'forgot' : 'remembered';
    s.done[s.i] = true;
    record(it, res);
    if (res === 'forgot') s.forgot.push(it); else s.rem++;
  }
  if (dir > 0 && s.i === s.items.length - 1) { go('summary'); return; }
  s.i = Math.max(0, s.i + dir); s.flipped = false; renderSession();
}

/* ---------- Add/Edit ---------- */
function renderAdd(){
  var decks = S.data.decks;
  var html = '<h2>Add/Edit</h2><div class="panel"><h3>Add words from a page</h3>' +
    '<label for="target">Add to</label><select id="target" data-set-target><option value="new">New lesson…</option>' +
    decks.map(function(d){ return '<option value="' + esc(d.id) + '"' + (S.addTarget === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join('') + '</select>' +
    '<div id="newname"' + (S.addTarget !== 'new' ? ' hidden' : '') + '><label for="dname">New lesson name</label><input type="text" id="dname" placeholder="Lesson 3 (blank = use the name Claude read from the page)"></div>' +
    '<label for="paste">Paste Claude\'s reply</label><textarea id="paste" placeholder="{ &quot;words&quot;: [ ... ] }"></textarea>' +
    '<div class="row"><button class="btn primary" id="buildbtn" data-act="build">Build</button></div>' +
    '<div class="bar" id="bar" hidden><i></i></div><div class="log" id="log"></div><div id="result"></div></div>';
  html += '<div class="panel"><h3>Lessons</h3>' + (decks.length ? '<div class="list">' + decks.map(function(d){
    var cs = deckCards(d.id), pics = cs.filter(function(c){ return c.image_id; }).length;
    return '<div class="item"><div class="grow"><b>' + esc(d.name) + '</b><span class="muted small">' + cs.length + ' words' +
      (pics < cs.length ? ' · ' + (cs.length - pics) + ' without pictures' : '') + '</span></div>' +
      '<button class="btn sm" data-act="lesson" data-arg="' + esc(d.id) + '">Edit</button></div>';
  }).join('') + '</div>' : '<p class="muted" style="margin:0">No lessons yet.</p>') + '</div>';
  if (S.local.length) {
    html += '<div class="panel"><h3>Decks saved on this device</h3><p class="muted small">' + S.local.length +
      ' deck(s) from the earlier version are stored only on this device. Move them to the shared database so everyone can use them.</p>' +
      '<button class="btn primary" data-act="migrate">Move to shared database</button><div class="log" id="mlog"></div></div>';
  }
  app.innerHTML = html;
}
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
  return { words: words, lesson: obj.lesson || '', corrections: obj.corrections || [], unreadable: obj.unreadable || [], count: obj.count };
}
function findPictures(cards, onEach){
  var next = 0;
  function lane(){
    if (next >= cards.length) return Promise.resolve();
    var c = cards[next++];
    return api('POST', '/api/cards/' + c.id + '/picture', { mode: 'first', style: settings.style })
      .then(function(fresh){ updateCard(c, fresh); onEach(c, !!c.image_id); })
      .catch(function(e){ if (/access code/.test(e.message)) throw e; onEach(c, false); })
      .then(lane);
  }
  return Promise.all([lane(), lane(), lane()]);
}
function doBuild(){
  if (S.busy) return;
  var log = document.getElementById('log'), bar = document.getElementById('bar'), out = document.getElementById('result'), btn = document.getElementById('buildbtn');
  var parsed;
  try { parsed = parseInput(document.getElementById('paste').value); }
  catch (e) { log.innerHTML = '<span class="warn">' + esc(e.message) + '</span>'; return; }
  var target = S.addTarget, name = (document.getElementById('dname') || {}).value;
  name = (name || '').trim() || parsed.lesson || ('Lesson ' + (S.data.decks.length + 1));
  S.busy = true; btn.disabled = true; bar.hidden = false; out.innerHTML = '';
  log.textContent = 'Found ' + parsed.words.length + ' words' +
    (parsed.count && parsed.count !== parsed.words.length ? ' (Claude counted ' + parsed.count + ' on the page)' : '') + '. Saving…\n';
  var deck, done = 0, missing = 0;
  var getDeck = target === 'new'
    ? api('POST', '/api/decks', { name: name }).then(function(d){ S.data.decks.push(d); S.data.decks.sort(byName); return d; })
    : Promise.resolve(deckById(target));
  getDeck.then(function(d){
    deck = d;
    return api('POST', '/api/decks/' + d.id + '/cards', { words: parsed.words });
  }).then(function(r){
    r.cards.forEach(function(c){ S.data.cards.push(c); });
    log.textContent += 'Finding pictures…\n';
    return findPictures(r.cards, function(c, ok){
      done++; if (!ok) missing++;
      bar.firstChild.style.width = Math.round(done / r.cards.length * 100) + '%';
      log.textContent += done + '/' + r.cards.length + '  ' + c.jp + (ok ? '' : '  — no picture found') + '\n';
      log.scrollTop = log.scrollHeight;
    }).then(function(){ return r.cards.length; });
  }).then(function(n){
    S.addTarget = deck.id;
    var notes = '';
    if (parsed.corrections.length) notes += '<div class="note"><b>Corrections Claude made:</b><br>' + parsed.corrections.map(fmt).join('<br>') + '</div>';
    if (parsed.unreadable.length) notes += '<div class="note"><b>Couldn\'t read:</b><br>' + parsed.unreadable.map(fmt).join('<br>') + '</div>';
    out.innerHTML = '<p class="ok" style="margin-top:12px">Added ' + n + ' words to "' + esc(deck.name) + '"' + (missing ? ', ' + missing + ' without pictures' : '') + '.</p>' + notes +
      '<div class="row"><button class="btn" data-act="lesson" data-arg="' + esc(deck.id) + '">Review the words</button><button class="btn primary" data-act="go" data-arg="study">Study</button></div>';
  }).catch(function(e){ log.textContent += '\nStopped: ' + e.message; })
    .then(function(){ S.busy = false; btn.disabled = false; });
}
function fmt(x){ return esc(typeof x === 'string' ? x : JSON.stringify(x)); }

function renderLesson(){
  var d = deckById(S.lessonId);
  if (!d) return go('add');
  var cs = deckCards(d.id), others = S.data.decks.filter(function(x){ return x.id !== d.id; });
  var html = '<div class="studyhead"><button class="link" data-act="go" data-arg="add">‹ Add/Edit</button></div><h2>' + esc(d.name) + '</h2>' +
    '<div class="panel"><label for="lname" style="margin-top:0">Lesson name</label><input type="text" id="lname" value="' + esc(d.name) + '">' +
    '<div class="row"><button class="btn" data-act="rename">Save name</button><button class="btn" data-act="add-to" data-arg="' + esc(d.id) + '">Add more words</button></div>';
  if (others.length) {
    html += '<label for="into">Combine with another lesson</label><select id="into">' + others.map(function(x){ return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('') + '</select>' +
      '<div class="row"><button class="btn" data-act="merge">Move these ' + cs.length + ' words into it</button></div>';
  }
  html += '<div class="row"><button class="btn danger" data-act="del-lesson">Delete lesson</button></div></div>';
  html += '<div class="panel"><h3>Words (' + cs.length + ')</h3><div class="list">' + cs.map(function(c){
    return '<div class="item">' + (c.image_id ? '<img class="thumb" src="/img/' + esc(c.image_id) + '" alt="">' : '<div class="thumb empty"></div>') +
      '<div class="grow" data-act="word" data-arg="' + esc(c.id) + '" style="cursor:pointer"><b>' + esc(c.jp) + (c.kanji && c.kanji !== c.jp ? ' <span class="muted">' + esc(c.kanji) + '</span>' : '') + '</b>' +
      '<span class="muted small">' + esc(c.en) + ' · ' + esc(c.pos || '—') + '</span></div>' +
      '<button class="btn sm" data-act="word" data-arg="' + esc(c.id) + '">Edit</button>' +
      '<button class="btn sm danger" data-act="del-word" data-arg="' + esc(c.id) + '" aria-label="Remove">✕</button></div>';
  }).join('') + '</div></div>';
  app.innerHTML = html;
}
function field(id, label, val){ return '<label for="f_' + id + '">' + label + '</label><input type="text" id="f_' + id + '" value="' + esc(val) + '">'; }
function opts(list, cur){ return list.map(function(o){ return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }
function renderWord(){
  var c = cardById(S.cardId);
  if (!c) return go('lesson');
  var kind = c.pos === 'verb' ? 'verb' : (c.pos === 'i-adj' || c.pos === 'na-adj') ? 'adj' : '';
  var html = '<div class="studyhead"><button class="link" data-act="lesson" data-arg="' + esc(c.deck_id) + '">‹ ' + esc((deckById(c.deck_id) || {}).name) + '</button></div>' +
    '<h2>' + esc(c.jp) + '</h2><div class="panel" style="text-align:center">' + picHTML(c) +
    (c.credit ? '<div class="credit">' + esc(c.credit) + '</div>' : '') +
    '<div class="row"><button class="btn sm" data-act="reroll-edit">Different picture</button><button class="btn sm" data-act="research">Search again with the queries below</button></div></div>' +
    '<div class="panel"><div class="grid2"><div>' + field('jp', 'As written', c.jp) + '</div><div>' + field('kana', 'Reading (kana)', c.kana) + '</div>' +
    '<div>' + field('kanji', 'Kanji', c.kanji) + '</div><div>' + field('en', 'Meaning', c.en) + '</div>' +
    '<div><label for="f_pos">Word type</label><select id="f_pos">' + opts(POS, c.pos) + '</select></div>' +
    '<div><label for="f_group">Verb group</label><select id="f_group"' + (c.pos === 'verb' ? '' : ' disabled') + '>' +
      opts([['', 'Guess for me'], ['ichidan', 'る-verb (ichidan)'], ['godan', 'う-verb (godan)'], ['suru', 'する verb'], ['kuru', 'くる']], c.group || '') + '</select></div>' +
    '</div>' + field('example_jp', 'Example (Japanese)', c.example_jp) + field('example_en', 'Example (English)', c.example_en) +
    '<div class="grid2"><div>' + field('photo_query', 'Picture search', c.photo_query) + '</div><div>' + field('picto_query', 'Pictogram search', c.picto_query) + '</div></div>' +
    '<label for="f_deck">Lesson</label><select id="f_deck">' + opts(S.data.decks.map(function(d){ return [d.id, d.name]; }), c.deck_id) + '</select>';
  if (kind) {
    html += '<h3 style="margin-top:18px">Forms</h3><p class="muted small">Grey text is worked out automatically. Type over it only if it\'s wrong.</p>' +
      FORMS.filter(function(f){ return f.kind === kind; }).map(function(f){
        var auto = computed(c, f.id)[0] || '';
        var own = c.forms && c.forms[f.id] ? c.forms[f.id] : '';
        return '<div class="formrow"><span>' + esc(f.label) + '</span><input type="text" data-form="' + f.id + '" value="' + esc(own) + '" placeholder="' + esc(auto) + '"></div>';
      }).join('');
  }
  html += '<div class="row"><button class="btn primary" data-act="save-word">Save</button></div>' +
    '<div class="row"><button class="btn danger" data-act="del-word" data-arg="' + esc(c.id) + '">Delete word</button></div><p class="muted small" id="wmsg" style="margin-top:8px"></p></div>';
  app.innerHTML = html;
}
function readWordForm(){
  var v = function(id){ var el = document.getElementById('f_' + id); return el ? el.value.trim() : ''; };
  var forms = {};
  var ins = app.querySelectorAll('[data-form]');
  for (var k = 0; k < ins.length; k++) if (ins[k].value.trim()) forms[ins[k].getAttribute('data-form')] = ins[k].value.trim();
  return { jp: v('jp'), kana: v('kana'), kanji: v('kanji'), en: v('en'), pos: v('pos'), group: v('group'), example_jp: v('example_jp'), example_en: v('example_en'),
           photo_query: v('photo_query'), picto_query: v('picto_query'), deck_id: v('deck'), forms: forms };
}
function saveWord(){
  var c = cardById(S.cardId);
  return api('PATCH', '/api/cards/' + c.id, readWordForm()).then(function(fresh){ updateCard(c, fresh); });
}

/* ---------- settings ---------- */
function renderSettings(){
  var html = '<h2>Settings</h2><div class="panel">' +
    '<label for="code" style="margin-top:0">Access code</label><input type="password" id="code" value="' + esc(settings.code) + '" autocomplete="off">' +
    '<p class="muted small" style="margin-top:6px">The passcode you set as ACCESS_CODE on your Worker. Enter it once on each device.</p>' +
    '<div class="row"><button class="btn" data-act="ping">Check server</button></div><div class="log" id="pinglog"></div></div>';
  html += '<div class="panel"><h3>Cards on this device</h3>' +
    '<label for="style">Pictures for new words</label><select id="style" data-set="style">' + opts([['drawings', 'Drawings and pictograms'], ['photos', 'Photos for things, pictograms for ideas']], settings.style) + '</select>' +
    '<label for="front">Card front</label><select id="front" data-set="front">' + opts([['picture', 'Picture (recall the Japanese)'], ['word', 'Japanese (recall the meaning)']], settings.front) + '</select>' +
    '<label class="check"><input type="checkbox" data-set="bw"' + (settings.bw ? ' checked' : '') + '> Show pictures in black and white</label></div>';
  if (S.loaded && !S.err) {
    var u = currentUser();
    html += '<div class="panel"><h3>People</h3>' + (S.data.users.length ? '<div class="list">' + S.data.users.map(function(x){
      return '<div class="item"><div class="grow"><b>' + esc(x.name) + '</b></div><button class="btn sm" data-act="rename-user" data-arg="' + esc(x.id) + '">Rename</button>' +
        '<button class="btn sm danger" data-act="del-user" data-arg="' + esc(x.id) + '">Remove</button></div>';
    }).join('') + '</div>' : '<p class="muted">No one yet.</p>') + '<div class="row"><button class="btn" data-act="add-user">+ Add a person</button></div></div>';
    if (u) {
      var on = userForms(u);
      var box = function(kind){
        return FORMS.filter(function(f){ return f.kind === kind; }).map(function(f){
          return '<label class="check"><input type="checkbox" data-userform="' + f.id + '"' + (on.indexOf(f.id) >= 0 ? ' checked' : '') + '> ' + esc(f.label) + '</label>';
        }).join('');
      };
      html += '<div class="panel"><h3>Forms ' + esc(u.name) + ' has learned</h3><p class="muted small">Ticked forms show up under "What to review" on the Study tab. Saved for ' + esc(u.name) + ' on every device.</p>' +
        '<b class="small">Verbs</b>' + box('verb') + '<div style="height:12px"></div><b class="small">Adjectives</b>' + box('adj') + '</div>';
    }
  }
  app.innerHTML = html;
}

/* ---------- moving decks from the earlier version ---------- */
function openLocal(){
  return new Promise(function(res){
    try {
      var r = indexedDB.open('vocab-cards', 1);
      r.onupgradeneeded = function(){ r.result.createObjectStore('decks', { keyPath: 'id' }); };
      r.onsuccess = function(){ res(r.result); };
      r.onerror = function(){ res(null); };
    } catch (e) { res(null); }
  });
}
function localDecks(){
  return openLocal().then(function(db){
    if (!db) return [];
    return new Promise(function(res){
      try {
        var q = db.transaction('decks', 'readonly').objectStore('decks').getAll();
        q.onsuccess = function(){ res(q.result || []); }; q.onerror = function(){ res([]); };
      } catch (e) { res([]); }
    });
  });
}
function removeLocal(id){
  return openLocal().then(function(db){
    if (!db) return;
    return new Promise(function(res){ var t = db.transaction('decks', 'readwrite'); t.objectStore('decks').delete(id); t.oncomplete = res; t.onerror = res; });
  });
}
function toDataURL(x){
  if (typeof x === 'string') return Promise.resolve(x);
  return new Promise(function(res){
    try { var r = new FileReader(); r.onload = function(){ res(r.result); }; r.onerror = function(){ res(null); }; r.readAsDataURL(x); }
    catch (e) { res(null); }
  });
}
function migrate(){
  if (S.busy) return;
  S.busy = true;
  var log = document.getElementById('mlog'), list = S.local.slice();
  var say = function(t){ log.textContent += t + '\n'; log.scrollTop = log.scrollHeight; };
  var chain = Promise.resolve();
  list.forEach(function(ld){
    chain = chain.then(function(){
      say('Moving "' + ld.name + '"…');
      return api('POST', '/api/decks', { name: ld.name }).then(function(d){
        S.data.decks.push(d);
        var words = ld.cards.map(function(c){ var w = {}; for (var k in c) if (k !== 'img' && k !== 'cands' && k !== 'pick') w[k] = c[k]; return w; });
        return api('POST', '/api/decks/' + d.id + '/cards', { words: words });
      }).then(function(r){
        var k = 0;
        var step = function(){
          if (k >= r.cards.length) return Promise.resolve();
          var c = r.cards[k], img = ld.cards[k].img; k++;
          S.data.cards.push(c);
          return toDataURL(img).then(function(data){
            if (data && /^data:image\//.test(data) && data.length > 30) return api('POST', '/api/cards/' + c.id + '/upload', { imgData: data });
            return api('POST', '/api/cards/' + c.id + '/picture', { mode: 'first', style: settings.style });
          }).then(function(fresh){ updateCard(c, fresh); }).catch(function(){}).then(step);
        };
        return step();
      }).then(function(){ return removeLocal(ld.id); }).then(function(){ say('  done'); });
    });
  });
  chain.then(function(){ S.data.decks.sort(byName); S.local = []; say('All moved.'); })
    .catch(function(e){ say('Stopped: ' + e.message); })
    .then(function(){ S.busy = false; setTimeout(function(){ if (S.view === 'add') render(); }, 1200); });
}

/* ---------- actions ---------- */
function promptName(msg, val){ var n = window.prompt(msg, val || ''); return n && n.trim(); }
var actions = {
  go: function(arg){ go(arg); },
  reload: function(){ S.loaded = false; render(); load().then(render); },
  chip: function(arg, el){
    var g = el.getAttribute('data-group'), sel = settings.sel;
    if (g === 'order') sel.order = arg;
    else if (g === 'stale') sel.stale = !sel.stale;
    else { var a = sel[g], k = a.indexOf(arg); if (k >= 0) a.splice(k, 1); else a.push(arg); }
    saveSettings(); renderStudy();
  },
  start: function(){ var items = buildItems(selection()); if (items.length) startSession(items); },
  again: function(){ startSession(shuffle(S.sess.forgot.slice())); },
  end: function(){ go('study'); },
  flip: function(){ S.sess.flipped = !S.sess.flipped; renderSession(); },
  next: function(){ advance(1); },
  prev: function(){ advance(-1); },
  reroll: function(arg, el){
    var c = S.sess.items[S.sess.i].c;
    el.disabled = true; el.textContent = 'Loading…';
    api('POST', '/api/cards/' + c.id + '/picture', { mode: 'next', style: settings.style }).then(function(fresh){ updateCard(c, fresh); })
      .catch(function(e){ alert(e.message); }).then(renderSession);
  },
  'add-user': function(){
    var n = promptName('Name of the person studying');
    if (!n) return;
    api('POST', '/api/users', { name: n }).then(function(u){
      S.data.users.push(u); settings.userId = u.id; saveSettings();
      return loadProgress();
    }).then(render).catch(function(e){ alert(e.message); });
  },
  'rename-user': function(id){
    var u = S.data.users.filter(function(x){ return x.id === id; })[0];
    var n = promptName('New name', u.name);
    if (n) api('PATCH', '/api/users/' + id, { name: n }).then(function(){ u.name = n; render(); }).catch(function(e){ alert(e.message); });
  },
  'del-user': function(id){
    var u = S.data.users.filter(function(x){ return x.id === id; })[0];
    if (!confirm('Remove ' + u.name + ' and all of their progress?')) return;
    api('DELETE', '/api/users/' + id).then(function(){
      S.data.users = S.data.users.filter(function(x){ return x.id !== id; });
      if (settings.userId === id) { settings.userId = S.data.users.length ? S.data.users[0].id : ''; saveSettings(); return loadProgress(); }
    }).then(render).catch(function(e){ alert(e.message); });
  },
  build: doBuild,
  migrate: migrate,
  lesson: function(id){ S.lessonId = id; go('lesson'); },
  'add-to': function(id){ S.addTarget = id; go('add'); },
  rename: function(){
    var d = deckById(S.lessonId), n = document.getElementById('lname').value.trim();
    if (!n) return;
    api('PATCH', '/api/decks/' + d.id, { name: n }).then(function(){ d.name = n; S.data.decks.sort(byName); render(); }).catch(function(e){ alert(e.message); });
  },
  merge: function(){
    var d = deckById(S.lessonId), into = deckById(document.getElementById('into').value);
    if (!confirm('Move all words from "' + d.name + '" into "' + into.name + '"? "' + d.name + '" will be removed; progress is kept.')) return;
    api('POST', '/api/decks/' + d.id + '/merge', { into: into.id }).then(function(){ S.lessonId = into.id; return load(); }).then(render).catch(function(e){ alert(e.message); });
  },
  'del-lesson': function(){
    var d = deckById(S.lessonId);
    if (!confirm('Delete "' + d.name + '", its ' + deckCards(d.id).length + ' words, pictures and progress? This can\'t be undone.')) return;
    api('DELETE', '/api/decks/' + d.id).then(function(){
      S.data.cards = S.data.cards.filter(function(c){ return c.deck_id !== d.id; });
      S.data.decks = S.data.decks.filter(function(x){ return x.id !== d.id; });
      if (S.addTarget === d.id) S.addTarget = 'new';
      go('add');
    }).catch(function(e){ alert(e.message); });
  },
  word: function(id){ S.cardId = id; go('word'); },
  'del-word': function(id){
    var c = cardById(id);
    if (!confirm('Delete "' + c.jp + '"?')) return;
    api('DELETE', '/api/cards/' + id).then(function(){
      S.data.cards = S.data.cards.filter(function(x){ return x.id !== id; });
      S.lessonId = c.deck_id; if (S.view === 'word') go('lesson'); else render();
    }).catch(function(e){ alert(e.message); });
  },
  'save-word': function(arg, el){
    el.disabled = true;
    saveWord().then(function(){ var c = cardById(S.cardId); S.lessonId = c.deck_id; go('lesson'); })
      .catch(function(e){ el.disabled = false; document.getElementById('wmsg').textContent = e.message; });
  },
  'reroll-edit': function(arg, el){
    var c = cardById(S.cardId);
    el.disabled = true; el.textContent = 'Loading…';
    api('POST', '/api/cards/' + c.id + '/picture', { mode: 'next', style: settings.style }).then(function(fresh){ updateCard(c, fresh); })
      .catch(function(e){ alert(e.message); }).then(renderWord);
  },
  research: function(arg, el){
    var c = cardById(S.cardId);
    el.disabled = true; el.textContent = 'Searching…';
    saveWord().then(function(){ return api('POST', '/api/cards/' + c.id + '/picture', { mode: 'search', style: settings.style }); })
      .then(function(fresh){ updateCard(c, fresh); if (!c.image_id) alert('No pictures found for those searches.'); })
      .catch(function(e){ alert(e.message); }).then(renderWord);
  },
  ping: function(){
    var log = document.getElementById('pinglog'); log.textContent = 'Checking…';
    api('GET', '/api/ping').then(function(d){
      log.textContent = 'Server OK.\nShared database: ' + (d.db ? 'linked' : 'NOT linked (add the D1 binding)') +
        (d.db ? '\nPictures stored: ' + d.images + ' (' + (d.bytes / 1048576).toFixed(1) + ' MB of 500 MB free plan)' : '') +
        '\nARASAAC and Openverse: on\nPixabay: ' + (d.pixabay ? 'on' : 'off (no PIXABAY_KEY)') + '\nPexels: ' + (d.pexels ? 'on' : 'off (no PEXELS_KEY)');
      if (S.err) actions.reload();
    }).catch(function(e){ log.textContent = e.message; });
  }
};

document.addEventListener('click', function(e){
  if (e.target.closest('a')) return;
  var el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  var fn = actions[el.getAttribute('data-act')];
  if (fn) fn(el.getAttribute('data-arg'), el);
});
document.addEventListener('change', function(e){
  var t = e.target;
  if (t.hasAttribute('data-set')) {
    var key = t.getAttribute('data-set');
    settings[key] = t.type === 'checkbox' ? t.checked : t.value; saveSettings();
  } else if (t.hasAttribute('data-set-user')) {
    settings.userId = t.value; saveSettings();
    flush().then(loadProgress).then(render);
  } else if (t.hasAttribute('data-set-limit')) {
    settings.sel.limit = t.value; saveSettings(); renderStudy();
  } else if (t.hasAttribute('data-set-target')) {
    S.addTarget = t.value; document.getElementById('newname').hidden = t.value !== 'new';
  } else if (t.hasAttribute('data-userform')) {
    var u = currentUser(), list = userForms(u).slice(), id = t.getAttribute('data-userform');
    if (t.checked) { if (list.indexOf(id) < 0) list.push(id); } else list = list.filter(function(x){ return x !== id; });
    u.prefs = u.prefs || {}; u.prefs.forms = list;
    api('PATCH', '/api/users/' + u.id, { prefs: u.prefs }).catch(function(err){ alert(err.message); });
  }
});
document.addEventListener('input', function(e){
  if (e.target.id === 'code') { settings.code = e.target.value; saveSettings(); }
});
document.addEventListener('toggle', function(e){
  if (e.target.getAttribute && e.target.getAttribute('data-details') === 'lessons') S.lessonsOpen = e.target.open;
}, true);
document.addEventListener('keydown', function(e){
  if (S.view !== 'session' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight' || e.key === 'Enter') advance(1);
  else if (e.key === 'ArrowLeft') advance(-1);
  else if (e.key === ' ') { e.preventDefault(); actions.flip(); }
});
window.addEventListener('online', flush);

try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
window.VocabCards = { answer: answer, guessGroup: guessGroup, forms: FORMS };
render();
load().then(function(){ return localDecks(); }).then(function(l){ S.local = l || []; render(); });
})();
</script>
</body>
</html>
`;
