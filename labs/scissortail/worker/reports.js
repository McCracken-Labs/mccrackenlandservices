/**
 * Scissortail Reports — scheduled email reports + magic-link pages.
 *
 * This module is imported by worker.js. It adds:
 *   - report_sites registry (one row per tracked site: email, frequency, slug)
 *   - a daily cron (scheduled handler) that emails every report that is due
 *   - GET  /r/<slug>            a private read-only stats page (no login)
 *   - GET  /api/report-sites    list registered sites (needs DASH_TOKEN)
 *   - POST /api/report-sites    add or update a site   (needs DASH_TOKEN)
 *   - POST /api/send-now?site=  send one report right now, for testing
 *
 * Email is sent through Resend (env.RESEND_API_KEY). Clients never see any of
 * this — they just get a branded email. No cookies or personal data are stored.
 */

var FREQ_OK = { daily: 1, weekly: 1, monthly: 1 };

/* ---------- registry ---------- */
async function ensureReportTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS report_sites (" +
    "site TEXT PRIMARY KEY, name TEXT, email TEXT, freq TEXT, slug TEXT, " +
    "active INTEGER DEFAULT 1, last_sent TEXT DEFAULT '')"
  ).run();
}
function authed(request, env) {
  if (!env.DASH_TOKEN) return true;
  return (request.headers.get("Authorization") || "") === "Bearer " + env.DASH_TOKEN;
}
function reportBase(env) {
  return (env.REPORT_BASE || "https://scissortail.mccrackenlabs.workers.dev").replace(/\/+$/, "");
}
function mailFrom(env) { return env.MAIL_FROM || "Scissortail Reports <reports@mccrackenlabs.com>"; }
async function randomSlug() {
  var a = new Uint8Array(16); crypto.getRandomValues(a);
  return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

export async function reportSites(request, url, env, cors, helpers) {
  if (!authed(request, env)) return helpers.json({ error: "unauthorized" }, 401, cors);
  await ensureReportTable(env);
  if (request.method === "GET") {
    var rows = (await env.DB.prepare("SELECT site,name,email,freq,slug,active,last_sent FROM report_sites ORDER BY site").all()).results || [];
    rows.forEach(function (r) { r.magic_link = reportBase(env) + "/r/" + r.slug; });
    return helpers.json({ sites: rows }, 200, cors);
  }
  if (request.method === "POST") {
    var b = await helpers.safeJson(request);
    var site = helpers.clean(b.site, 64);
    var email = helpers.clean(b.email, 200);
    var name = helpers.clean(b.name, 120) || site;
    var freq = helpers.clean(b.freq, 12); if (!FREQ_OK[freq]) freq = "weekly";
    if (!site || !email) return helpers.json({ error: "site and email are required" }, 400, cors);
    var existing = await env.DB.prepare("SELECT slug FROM report_sites WHERE site=?").bind(site).first();
    var slug = (existing && existing.slug) ? existing.slug : await randomSlug();
    await env.DB.prepare(
      "INSERT INTO report_sites (site,name,email,freq,slug,active,last_sent) VALUES (?,?,?,?,?,1,'') " +
      "ON CONFLICT(site) DO UPDATE SET name=excluded.name, email=excluded.email, freq=excluded.freq, active=1"
    ).bind(site, name, email, freq, slug).run();
    return helpers.json({ ok: true, site: site, name: name, email: email, freq: freq, magic_link: reportBase(env) + "/r/" + slug }, 200, cors);
  }
  return helpers.json({ error: "method not allowed" }, 405, cors);
}

export async function sendNow(request, url, env, cors, helpers) {
  if (request.method !== "POST") return helpers.json({ error: "method not allowed" }, 405, cors);
  if (!authed(request, env)) return helpers.json({ error: "unauthorized" }, 401, cors);
  await ensureReportTable(env);
  var key = helpers.clean(url.searchParams.get("site"), 64);
  var s = await env.DB.prepare("SELECT * FROM report_sites WHERE site=?").bind(key).first();
  if (!s) return helpers.json({ error: "site not registered" }, 404, cors);
  var out = await sendReport(env, s);
  return helpers.json(out, out.ok ? 200 : 502, cors);
}

/* ---------- cron ---------- */
export async function runReports(env) {
  await ensureReportTable(env);
  var rows = (await env.DB.prepare("SELECT * FROM report_sites WHERE active=1").all()).results || [];
  var today = new Date().toISOString().slice(0, 10);
  var now = new Date(), dow = now.getUTCDay(), dom = now.getUTCDate();
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i];
    if (s.last_sent === today) continue;
    var due = s.freq === "daily" || (s.freq === "weekly" && dow === 1) || (s.freq === "monthly" && dom === 1);
    if (!due) continue;
    try { await sendReport(env, s); } catch (e) { /* keep sending the others */ }
  }
}

