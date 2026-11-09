const ORIGIN_COOKIE = "proxy_origin";
const MODE_COOKIE = "proxy_mode";
const HOME_PATH = "/_home";
const MODE_PARAM = "_mode";

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Secure`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

const PRIVATE_HOST = /^(localhost|.*\.(localhost|local|internal|netlify\.app)|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?fc[0-9a-f]{2}:.*|\[?fd[0-9a-f]{2}:.*|\[?fe80:.*)$/i;

function isAllowed(hostname) {
  return hostname.includes(".") && !PRIVATE_HOST.test(hostname);
}

function fetchDest(request) {
  return request.headers.get("sec-fetch-dest") || "";
}

function isDocumentRequest(request) {
  if (request.method !== "GET") return false;
  const dest = fetchDest(request);
  if (dest) return dest === "document" || dest === "iframe";
  return (request.headers.get("accept") || "").includes("text/html");
}

function isTopLevelNavigation(request) {
  return request.method === "GET" && fetchDest(request) === "document";
}

function isUserInitiatedNavigation(request) {
  return isTopLevelNavigation(request) && request.headers.get("sec-fetch-site") === "none";
}

function redirect(location, status = 302, extraHeaders = {}) {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders } });
}

// Browsers cache 301/308 permanently; the same proxy path can map to different sites.
function temporaryStatus(status) {
  if (status === 301) return 302;
  if (status === 308) return 307;
  return status;
}

function htmlResponse(html, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status: 200, headers });
}

function clientRedirect(location, extraHeaders) {
  return htmlResponse(`<!DOCTYPE html><meta charset="utf-8"><script>location.replace(${JSON.stringify(location)})</script>`, extraHeaders);
}

function framePage(path, origin) {
  const src = JSON.stringify(path);
  const host = new URL(origin).hostname;
  return htmlResponse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>${host}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#0f172a;padding:2rem;display:flex;flex-direction:column;font-family:ui-sans-serif,system-ui,sans-serif}
header{height:2rem;margin-top:-2rem;display:flex;align-items:center;justify-content:space-between;color:#64748b;font-size:.75rem}
header a{color:#94a3b8;text-decoration:none}
header a:hover{color:#f8fafc}
iframe{flex:1;width:100%;border:1px solid #334155;border-radius:.75rem;background:#fff}
</style>
</head>
<body>
<header><span>${host}</span><a href="${HOME_PATH}">Home</a></header>
<iframe id="f" src=${src} allow="clipboard-read; clipboard-write; fullscreen"></iframe>
<script>
const f=document.getElementById("f");
f.addEventListener("load",()=>{try{const l=f.contentWindow.location;history.replaceState(null,"",l.pathname+l.search+l.hash)}catch(e){}});
</script>
</body>
</html>`);
}

function buildRequestHeaders(request) {
  const headers = new Headers(request.headers);
  for (const h of ["host", "connection", "cookie", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for", "x-nf-request-id", "x-country", "x-language"]) {
    headers.delete(h);
  }
  return headers;
}

function toProxyPath(link, origin) {
  const u = new URL(link, origin);
  if (u.origin === origin) return u.pathname + u.search + u.hash;
  return null;
}

async function proxyTo(targetUrl, request) {
  const method = request.method;
  const response = await fetch(targetUrl, {
    method,
    headers: buildRequestHeaders(request),
    body: ["GET", "HEAD"].includes(method) ? undefined : request.body,
    redirect: "manual",
  });

  const origin = new URL(targetUrl).origin;

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("Location");
    if (location) {
      const mapped = toProxyPath(location, origin) ?? new URL(location, targetUrl).toString();
      return redirect(mapped, temporaryStatus(response.status), { "Set-Cookie": setCookie(ORIGIN_COOKIE, origin) });
    }
  }

  const contentType = response.headers.get("Content-Type") || "";
  let body = response.body;

  if (contentType.includes("text/html")) {
    let html = await response.text();
    html = html.replace(
      /(href|src|action)=["'](https?:\/\/[^"']+)["']/gi,
      (match, attr, link) => {
        const mapped = toProxyPath(link, origin);
        return mapped ? `${attr}="${mapped}"` : match;
      }
    );
    body = html;
  }

  const newHeaders = new Headers(response.headers);
  for (const h of ["content-security-policy", "content-security-policy-report-only", "x-frame-options", "content-encoding", "content-length", "transfer-encoding"]) {
    newHeaders.delete(h);
  }
  if (contentType.includes("text/html")) {
    newHeaders.set("Cache-Control", "no-store");
    newHeaders.delete("Expires");
  }
  newHeaders.append("Set-Cookie", setCookie(ORIGIN_COOKIE, origin));

  return new Response(body, { status: response.status, headers: newHeaders });
}

export default async (request, context) => {
  const url = new URL(request.url);

  try {
    if (url.pathname === "/logo.svg") {
      return context.next();
    }

    if (url.pathname === HOME_PATH) {
      const page = await context.rewrite("/index.html");
      const headers = new Headers(page.headers);
      headers.set("Cache-Control", "no-store");
      headers.append("Set-Cookie", clearCookie(ORIGIN_COOKIE));
      headers.append("Set-Cookie", clearCookie(MODE_COOKIE));
      return new Response(page.body, { status: page.status, headers });
    }

    if (url.pathname.startsWith("/proxy/")) {
      const mode = url.searchParams.get(MODE_PARAM) === "window" ? "window" : "full";
      url.searchParams.delete(MODE_PARAM);

      const path = url.pathname.replace(/^\/proxy\/?/, "") + url.search;
      let targetUrl = decodeURIComponent(path);
      if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;
      targetUrl = targetUrl.replace(/^(https?:)\/+/, "$1//");

      const target = new URL(targetUrl);
      if (!/^https?:$/.test(target.protocol) || !isAllowed(target.hostname)) {
        return new Response("This host is not allowed", { status: 403 });
      }

      if (isDocumentRequest(request)) {
        const headers = new Headers();
        headers.append("Set-Cookie", setCookie(ORIGIN_COOKIE, target.origin));
        headers.append("Set-Cookie", setCookie(MODE_COOKIE, mode));
        return clientRedirect(target.pathname + target.search + target.hash, headers);
      }
      return await proxyTo(targetUrl, request);
    }

    const isHome = url.pathname === "/" || url.pathname === "/index.html";
    if (isHome && isUserInitiatedNavigation(request)) {
      return context.next();
    }

    const origin = getCookie(request, ORIGIN_COOKIE);
    if (origin && isAllowed(new URL(origin).hostname)) {
      if (getCookie(request, MODE_COOKIE) === "window" && isTopLevelNavigation(request)) {
        return framePage(url.pathname + url.search + url.hash, origin);
      }
      return await proxyTo(origin + url.pathname + url.search, request);
    }

    if (isHome) {
      return context.next();
    }
    return redirect(HOME_PATH);
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};
