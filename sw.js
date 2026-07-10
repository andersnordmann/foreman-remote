/* claude-foreman service worker — receives Web Push and shows notifications even when the
   phone page is CLOSED. The foreman sends PAYLOAD-LESS pushes (a "tickle"); this worker wakes,
   reads the live state from Turso (creds handed over by the page, cached here), and shows the
   notification. Tapping it focuses an already-open page (switched to the relevant instance) or
   opens a new one at that instance.

   iOS RULE: Safari revokes the push subscription after 3 "silent" pushes (a push that shows no
   notification). So EVERY push path here ends in showNotification() inside event.waitUntil() —
   the Turso fetch is best-effort enrichment with a short timeout and a generic fallback; if it
   fails we still show something. Never return from a push without a notification. */
"use strict";

const CACHE = "foreman-cfg-v1";
const CFG_KEY = "/__cfg";     // {syncUrl, token, pageUrl}
const SEEN_KEY = "/__seen";   // last-seen status snapshot {id: {...}} for change detection

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The page hands us its Turso creds + its own URL (so a closed-page push can still read state and
// know which page to open). Re-sent on every page load / when creds change, so this stays fresh.
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "cfg") {
    e.waitUntil(cachePut(CFG_KEY, { syncUrl: d.syncUrl || "", token: d.token || "", pageUrl: d.pageUrl || "" }));
  }
});

async function cachePut(key, obj) {
  const c = await caches.open(CACHE);
  await c.put(key, new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }));
}
async function cacheGet(key) {
  const c = await caches.open(CACHE);
  const r = await c.match(key);
  if (!r) return null;
  try { return await r.json(); } catch (e) { return null; }
}

function normalise(u) { return u && u.startsWith("libsql://") ? "https://" + u.slice(9) : u; }

// Minimal Turso (Hrana-over-HTTP) query — same shape the page uses, with a short abort timeout so
// event.waitUntil() always resolves quickly and we never miss the mandatory showNotification.
async function tursoQuery(cfg, sql) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(normalise(cfg.syncUrl).replace(/\/+$/, "") + "/v2/pipeline", {
      method: "POST",
      headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql } }] }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    const result = j.results[0].response.result;
    const cols = result.cols.map((c) => c.name);
    return result.rows.map((row) => Object.fromEntries(row.map((cell, i) => [cols[i], cell.type === "null" ? null : cell.value])));
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

// Pick the instance whose status changed most recently vs the last-seen snapshot, and craft a
// human line. Falls back to the single / most-recent row when there's no prior snapshot.
function pickChanged(rows, seen) {
  if (!rows || !rows.length) return null;
  const changed = rows.filter((r) => {
    const p = seen[r.id];
    return !p || p.updated_at !== r.updated_at || p.state !== r.state || p.last_result !== r.last_result || p.push_event !== r.push_event;
  });
  const pool = changed.length ? changed : rows;
  pool.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return pool[0];
}

// Latest plain-English story line the foreman wrote (newest-first array), minus its "[HH:MM] "
// prefix (the OS already timestamps the notification). "" if none — callers fall back to a phase line.
function firstStory(row) {
  try {
    const s = JSON.parse(row.story || "[]");
    if (Array.isArray(s) && s.length) return String(s[0]).replace(/^\[\d\d:\d\d\]\s*/, "");
  } catch (e) { /* ignore */ }
  return "";
}

// Friendly TITLE for an 'activity' push, derived from last_result (the exact current phase, which is
// always fresh — see the header note) so the title names WHAT the run is doing even when the story
// body trails a step. Order matters: "gate FAIL - reverting" must match Reverting before Verifying.
function phaseTitle(lastResult) {
  const s = (lastResult || "").toLowerCase();
  if (s.indexOf("revert") >= 0 || s.indexOf("fail") >= 0) return "↩️ Reverting";
  if (s.indexOf("worker") === 0) return "🔧 Working";
  if (s.indexOf("commit") >= 0) return "📦 Committing";
  if (s.indexOf("challenge") >= 0) return "🥊 Challenging";
  if (s.indexOf("gate") >= 0) return "🔍 Verifying";
  return "🔧 Working";
}