async function sendReport(env, s) {
  var data = await buildReport(env, s, null);
  var html = renderReportEmail(env, s, data);
  var subject = s.name + " — " + data.periodLabel;
  var res = await sendEmail(env, s.email, subject, html);
  if (res.ok) await env.DB.prepare("UPDATE report_sites SET last_sent=? WHERE site=?").bind(new Date().toISOString().slice(0, 10), s.site).run();
  return { ok: res.ok, site: s.site, to: s.email, subject: subject, error: res.error || null };
}

/* ---------- data ---------- */
async function buildReport(env, s, forceDays) {
  var now = new Date(), start, end, pStart, pEnd, label;
  if (forceDays) {
    end = new Date(now.getTime() - 86400000);
    start = new Date(end.getTime() - (forceDays - 1) * 86400000);
    pEnd = new Date(start.getTime() - 86400000);
    pStart = new Date(pEnd.getTime() - (forceDays - 1) * 86400000);
    label = "Last " + forceDays + " days";
  } else if (s.freq === "monthly") {
    var firstThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    end = new Date(firstThis.getTime() - 86400000);
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    pEnd = new Date(start.getTime() - 86400000);
    pStart = new Date(Date.UTC(pEnd.getUTCFullYear(), pEnd.getUTCMonth(), 1));
    label = monthName(start) + " " + start.getUTCFullYear();
  } else if (s.freq === "weekly") {
    end = new Date(now.getTime() - 86400000);
    start = new Date(end.getTime() - 6 * 86400000);
    pEnd = new Date(start.getTime() - 86400000);
    pStart = new Date(pEnd.getTime() - 6 * 86400000);
    label = fmtDay(start) + " – " + fmtDay(end);
  } else {
    end = new Date(now.getTime() - 86400000);
    start = end;
    pEnd = new Date(start.getTime() - 86400000);
    pStart = pEnd;
    label = fmtDay(end) + ", " + end.getUTCFullYear();
  }
  var a = ymd(start), b = ymd(end), pa = ymd(pStart), pb = ymd(pEnd);
  var db = env.DB, site = s.site;
  var totals = await db.prepare("SELECT COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM hits WHERE site=? AND day>=? AND day<=?").bind(site, a, b).first();
  var prev = await db.prepare("SELECT COUNT(*) views, COUNT(DISTINCT visitor) visitors FROM hits WHERE site=? AND day>=? AND day<=?").bind(site, pa, pb).first();
  var pages = (await db.prepare("SELECT path, COUNT(*) views FROM hits WHERE site=? AND day>=? AND day<=? GROUP BY path ORDER BY views DESC LIMIT 6").bind(site, a, b).all()).results || [];
  var refs = (await db.prepare("SELECT COALESCE(NULLIF(ref,''),'(direct)') ref, COUNT(*) views FROM hits WHERE site=? AND day>=? AND day<=? GROUP BY ref ORDER BY views DESC LIMIT 5").bind(site, a, b).all()).results || [];
  var seen = await db.prepare("SELECT COUNT(DISTINCT path) n FROM hits WHERE site=? AND day>=? AND day<=?").bind(site, a, b).first();
  var busiest = await db.prepare("SELECT day, COUNT(*) v FROM hits WHERE site=? AND day>=? AND day<=? GROUP BY day ORDER BY v DESC LIMIT 1").bind(site, a, b).first();
  var locs = [];
  try { locs = (await db.prepare("SELECT COALESCE(NULLIF(city,''),'(unknown)') city, COALESCE(NULLIF(region,''),'') region, COUNT(*) views FROM hits WHERE site=? AND day>=? AND day<=? GROUP BY city,region ORDER BY views DESC LIMIT 4").bind(site, a, b).all()).results || []; } catch (e) { locs = []; }
  return {
    periodLabel: label,
    views: num(totals && totals.views), visitors: num(totals && totals.visitors),
    prevViews: num(prev && prev.views), prevVisitors: num(prev && prev.visitors),
    pages: pages, refs: refs, locations: locs,
    pagesSeen: num(seen && seen.n), busiest: busiest ? busiest.day : null
  };
}

