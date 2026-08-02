/**
 * Scissortail collector - Cloudflare Worker.
 *
 * Routes:
 *   POST/GET  /count       record a page view (public, CORS open)
 *   GET       /api/stats   aggregated stats as JSON (needs Bearer DASH_TOKEN)
 *   GET       /            health check
 *
 * Bindings (see wrangler.toml):
 *   DB          D1 database
 *   SALT        secret string used to hash visitors (wrangler secret put SALT)
 *   DASH_TOKEN  secret read token for /api/stats (wrangler secret put DASH_TOKEN)
 *
 * Privacy: no cookies, no stored IP addresses, no cross-site identifiers.
 * The visitor hash rotates every day and cannot be reversed to a person.
 */

import { reportSites, sendNow, runReports, magicLink } from "./reports.js";

var BOT = /bot|crawl|spider|slurp|preview|monitor|lighthouse|headless|curl|wget|python-requests|axios|okhttp/i;
var CTRL = new RegExp("[\\x00-\\x1f\\x7f]", "g");

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/count") return await count(request, url, env, cors);
      if (url.pathname === "/api/stats") return await stats(request, url, env, cors);
      if (url.pathname === "/api/reset") return await reset(request, url, env, cors);
      if (url.pathname === "/wti") return await wti(cors);
      if (url.pathname === "/api/report-sites") return await reportSites(request, url, env, cors, { json: json, safeJson: safeJson, clean: clean });
      if (url.pathname === "/api/send-now") return await sendNow(request, url, env, cors, { json: json, safeJson: safeJson, clean: clean });
      if (url.pathname.indexOf("/r/") === 0) return await magicLink(url, env);
      if (url.pathname === "/") return text("Scissortail is running.", 200, cors);
      return text("Not found", 404, cors);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500, cors);
    }
  },

  // Daily cron: send any reports that are due (see wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReports(env));
  },
};