function messageFor(row) {
  const inst = row.id || "run";
  const st = row.state || "";
  const ev = row.push_event || "";   // the event the foreman stamped when it sent this push
  const story = firstStory(row);     // rich human line (metric delta, item title, why) — best body
  const phase = [inst];
  if (row.last_item) phase.push(row.last_item);
  if (row.last_result) phase.push(row.last_result);
  const fallback = phase.join(" · ");
  let title, body;
  // Terminal / lifecycle STATE is authoritative for the headline; the story line makes the best body.
  if (st === "done") { title = "✅ Run complete"; body = story || (inst + " — all tasks done"); }
  else if (st === "crashed") { title = "⚠️ Foreman crashed"; body = inst; }
  else if (st.indexOf("stopped") === 0) { title = "⏹ Stopped"; body = story || inst; }
  else if (st === "paused-rate-limit") { title = "⏳ Paused — rate limit"; body = story || (inst + " — waiting for your quota to reset, then it resumes"); }
  else if (st.indexOf("paused") === 0) { title = "⏸ Paused"; body = story || (inst + " — " + st.replace("paused-", "")); }
  // Otherwise the run is 'running' — title by the EVENT that fired the push, body = the story line
  // (so an escalation reads "Needs review" + exactly which task and why), falling back to the phase.
  else if (ev === "attention") { title = "⚠️ Needs review"; body = story || (fallback + " — a task was escalated"); }
  else if (ev === "item") { title = "✅ Item shipped"; body = story || fallback; }
  // activity / unknown: title names the exact current phase (from the always-fresh last_result),
  // body keeps the rich story line.
  else { title = phaseTitle(row.last_result); body = story || fallback; }
  return { title, body, instance: inst };
}

self.addEventListener("push", (e) => {
  // ALWAYS end in showNotification (iOS silent-push rule). ORDER MATTERS: show a notification
  // IMMEDIATELY, THEN best-effort enrich it from Turso (same tag = update in place). Doing the
  // network fetch BEFORE the first showNotification risked the SW being killed mid-fetch on a
  // browser with a short push budget -> zero notification. Also ping any open page (diagnostic:
  // proves the push reached the SW even if the OS doesn't display the notification).
  const TAG = "foreman";
  e.waitUntil((async () => {
    const cfg = await cacheGet(CFG_KEY);
    const pageUrl = (cfg && cfg.pageUrl) || "./";
    const showN = (title, body, instance) => {
      const url = pageUrl + (instance ? ((pageUrl.indexOf("?") >= 0 ? "&" : "?") + "instance=" + encodeURIComponent(instance)) : "");
      return self.registration.showNotification(title, { body, tag: TAG, renotify: true, icon: "./icon-192.png", badge: "./badge-96.png", data: { url, instance } });
    };
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clients) c.postMessage({ type: "push-received", at: Date.now() });
    } catch (err) { /* ignore */ }
    await showN("claude-foreman", "Update — tap to open", "");   // GUARANTEED first, before any await on the network
    if (cfg && cfg.syncUrl && cfg.token) {                       // enrich in place (best-effort)
      const rows = await tursoQuery(cfg, "SELECT id, updated_at, state, batch, last_item, last_result, pending, push_event, story FROM foreman_status");
      if (rows) {
        const seen = (await cacheGet(SEEN_KEY)) || {};
        const row = pickChanged(rows, seen);
        if (row) { const m = messageFor(row); await showN("claude-foreman · " + m.title, m.body, m.instance); }
        const snap = {};
        for (const r of rows) snap[r.id] = { updated_at: r.updated_at, state: r.state, last_result: r.last_result, push_event: r.push_event };
        await cachePut(SEEN_KEY, snap);
      }
    }
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const targetUrl = data.url || "./";
  const instance = data.instance || "";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer an already-open phone page: focus it and tell it which instance to select.
    for (const c of all) {
      try {
        const cu = new URL(c.url);
        const tu = new URL(targetUrl, self.registration.scope);
        if (cu.origin === tu.origin && cu.pathname === tu.pathname) {
          await c.focus();
          c.postMessage({ type: "select-instance", instance });
          return;
        }
      } catch (err) { /* keep looking */ }
    }
    // None open -> open a new window at the target instance.
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