/* ---------- send via Resend ---------- */
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  try {
    var r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign(
        { from: mailFrom(env), to: [to], subject: subject, html: html },
        env.REPLY_TO ? { reply_to: env.REPLY_TO } : {}
      ))
    });
    if (r.ok) return { ok: true };
    var t = await r.text();
    return { ok: false, error: "resend " + r.status + ": " + t.slice(0, 200) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/* ---------- magic-link page ---------- */
export async function magicLink(url, env, helpers) {
  await ensureReportTable(env);
  var slug = url.pathname.replace(/^\/r\//, "").replace(/[^a-f0-9]/gi, "");
  var s = await env.DB.prepare("SELECT * FROM report_sites WHERE slug=?").bind(slug).first();
  if (!s) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  var data = await buildReport(env, s, 30);
  var body = renderReportEmail(env, s, data, true);
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/* ---------- small helpers ---------- */
function num(v) { return (v == null) ? 0 : (v | 0); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function monthName(d) { return ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()]; }
function fmtDay(d) { return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()] + " " + d.getUTCDate(); }
function prettyPath(p) {
  if (!p || p === "/" || p === "/index.html") return "Home";
  var t = p.replace(/\/index\.html$/, "").replace(/\.html$/, "").replace(/^\//, "").replace(/\/$/, "");
  t = (t.split("/").pop() || "").replace(/[-_]/g, " ");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Home";
}
function prettyRef(r) { if (!r || r === "(direct)") return "Direct / typed in"; return String(r).replace(/^www\./, ""); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function pctBadge(cur, prev) {
  if (!prev) return "";
  var d = Math.round((cur - prev) / prev * 100);
  if (d === 0) return "";
  var up = d > 0;
  return ' <span style="color:' + (up ? "#0f766e" : "#b91c1c") + ';font-weight:700;">' + (up ? "▲" : "▼") + " " + Math.abs(d) + "%</span>";
}

/* ---------- the report HTML (email body; also the magic-link page) ---------- */
function renderReportEmail(env, s, d, asPage) {
  var maxPage = d.pages.reduce(function (m, p) { return Math.max(m, p.views); }, 1);
  var pageRows = d.pages.map(function (p) {
    var w = Math.max(6, Math.round(p.views / maxPage * 100));
    return '<tr><td style="padding:5px 0;">' + esc(prettyPath(p.path)) + '</td>' +
      '<td width="58%"><div style="background:#e2e8f0;border-radius:5px;height:9px;"><div style="background:#0f766e;width:' + w + '%;height:9px;border-radius:5px;"></div></div></td>' +
      '<td align="right" style="color:#64748b;font-weight:700;padding-left:10px;">' + p.views + '</td></tr>';
  }).join("") || '<tr><td colspan="3" style="color:#94a3b8;padding:6px 0;">No page views yet.</td></tr>';
  var refRows = d.refs.map(function (r) {
    return '<tr><td style="padding:3px 0;">' + esc(prettyRef(r.ref)) + '</td><td align="right" style="color:#64748b;font-weight:700;">' + r.views + '</td></tr>';
  }).join("") || '<tr><td style="padding:3px 0;color:#94a3b8;">No data yet</td><td></td></tr>';
  var locRows = d.locations.map(function (l) {
    var nm = esc(l.city) + (l.region ? ", " + esc(l.region) : "");
    return '<tr><td style="padding:3px 0;">' + nm + '</td><td align="right" style="color:#64748b;font-weight:700;">' + l.views + '</td></tr>';
  }).join("") || '<tr><td style="padding:3px 0;color:#94a3b8;">No data yet</td><td></td></tr>';
  var topPage = d.pages.length ? prettyPath(d.pages[0].path) : "your pages";
  var topSrc = d.refs.length ? prettyRef(d.refs[0].ref) : "direct visits";
  var summary = '<strong style="color:#0f766e;">' + d.visitors + (d.visitors === 1 ? " person" : " people") + '</strong> visited ' +
    esc(s.name) + " (" + esc(d.periodLabel) + "). " +
    (d.visitors ? ("Your " + esc(topPage) + " page drew the most views, and most visitors came from " + esc(topSrc) + ".") : "No visits landed in this period yet.");
  var magic = reportBase(env) + "/r/" + s.slug;
  var busiestTxt = d.busiest ? fmtDay(new Date(d.busiest + "T00:00:00Z")) : "—";

  var card =
'<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 34px rgba(15,23,42,.10);">' +
'<tr><td style="background:#0f766e;padding:22px 30px;"><table role="presentation" width="100%"><tr>' +
'<td style="vertical-align:middle;"><div style="color:#fff;font-size:18px;font-weight:700;">Scissortail Reports</div>' +
'<div style="color:#a7f3d0;font-size:11.5px;"><span style="font-family:\'Courier New\',monospace;font-weight:700;color:#5eead4;letter-spacing:-1px;">&lt;/&gt;</span>&nbsp;&nbsp;A McCracken Labs Project</div></td>' +
'<td align="right" style="color:#a7f3d0;font-size:12px;vertical-align:middle;">Traffic report</td></tr></table></td></tr>' +
'<tr><td style="padding:26px 30px 6px;"><div style="color:#0f172a;font-size:23px;font-weight:700;">' + esc(s.name) + '</div>' +
'<div style="color:#64748b;font-size:14px;margin-top:3px;">Website traffic &middot; ' + esc(d.periodLabel) + '</div></td></tr>' +
'<tr><td style="padding:8px 30px 4px;"><div style="background:#f0fdfa;border-left:3px solid #14b8a6;border-radius:8px;padding:14px 16px;color:#334155;font-size:14px;line-height:1.55;">' + summary + '</div></td></tr>' +
'<tr><td style="padding:16px 24px 6px;"><table role="presentation" width="100%"><tr>' +
'<td width="50%" style="padding:6px;"><table width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;"><tr><td style="padding:16px 18px;"><div style="color:#0f766e;font-size:28px;font-weight:800;line-height:1;">' + fmtNum(d.views) + '</div><div style="color:#64748b;font-size:12.5px;margin-top:6px;">Page views' + pctBadge(d.views, d.prevViews) + '</div></td></tr></table></td>' +
'<td width="50%" style="padding:6px;"><table width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;"><tr><td style="padding:16px 18px;"><div style="color:#0f766e;font-size:28px;font-weight:800;line-height:1;">' + fmtNum(d.visitors) + '</div><div style="color:#64748b;font-size:12.5px;margin-top:6px;">Visitors' + pctBadge(d.visitors, d.prevVisitors) + '</div></td></tr></table></td></tr>' +
'<tr><td width="50%" style="padding:6px;"><table width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;"><tr><td style="padding:16px 18px;"><div style="color:#0f172a;font-size:18px;font-weight:800;line-height:1;">' + busiestTxt + '</div><div style="color:#64748b;font-size:12.5px;margin-top:6px;">Busiest day</div></td></tr></table></td>' +
'<td width="50%" style="padding:6px;"><table width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;"><tr><td style="padding:16px 18px;"><div style="color:#0f172a;font-size:18px;font-weight:800;line-height:1;">' + d.pagesSeen + ' pages</div><div style="color:#64748b;font-size:12.5px;margin-top:6px;">Seen this period</div></td></tr></table></td></tr></table></td></tr>' +
'<tr><td style="padding:14px 30px 4px;"><div style="color:#0f172a;font-size:14px;font-weight:700;margin-bottom:10px;">Most-viewed pages</div><table role="presentation" width="100%" style="font-size:13px;color:#334155;">' + pageRows + '</table></td></tr>' +
'<tr><td style="padding:18px 30px 4px;"><table role="presentation" width="100%"><tr>' +
'<td width="52%" style="vertical-align:top;padding-right:12px;"><div style="color:#0f172a;font-size:14px;font-weight:700;margin-bottom:10px;">Where visitors came from</div><table width="100%" style="font-size:13px;color:#334155;">' + refRows + '</table></td>' +
'<td width="48%" style="vertical-align:top;border-left:1px solid #e2e8f0;padding-left:16px;"><div style="color:#0f172a;font-size:14px;font-weight:700;margin-bottom:10px;">Top areas</div><table width="100%" style="font-size:13px;color:#334155;">' + locRows + '</table></td></tr></table></td></tr>' +
(asPage ? '' :
'<tr><td align="center" style="padding:24px 30px 6px;"><a href="' + magic + '" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 26px;border-radius:999px;">View your live numbers &rarr;</a><div style="color:#94a3b8;font-size:11.5px;margin-top:9px;">Your private link, no login needed.</div></td></tr>') +
(asPage ? '<tr><td align="center" style="padding:22px 30px 6px;"><a href="javascript:window.print()" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 24px;border-radius:999px;">Download PDF</a></td></tr>' : '') +
'<tr><td style="padding:20px 30px 26px;"><div style="border-top:1px solid #e2e8f0;padding-top:16px;color:#94a3b8;font-size:11.5px;line-height:1.6;"><span style="font-family:\'Courier New\',monospace;font-weight:700;color:#0f766e;">&lt;/&gt;</span>&nbsp; Scissortail Reports &middot; a McCracken Labs project. No cookies and no personal data are collected, ever.<br>Want this weekly instead, or want to stop? Just reply to this email.</div></td></tr>' +
'</table>';

  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(s.name) + ' — Scissortail Reports</title>' +
    (asPage ? '<style>@media print{a{display:none!important}}body{margin:0}</style>' : '') +
    '</head><body style="margin:0;padding:0;background:#eef2f6;font-family:Arial,Helvetica,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:26px 12px;"><tr><td align="center">' +
    card + '</td></tr></table></body></html>';
}
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
