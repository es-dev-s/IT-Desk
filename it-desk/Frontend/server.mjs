/* ---------------------------------------------------------------------------
 * IT-Desk web server (LAN-ready).
 *
 * Serves the Next.js app on HOST:PORT (default 0.0.0.0:3000, so other PCs on
 * the LAN can open it) and proxies /api/* — including the SSE stream at
 * /api/v1/events — to the Go API, which stays bound to localhost. The browser
 * therefore only ever talks to one origin: no CORS, cookies are first-party,
 * and the API port never has to be exposed.
 *
 *   node server.mjs --dev   development (Turbopack, HMR)
 *   node server.mjs         production (run `next build` first)
 *
 * Env: HOST, PORT, API_INTERNAL_URL (default http://127.0.0.1:8080).
 * ------------------------------------------------------------------------- */
import http from "node:http";
import os from "node:os";
import next from "next";

const dev = process.argv.includes("--dev");
process.env.NODE_ENV ??= dev ? "development" : "production";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const API = new URL(process.env.API_INTERNAL_URL || "http://127.0.0.1:8080");

// Hop-by-hop headers are never forwarded (RFC 9110 §7.6.1).
const HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade",
  "te", "trailer", "proxy-authorization", "proxy-authenticate",
]);

const peerIP = (req) => (req.socket.remoteAddress || "").replace(/^::ffff:/, "");

/** Stream one request to the API and its response back, unbuffered (SSE-safe). */
function proxyToApi(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // Client-supplied X-Forwarded-* is dropped: only this server may set them,
    // so rate limiting / lockout always see the real peer address.
    if (!HOP.has(k) && !k.startsWith("x-forwarded-") && k !== "forwarded") headers[k] = v;
  }
  headers["x-forwarded-for"] = peerIP(req);
  headers["x-forwarded-proto"] = req.socket.encrypted ? "https" : "http";
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;

  const upstream = http.request(
    { protocol: API.protocol, hostname: API.hostname, port: API.port || 80, method: req.method, path: req.url, headers },
    (ur) => {
      const out = { ...ur.headers };
      for (const k of HOP) delete out[k];
      res.writeHead(ur.statusCode ?? 502, out);
      res.flushHeaders();
      ur.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: { code: "api_unreachable", message: "The IT-Desk API is not reachable." } }));
  });
  res.on("close", () => upstream.destroy()); // client went away (e.g. closed tab mid-SSE)
  req.pipe(upstream);
}

/** Non-virtual IPv4 addresses of this machine (what another PC would use). */
export function lanAddresses() {
  const skip = /^(lo|docker|br-|virbr|veth|vmnet|vboxnet|cni|flannel|cali|podman|kube)/;
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !skip.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

const app = next({ dev, hostname: "localhost", port: PORT, ...(dev ? { turbopack: true } : {}) });
const handle = app.getRequestHandler();

await app.prepare();
const upgrade = app.getUpgradeHandler();

const server = http.createServer((req, res) => {
  if (req.url === "/api" || req.url?.startsWith("/api/")) return proxyToApi(req, res);
  req.headers["x-forwarded-for"] = peerIP(req);
  handle(req, res);
});
server.on("upgrade", (req, socket, head) => upgrade(req, socket, head));

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}`, ...(HOST === "0.0.0.0" ? lanAddresses().map((ip) => `http://${ip}:${PORT}`) : [])];
  console.log(`IT-Desk web (${dev ? "dev" : "production"}) listening on ${HOST}:${PORT}; API → ${API.origin}`);
  for (const u of urls) console.log(`  ${u}`);
});
