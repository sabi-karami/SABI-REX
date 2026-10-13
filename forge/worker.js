// SABI-REX Forge · Cloudflare Worker (UI + step API). Tokens are never stored: they ride along with each step call.
import { STEPS, runStep, report, StepError, REGIONS } from "./engine.js";
import PAGE from "./ui.html";

const SEC = { "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'",
  "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "no-store" };
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json; charset=utf-8", ...SEC } });

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function eq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
// brute-force brake on the access code (per IP, per isolate)
const tries = new Map();
async function authed(env, req) {
  const ip = req.headers.get("cf-connecting-ip") || "?", t = tries.get(ip) || { n: 0, at: 0 };
  if (t.n >= 8 && Date.now() - t.at < 10 * 60e3) return "locked";
  const code = req.headers.get("x-forge-code") || "";
  const ok = code && eq(await hmac(env.FORGE_SECRET, code), await hmac(env.FORGE_SECRET, env.FORGE_CODE));
  if (!ok) { tries.set(ip, { n: t.n + 1, at: Date.now() }); await new Promise((r) => setTimeout(r, 700)); return false; }
  tries.delete(ip); return true;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.protocol === "http:") { u.protocol = "https:"; return Response.redirect(u.toString(), 301); }
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html"))
      return new Response(PAGE.replace("__STEPS__", JSON.stringify(STEPS)), { headers: { "content-type": "text/html; charset=utf-8", ...SEC } });
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    if (u.pathname.startsWith("/api/")) {
      const a = await authed(env, req);
      if (a === "locked") return J({ ok: false, error: "تلاش زیاد؛ ۱۰ دقیقه بعد دوباره امتحان کن" }, 429);
      if (!a) return J({ ok: false, error: "کد دسترسی اشتباه است" }, 401);
    }
    if (u.pathname === "/api/ping") return J({ ok: true, regions: REGIONS });
    if (u.pathname === "/api/step" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body.id || body.step, creds = body.creds, state = body.state || {};
      if (!creds || !creds.gh || !creds.cf || !creds.rw) return J({ ok: false, error: "هر سه کلید لازم است" });
      const logs = [];
      try {
        const r = await runStep(id, creds, state, (m) => logs.push(m));
        return J({ ok: true, retry: r && r.retry, msg: r && r.msg, state, logs });
      } catch (e) {
        return J({ ok: false, error: e instanceof StepError ? e.message : "خطای غیرمنتظره: " + ((e && e.message) || e), state, logs });
      }
    }
    if (u.pathname === "/api/report" && req.method === "POST") {
      const { state } = await req.json().catch(() => ({}));
      return new Response(report(state || { cfg: {} }), { headers: { "content-type": "text/plain; charset=utf-8", ...SEC } });
    }
    return new Response("Not found", { status: 404 });
  },
};