/* ---------- record a view ---------- */
async function count(request, url, env, cors) {
  var ua = request.headers.get("User-Agent") || "";
  if (BOT.test(ua)) return pixel(cors);

  var d = {};
  if (request.method === "POST") {
    d = await safeJson(request);
  } else {
    var raw = url.searchParams.get("d");
    if (raw) { try { d = JSON.parse(raw); } catch (e) { d = {}; } }
    if (!d.p) d.p = url.searchParams.get("p") || "/";
    if (!d.site) d.site = url.searchParams.get("site") || "";
  }

  var site = clean(d.site, 64) || "default";
  var path = clean(d.p, 512) || "/";
  var ref = clean(d.r, 255) || null;
  var screen = clean(d.s, 16) || null;

  var now = new Date();
  var ts = Math.floor(now.getTime() / 1000);
  var day = now.toISOString().slice(0, 10);

  var ip = (request.headers.get("CF-Connecting-IP") || "").trim();
  var coarse = coarsen(ip);
  var visitor = await sha256(day + "|" + site + "|" + coarse + "|" + ua + "|" + (env.SALT || "scissortail"));
  var vis = visitor.slice(0, 32);

  // Approximate location from Cloudflare's edge (derived from IP, but the IP is never stored).
  var cf = request.cf || {};
  var city = clean(cf.city, 64) || null;
  var region = clean(cf.regionCode || cf.region, 32) || null;
  var country = clean(cf.country, 8) || null;

  try {
    await env.DB.prepare(
      "INSERT INTO hits (ts, day, site, path, ref, screen, visitor, city, region, country) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(ts, day, site, path, ref, screen, vis, city, region, country).run();
  } catch (e) {
    // Location columns may not exist yet; fall back so tracking never breaks.
    await env.DB.prepare(
      "INSERT INTO hits (ts, day, site, path, ref, screen, visitor) VALUES (?,?,?,?,?,?,?)"
    ).bind(ts, day, site, path, ref, screen, vis).run();
  }

  return pixel(cors);
}

/* ---------- WTI crude price (real front-month futures) ---------- */
async function wti(cors) {
  // Primary: Yahoo Finance chart API for CL=F (NYMEX WTI front-month continuous).
  try {
    var r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=15m&range=1d", {
      headers: { "User-Agent": "Mozilla/5.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (r.ok) {
      var j = await r.json();
      var res = j && j.chart && j.chart.result && j.chart.result[0];
      var meta = res && res.meta;
      if (meta && meta.regularMarketPrice != null) {
        var price = meta.regularMarketPrice;
        var prev = (meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose);
        if (prev == null) prev = price;
        var change = price - prev;
        var pct = prev ? (change / prev) * 100 : 0;
        return json({ price: price, change: change, pct: pct, prev: prev, t: meta.regularMarketTime || 0, source: "yahoo" }, 200, cors);
      }
    }
  } catch (e) { /* fall through */ }

  // Fallback: Stooq CSV (price only).
  try {
    var r2 = await fetch("https://stooq.com/q/l/?s=cl.f&f=sd2t2ohlcv&h&e=csv", { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r2.ok) {
      var txt = await r2.text();
      var lines = txt.trim().split("\n");
      if (lines.length > 1) {
        var c = lines[1].split(",");
        var close = parseFloat(c[6]);
        if (close) return json({ price: close, change: 0, pct: 0, source: "stooq" }, 200, cors);
      }
    }
  } catch (e2) { /* fall through */ }

  return json({ error: "unavailable" }, 502, cors);
}

/* ---------- aggregated stats ---------- */
async function stats(request, url, env, cors) {
  if (env.DASH_TOKEN) {
    var auth = request.headers.get("Authorization") || "";
    if (auth !== "Bearer " + env.DASH_TOKEN) return json({ error: "unauthorized" }, 401, cors);
  }

  var site = clean(url.searchParams.get("site"), 64) || "default";
  var days = parseInt(url.searchParams.get("days") || "30", 10);
  if (!(days > 0) || days > 366) days = 30;
  var since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  var db = env.DB;
  var results = await Promise.all([
    db.prepare("SELECT COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM hits WHERE site=? AND day>=?").bind(site, since).first(),
    db.prepare("SELECT day, COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM hits WHERE site=? AND day>=? GROUP BY day ORDER BY day").bind(site, since).all(),
    db.prepare("SELECT path, COUNT(*) views FROM hits WHERE site=? AND day>=? GROUP BY path ORDER BY views DESC LIMIT 12").bind(site, since).all(),
    db.prepare("SELECT COALESCE(NULLIF(ref,''),'(direct)') ref, COUNT(*) views FROM hits WHERE site=? AND day>=? GROUP BY ref ORDER BY views DESC LIMIT 12").bind(site, since).all(),
    db.prepare("SELECT COALESCE(NULLIF(screen,''),'(unknown)') screen, COUNT(*) views FROM hits WHERE site=? AND day>=? GROUP BY screen ORDER BY views DESC LIMIT 8").bind(site, since).all(),
    db.prepare("SELECT DISTINCT site FROM hits ORDER BY site").all(),
  ]);

  // Locations are queried separately and defensively, so the dashboard still works
  // before the city/region/country columns have been added.
  var locations = [];
  try {
    var lr = await db.prepare(
      "SELECT COALESCE(NULLIF(city,''),'(unknown)') city, COALESCE(NULLIF(region,''),'') region, COALESCE(NULLIF(country,''),'') country, COUNT(*) views FROM hits WHERE site=? AND day>=? GROUP BY city, region, country ORDER BY views DESC LIMIT 12"
    ).bind(site, since).all();
    locations = lr.results || [];
  } catch (e) { locations = []; }

  var totals = results[0] || {};
  return json({
    site: site,
    days: days,
    totals: { views: totals.views || 0, visitors: totals.visitors || 0 },
    series: fillDays((results[1].results) || [], since, days),
    pages: results[2].results || [],
    referrers: results[3].results || [],
    screens: results[4].results || [],
    locations: locations,
    sites: (results[5].results || []).map(function (r) { return r.site; }),
  }, 200, cors);
}

/* ---------- clear a site's data (start fresh) ---------- */
async function reset(request, url, env, cors) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
  if (env.DASH_TOKEN) {
    var auth = request.headers.get("Authorization") || "";
    if (auth !== "Bearer " + env.DASH_TOKEN) return json({ error: "unauthorized" }, 401, cors);
  }
  var site = clean(url.searchParams.get("site"), 64);
  if (!site) return json({ error: "site required" }, 400, cors);
  var res = await env.DB.prepare("DELETE FROM hits WHERE site=?").bind(site).run();
  var removed = (res && res.meta && res.meta.changes) || 0;
  return json({ ok: true, site: site, removed: removed }, 200, cors);
}

/* ---------- helpers ---------- */
function fillDays(rows, since, days) {
  var map = {};
  rows.forEach(function (r) { map[r.day] = r; });
  var out = [];
  var start = new Date(since + "T00:00:00Z");
  for (var i = 0; i < days; i++) {
    var d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    var r = map[d];
    out.push({ day: d, views: r ? r.views : 0, visitors: r ? r.visitors : 0 });
  }
  return out;
}

function coarsen(ip) {
  if (!ip) return "0";
  if (ip.indexOf(":") !== -1) return ip.split(":").slice(0, 3).join(":");
  var p = ip.split(".");
  if (p.length === 4) { p[3] = "0"; return p.join("."); }
  return ip;
}

async function sha256(str) {
  var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  var arr = Array.prototype.slice.call(new Uint8Array(buf));
  return arr.map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function clean(v, max) {
  if (v == null) return "";
  return String(v).replace(CTRL, "").slice(0, max).trim();
}

async function safeJson(request) {
  try { return await request.json(); }
  catch (e) {
    try { var t = await request.text(); return JSON.parse(t); }
    catch (e2) { return {}; }
  }
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors),
  });
}
function text(body, status, cors) {
  return new Response(body, { status: status || 200, headers: Object.assign({ "Content-Type": "text/plain" }, cors) });
}
function pixel(cors) {
  var gif = Uint8Array.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,0,0,0,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
  return new Response(gif, { status: 200, headers: Object.assign({ "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" }, cors) });
}
