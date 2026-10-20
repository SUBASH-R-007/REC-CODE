/*
 * REC Code service worker — deliberately conservative.
 *
 * What it does:
 *   - Precaches the /offline fallback page (and the stylesheets it links).
 *   - Cache-first for content-hashed static assets (/_next/static/*).
 *   - Network-first for page navigations, answering with /offline only
 *     when the network is unreachable. Navigations are never cached.
 *
 * What it NEVER does:
 *   - Intercept or cache /api/*, /admin, /super, the exam routes
 *     (/assessments/<id>/attempt, /contests/<id>/arena), React Server
 *     Component payloads, prefetches, JSON, or anything that is not a GET.
 *     Lab machines are shared: personal data must never sit in a cache.
 *   - Serve an exam. Navigating to an exam route unregisters this worker,
 *     so a stale cached shell can never stand in front of one.
 *
 * classifyRequest / isExamPath mirror apps/web/src/components/pwa/sw-routes.ts;
 * test/sw-routes.test.ts runs this file in a sandbox and checks they agree.
 */

/* Bump CACHE_VERSION whenever this file's caching behaviour changes. */
var CACHE_VERSION = "v1";
var CACHE_PREFIX = "recx-";
var CACHE_NAME = CACHE_PREFIX + "static-" + CACHE_VERSION;
var OFFLINE_URL = "/offline";
/* Old content-hashed chunks pile up across deployments; keep the newest. */
var MAX_STATIC_ENTRIES = 400;

var SW_BYPASS_PREFIXES = ["/api", "/admin", "/super"];
var EXAM_PATTERNS = [/^\/assessments\/[^/]+\/attempt(?:\/|$)/, /^\/contests\/[^/]+\/arena(?:\/|$)/];

function normalizePath(pathname) {
  var path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch (e) {
    /* Malformed escapes: classify the raw path. */
  }
  return path.toLowerCase().replace(/\/{2,}/g, "/");
}

function isExamPath(pathname) {
  var path = normalizePath(pathname);
  for (var i = 0; i < EXAM_PATTERNS.length; i++) {
    if (EXAM_PATTERNS[i].test(path)) return true;
  }
  return false;
}

function hasPrefix(path, prefix) {
  return path === prefix || path.indexOf(prefix + "/") === 0;
}

/*
 * request: { url, method, mode, header(name) -> string | null }
 * returns "static" | "navigate" | "bypass"
 */
function classifyRequest(request, origin) {
  if (request.method !== "GET") return "bypass";
  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return "bypass";
  }
  if (url.origin !== origin) return "bypass";

  var path = normalizePath(url.pathname);
  for (var i = 0; i < SW_BYPASS_PREFIXES.length; i++) {
    if (hasPrefix(path, SW_BYPASS_PREFIXES[i])) return "bypass";
  }
  if (isExamPath(path)) return "bypass";

  if (path.indexOf("/_next/static/") === 0) return "static";

  if (request.header("rsc") !== null || request.header("next-router-prefetch") !== null) return "bypass";
  if (url.searchParams.has("_rsc")) return "bypass";
  if ((request.header("accept") || "").indexOf("application/json") !== -1) return "bypass";

  if (request.mode === "navigate") return "navigate";
  return "bypass";
}

function describe(request) {
  return {
    url: request.url,
    method: request.method,
    mode: request.mode,
    header: function (name) {
      return request.headers.get(name);
    },
  };
}

/* Stylesheets linked from the offline page, so it renders styled offline. */
function linkedStylesheets(html) {
  var out = [];
  var re = /<link[^>]+href="(\/_next\/static\/[^"]+\.css)"/g;
  var match;
  while ((match = re.exec(html)) !== null) out.push(match[1]);
  return out;
}

async function precacheOffline() {
  var cache = await caches.open(CACHE_NAME);
  var response = await fetch(OFFLINE_URL, { cache: "no-store", credentials: "omit" });
  if (!response.ok) return;
  var html = await response.clone().text();
  await cache.put(OFFLINE_URL, response);
  var sheets = linkedStylesheets(html);
  await Promise.all(
    sheets.map(function (href) {
      return cache.add(href).catch(function () {
        /* Best effort: the page still renders unstyled. */
      });
    }),
  );
}

async function trimCache(cache) {
  var keys = await cache.keys();
  var excess = keys.length - MAX_STATIC_ENTRIES;
  for (var i = 0; i < keys.length && excess > 0; i++) {
    if (new URL(keys[i].url).pathname === OFFLINE_URL) continue;
    await cache.delete(keys[i]);
    excess--;
  }
}

async function cacheFirst(request) {
  var cached = await caches.match(request);
  if (cached) return cached;
  var response = await fetch(request);
  if (response.ok && response.type === "basic") {
    var cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
    trimCache(cache);
  }
  return response;
}

async function networkFirstNavigate(request) {
  try {
    return await fetch(request);
  } catch (error) {
    var fallback = await caches.match(OFFLINE_URL);
    if (fallback) return fallback;
    throw error;
  }
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    precacheOffline().catch(function () {
      /* Offline page unavailable right now; navigations still work online. */
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var route = classifyRequest(describe(request), self.location.origin);

  if (route === "bypass") {
    // An exam is starting in this browser: step aside for good.
    if (request.mode === "navigate" && isExamPath(new URL(request.url).pathname)) {
      event.waitUntil(self.registration.unregister());
    }
    return;
  }
  if (route === "static") {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirstNavigate(request));
});
