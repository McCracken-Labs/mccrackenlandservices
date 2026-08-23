/*!
 * Scissortail — a quiet, cookie-free page counter.
 * Add to any page:
 *   <script defer src="https://.../count.js"
 *           data-endpoint="https://YOUR-WORKER.workers.dev"
 *           data-site="mysite"></script>
 * No cookies. No personal data stored. Honors Do Not Track.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var endpoint = (script.getAttribute("data-endpoint") || "").replace(/\/+$/, "");
  var site = script.getAttribute("data-site") || location.host;
  if (!endpoint) return; // nothing configured yet, do nothing

  // Manual opt-out for the site owner's own browsers.
  // Visit any page with ?scissortail=off to stop counting this browser; ?scissortail=on to resume.
  try {
    var opt = /[?&]scissortail=(off|on)\b/i.exec(location.search);
    if (opt) {
      if (opt[1].toLowerCase() === "off") localStorage.setItem("scissortail-optout", "1");
      else localStorage.removeItem("scissortail-optout");
    }
    if (localStorage.getItem("scissortail-optout") === "1") return;
  } catch (e) { /* localStorage unavailable; ignore */ }

  // Respect Do Not Track and Global Privacy Control.
  var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
  if (dnt === "1" || dnt === "yes" || navigator.globalPrivacyControl === true) return;

  // Skip local previews and obvious bots.
  if (/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(location.hostname)) return;
  if (/bot|crawl|spider|preview|lighthouse|headless/i.test(navigator.userAgent)) return;

  function refHost() {
    try {
      if (!document.referrer) return "";
      var u = new URL(document.referrer);
      if (u.host === location.host) return ""; // internal navigation
      return u.host;
    } catch (e) { return ""; }
  }

  // Send a hit. Optional pathOverride lets us record a file download under its own path.
  function send(pathOverride) {
    try {
      var data = {
        site: site,
        p: pathOverride || location.pathname || "/",
        r: refHost(),
        s: (screen.width || 0) + "x" + (screen.height || 0)
      };
      var body = JSON.stringify(data);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint + "/count", body);
      } else {
        var img = new Image();
        img.src = endpoint + "/count?d=" + encodeURIComponent(body) + "&_=" + Date.now();
      }
    } catch (e) { /* never break the host page */ }
  }

  // Count the first view.
  if (document.visibilityState !== "prerender") send();

  // Count downloads. Clicking a file (a PDF, EPUB, doc, etc.) navigates the browser
  // straight to the file, so this page's counter never runs for it. Record it here,
  // under the file's own path, so downloads show up in the dashboard's page list.
  var DL_RE = /\.(pdf|epub|docx?|xlsx?|pptx?|csv|zip|rtf|txt)$/i;
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var u;
    try { u = new URL(a.href, location.href); } catch (x) { return; }
    // Only files: a link to a downloadable document, or one marked with the download attribute.
    if (!DL_RE.test(u.pathname) && !a.hasAttribute("download")) return;
    send(u.pathname || "/");
  }, true);

  // Count client-side route changes (single-page apps).
  var last = location.pathname;
  function onNav() {
    if (location.pathname !== last) { last = location.pathname; send(); }
  }
  var push = history.pushState;
  if (push) {
    history.pushState = function () { push.apply(this, arguments); onNav(); };
    window.addEventListener("popstate", onNav);
  }
})();
