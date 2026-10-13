// SABI-REX · CDN Shield worker
// Deploy on Cloudflare Workers, route it to e.g. cdn.example.com/*, then set REX_EXTRA_DOMAINS=cdn.example.com
const ORIGIN = "YOUR-SERVICE.up.railway.app";   // your Railway domain
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/") return new Response("<!doctype html><title>Static</title><h1>It works</h1>", { headers: { "content-type": "text/html" } });
    u.hostname = ORIGIN; u.port = "";
    const h = new Headers(req.headers); h.set("Host", ORIGIN);
    return fetch(new Request(u, { method: req.method, headers: h, body: req.body, redirect: "manual" }));
  }
};
