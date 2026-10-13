// SABI-REX Forge engine: one step per call, so no request runs long (fits the Workers free plan).
// creds = { gh, cf, rw } tokens (used, never stored); state = everything created so far (kept in the browser).
export const SOURCE_REPO = "sabi-karami/SABI-REX";
export const CORE_IMAGE = "gozargah/marzban:latest";
export const REGIONS = {
  ams: { id: "europe-west4-drams3a", name: "🇳🇱 Amsterdam" },
  sgp: { id: "asia-southeast1-eqsg3a", name: "🇸🇬 Singapore" },
  iad: { id: "us-east4-eqdc4a", name: "🇺🇸 Virginia" },
  cal: { id: "us-west2", name: "🇺🇸 California" },
};
export const STEPS = [
  { id: "verify", title: "بررسی کلیدها و دسترسی‌ها", icon: "🔑" },
  { id: "github", title: "ساخت مخزن GitHub", icon: "🐙" },
  { id: "github_wait", title: "آماده شدن کد", icon: "📦", repeat: 40 },
  { id: "rw_project", title: "پروژه و سرویس Railway", icon: "🚂" },
  { id: "rw_setup", title: "حافظه، منطقه، دامنه و پورت TCP", icon: "🧱" },
  { id: "cf_dns", title: "اتصال دامنه در Cloudflare", icon: "🌐" },
  { id: "cf_cdn", title: "ورکر CDN ضدفیلتر", icon: "☁️" },
  { id: "rw_vars", title: "متغیرها و رمزهای پنل", icon: "🧬" },
  { id: "rw_deploy", title: "شروع استقرار", icon: "🚀" },
  { id: "rw_wait", title: "ساخت و اجرای پنل (۳ تا ۶ دقیقه)", icon: "⏳", repeat: 120 },
  { id: "domain_wait", title: "گواهی SSL و بالا آمدن دامنه", icon: "🔒", repeat: 90 },
  { id: "panel_user", title: "کاربر تست و اشتراک", icon: "👤", repeat: 30 },
  { id: "checks", title: "تست نهایی مسیرها", icon: "🧪" },
];

const UA = "SABI-REX-Forge";
const RW = "https://backboard.railway.app/graphql/v2";
const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";
export class StepError extends Error {}
const fail = (m) => { throw new StepError(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function rand(n, abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return Array.from(b, (x) => abc[x % abc.length]).join("");
}
const lower = "abcdefghijkmnpqrstuvwxyz23456789";
const auth = (t) => (t && t !== "__injected__" ? { Authorization: "Bearer " + t } : {});

async function gh(c, method, path, body) {
  const r = await fetch(GH + path, { method, headers: { ...auth(c.gh), "User-Agent": UA, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { ok: r.ok, status: r.status, j, h: r.headers };
}
async function cf(c, method, path, body, raw) {
  const r = await fetch(CF + path, { method, headers: { ...auth(c.cf), ...(body && !raw ? { "Content-Type": "application/json" } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.success !== false, status: r.status, j, err: (j.errors || []).map((e) => e.message).join("; ") || ("HTTP " + r.status) };
}
async function rw(c, query, variables = {}, soft) {
  const r = await fetch(RW, { method: "POST", headers: { ...auth(c.rw), "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  const err = j.errors && j.errors.length ? j.errors.map((e) => e.message).join("; ") : (!r.ok ? "HTTP " + r.status : "");
  if (err) { if (soft) return { __err: err }; fail("Railway: " + err); }
  return j.data;
}

const S = {};

// 1 ─ check all three keys + pick names
S.verify = async (c, s, log) => {
  const cfg = s.cfg;
  cfg.domain = (cfg.domain || "").trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(cfg.domain)) fail("دامنه‌ی پنل درست نیست (مثال: panel.example.com)");
  const u = await gh(c, "GET", "/user");
  if (!u.ok) fail("توکن GitHub کار نمی‌کند (" + u.status + ")");
  s.gh = { login: u.j.login, scopes: u.h.get("x-oauth-scopes") || "fine-grained" };
  log(`GitHub ✓ ${u.j.login}`);

  const parts = cfg.domain.split(".");
  let zone = null, zerr = "";
  for (let i = 1; i < parts.length - 1 && !zone; i++) {
    const z = await cf(c, "GET", "/zones?name=" + parts.slice(i).join("."));
    if (z.ok && z.j.result && z.j.result.length) zone = z.j.result[0]; else zerr = z.err;
  }
  if (!zone) fail(`دامنه‌ی اصلی ${parts.slice(1).join(".")} در این حساب Cloudflare پیدا نشد. ${zerr && zerr !== "HTTP 200" ? "(" + zerr + ")" : ""}`);
  s.cf = { zone: zone.id, zoneName: zone.name, account: zone.account.id };
  const ex = await cf(c, "GET", `/zones/${zone.id}/dns_records?name=${cfg.domain}`);
  if (!ex.ok) fail("توکن Cloudflare اجازه‌ی DNS ندارد (Zone → DNS → Edit): " + ex.err);
  const used = (ex.j.result || []).filter((r) => !(r.type === "CNAME" && /\.railway\.app$/.test(r.content)));
  if (used.length) fail(`${cfg.domain} قبلاً استفاده شده (${used[0].type} → ${used[0].content}). ساب‌دامین دیگری بنویس.`);
  const sc = await cf(c, "GET", `/accounts/${zone.account.id}/workers/scripts`);
  if (!sc.ok) fail("توکن Cloudflare اجازه‌ی Workers ندارد (Account → Workers Scripts → Edit): " + sc.err);
  const sub = await cf(c, "GET", `/accounts/${zone.account.id}/workers/subdomain`);
  s.cf.workersSub = sub.ok ? (sub.j.result && sub.j.result.subdomain) || "" : "";
  log(`Cloudflare ✓ ${zone.name}` + (s.cf.workersSub ? ` · workers.dev: ${s.cf.workersSub}` : ""));

  const me = await rw(c, "{ me { email workspaces { id name } } }");
  const ws = (me.me && me.me.workspaces) || [];
  if (!ws.length) fail("حساب Railway هیچ workspace ندارد");
  s.rw = { workspace: ws[0].id, email: me.me.email };
  log(`Railway ✓ ${me.me.email}`);

  cfg.slug = parts[0].replace(/[^a-z0-9-]/g, "").slice(0, 20) || "rex";
  const pre = ["static", "img", "media", "assets", "files", "cdn-st"][Math.floor(Math.random() * 6)];
  cfg.cdnHost = cfg.cdnHost || `${pre}-${rand(5, lower)}.${zone.name}`;
  cfg.worker = cfg.worker || `${pre}-${rand(6, lower)}`;
  cfg.repo = (cfg.repo || "SABI-REX").replace(/[^A-Za-z0-9._-]/g, "-");
  cfg.key = cfg.key || rand(28);
  cfg.password = cfg.password || rand(18);
  cfg.testUser = (cfg.testUser || "sabi").toLowerCase().replace(/[^a-z0-9_]/g, "") || "sabi";
  cfg.testGB = Math.max(1, Math.min(10000, +cfg.testGB || 200));
  cfg.region = REGIONS[cfg.regionKey] ? cfg.regionKey : "ams";
};

// 2 ─ GitHub repo from the SABI-REX template (or reuse one with the same name)
S.github = async (c, s, log) => {
  const { login } = s.gh, name = s.cfg.repo;
  const ex = await gh(c, "GET", `/repos/${login}/${name}`);
  if (ex.ok) {
    Object.assign(s.gh, { repo: ex.j.full_name, private: ex.j.private, reused: true });
    return log(`مخزن ${ex.j.full_name} از قبل هست؛ همان استفاده شد`);
  }
  let r = await gh(c, "POST", `/repos/${SOURCE_REPO}/generate`, { owner: login, name, private: !!s.cfg.private, description: "SABI-REX panel", include_all_branches: false });
  if (!r.ok) {
    log(`ساخت از قالب نشد (${r.status})، فورک می‌کنم…`);
    r = await gh(c, "POST", `/repos/${SOURCE_REPO}/forks`, { name, default_branch_only: true });
    if (!r.ok) fail("ساخت مخزن نشد: " + ((r.j && r.j.message) || r.status) + " (اجازه‌ی repo لازم است)");
  }
  Object.assign(s.gh, { repo: r.j.full_name, private: r.j.private });
  log(`مخزن ${r.j.full_name} ساخته شد (${r.j.private ? "خصوصی" : "عمومی"})`);
};
S.github_wait = async (c, s, log) => {
  const r = await gh(c, "GET", `/repos/${s.gh.repo}/commits/main`);
  if (!r.ok) return { retry: 3000, msg: "GitHub در حال کپی کد…" };
  const t = await gh(c, "GET", `/repos/${s.gh.repo}/contents/Dockerfile`);
  if (!t.ok) return { retry: 3000, msg: "منتظر فایل‌ها…" };
  s.gh.commit = r.j.sha;
  log(`کد آماده است · ${r.j.sha.slice(0, 7)}`);
};

// 3 ─ Railway project + empty service (source is connected after the variables are in)
S.rw_project = async (c, s, log) => {
  if (!s.rw.project) {
    const d = await rw(c, "mutation($i:ProjectCreateInput!){projectCreate(input:$i){id environments{edges{node{id name}}}}}",
      { i: { name: "SABI-REX " + s.cfg.slug, workspaceId: s.rw.workspace } });
    s.rw.project = d.projectCreate.id;
    const envs = d.projectCreate.environments.edges.map((e) => e.node);
    s.rw.env = (envs.find((e) => e.name === "production") || envs[0]).id;
    log("پروژه‌ی Railway ساخته شد");
  }
  if (!s.rw.service) {
    const d = await rw(c, "mutation($i:ServiceCreateInput!){serviceCreate(input:$i){id}}", { i: { projectId: s.rw.project, name: "sabirex" } });
    s.rw.service = d.serviceCreate.id;
    log("سرویس sabirex ساخته شد");
  }
};

// 4 ─ volume, region, healthcheck, domains, TCP proxy
S.rw_setup = async (c, s, log) => {
  const { project: P, env: E, service: Sv } = s.rw;
  if (!s.rw.volume) {
    const v = await rw(c, "mutation($i:VolumeCreateInput!){volumeCreate(input:$i){id name}}", { i: { projectId: P, serviceId: Sv, environmentId: E, mountPath: "/var/lib/sabirex" } });
    s.rw.volume = v.volumeCreate.id; log("حافظه‌ی دائمی وصل شد (/var/lib/sabirex)");
  }
  const reg = REGIONS[s.cfg.region].id;
  await rw(c, "mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}",
    { s: Sv, e: E, i: { multiRegionConfig: { [reg]: { numReplicas: 1 } }, sleepApplication: false, healthcheckPath: "/health", healthcheckTimeout: 300, restartPolicyType: "ALWAYS" } });
  log(`منطقه ${REGIONS[s.cfg.region].name} · healthcheck · ری‌استارت خودکار`);
  if (!s.rw.domain) {
    const d = await rw(c, "mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}", { i: { serviceId: Sv, environmentId: E, targetPort: 8080 } });
    s.rw.domain = d.serviceDomainCreate.domain; log("دامنه‌ی Railway: " + s.rw.domain);
  }
  if (!s.rw.cname) {
    const d = await rw(c, "mutation($i:CustomDomainCreateInput!){customDomainCreate(input:$i){id status{verificationDnsHost verificationToken dnsRecords{hostlabel recordType requiredValue}}}}",
      { i: { domain: s.cfg.domain, projectId: P, serviceId: Sv, environmentId: E, targetPort: 8080 } });
    const st = d.customDomainCreate.status || {};
    const rec = (st.dnsRecords || []).find((x) => /CNAME/.test(x.recordType)) || (st.dnsRecords || [])[0];
    if (!rec) fail("Railway مقدار CNAME را برنگرداند");
    s.rw.cname = rec.requiredValue; s.rw.verifyHost = st.verificationDnsHost || ""; s.rw.verifyToken = st.verificationToken || "";
    log(`دامنه‌ی ${s.cfg.domain} در Railway ثبت شد`);
  }
  if (!s.rw.tcp && s.cfg.ss !== false) {
    const t = await rw(c, "mutation($i:TCPProxyCreateInput!){tcpProxyCreate(input:$i){id domain proxyPort}}", { i: { serviceId: Sv, environmentId: E, applicationPort: 2010 } }, true);
    if (t.__err) log("⚠️ پورت TCP ساخته نشد (Shadowsocks خاموش می‌ماند): " + t.__err);
    else { s.rw.tcp = { domain: t.tcpProxyCreate.domain.replace(/\.$/, ""), port: t.tcpProxyCreate.proxyPort }; log(`پورت TCP برای Shadowsocks: ${s.rw.tcp.domain}:${s.rw.tcp.port}`); }
  }
};

// 5 ─ Cloudflare DNS for the panel (DNS only, Railway issues the SSL)
S.cf_dns = async (c, s, log) => {
  const Z = s.cf.zone, name = s.cfg.domain;
  const ex = await cf(c, "GET", `/zones/${Z}/dns_records?name=${name}`);
  const cur = (ex.j.result || []).find((r) => r.type === "CNAME");
  const body = { type: "CNAME", name, content: s.rw.cname, proxied: false, ttl: 1, comment: "SABI-REX panel (Railway)" };
  const r = cur ? await cf(c, "PUT", `/zones/${Z}/dns_records/${cur.id}`, body) : await cf(c, "POST", `/zones/${Z}/dns_records`, body);
  if (!r.ok) fail("ساخت رکورد DNS نشد: " + r.err);
  s.cf.panelRecord = r.j.result.id;
  log(`CNAME ${name} → ${s.rw.cname}`);
  if (s.rw.verifyHost && s.rw.verifyToken) {
    const host = s.rw.verifyHost.endsWith(s.cf.zoneName) ? s.rw.verifyHost : `${s.rw.verifyHost}.${s.cf.zoneName}`;
    const t = await cf(c, "POST", `/zones/${Z}/dns_records`, { type: "TXT", name: host, content: s.rw.verifyToken, ttl: 1 });
    if (t.ok) { s.cf.verifyRecord = t.j.result.id; log("رکورد TXT تأیید Railway ساخته شد"); }
  }
};

// 6 ─ CDN worker: Cloudflare edge in front of Railway, on a random-looking subdomain + workers.dev
export function cdnWorker(origin) {
  return `// static assets proxy
const ORIGIN = ${JSON.stringify(origin)};
const PAGE = "<!doctype html><html><head><meta charset=utf-8><title>Static</title></head><body style='font-family:sans-serif;color:#555'><h3>Static content server</h3><p>OK</p></body></html>";
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/" || u.pathname === "/favicon.ico") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" } });
    u.hostname = ORIGIN; u.port = ""; u.protocol = "https:";
    const h = new Headers(req.headers); h.set("Host", ORIGIN);
    return fetch(new Request(u, { method: req.method, headers: h, body: req.body, redirect: "manual" }));
  }
};`;
}
S.cf_cdn = async (c, s, log) => {
  const { account: A, zone: Z } = s.cf, W = s.cfg.worker, host = s.cfg.cdnHost;
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify({ main_module: "w.js", compatibility_date: "2025-01-01" })], { type: "application/json" }));
  fd.append("w.js", new Blob([cdnWorker(s.rw.domain)], { type: "application/javascript+module" }), "w.js");
  const up = await cf(c, "PUT", `/accounts/${A}/workers/scripts/${W}`, fd, true);
  if (!up.ok) fail("آپلود ورکر CDN نشد: " + up.err);
  log(`ورکر ${W} آپلود شد`);
  const ex = await cf(c, "GET", `/zones/${Z}/dns_records?name=${host}`);
  if (!(ex.j.result || []).length) {
    const d = await cf(c, "POST", `/zones/${Z}/dns_records`, { type: "AAAA", name: host, content: "100::", proxied: true, ttl: 1, comment: "SABI-REX CDN" });
    if (!d.ok) fail("DNS ورکر ساخته نشد: " + d.err);
    s.cf.cdnRecord = d.j.result.id;
  }
  const rt = await cf(c, "POST", `/zones/${Z}/workers/routes`, { pattern: `${host}/*`, script: W });
  if (!rt.ok && !/already|duplicate/i.test(rt.err)) fail("مسیر ورکر ساخته نشد (Zone → Workers Routes → Edit): " + rt.err);
  if (rt.ok) s.cf.route = rt.j.result.id;
  log(`CDN Shield: ${host}`);
  s.cfg.mirrors = [host];
  if (s.cf.workersSub) {
    const e = await cf(c, "POST", `/accounts/${A}/workers/scripts/${W}/subdomain`, { enabled: true, previews_enabled: false });
    if (e.ok) { const wd = `${W}.${s.cf.workersSub}.workers.dev`; s.cfg.mirrors.push(wd); log(`Worker Gate: ${wd}`); }
    else log("⚠️ workers.dev روشن نشد: " + e.err);
  }
  const wsS = await cf(c, "GET", `/zones/${Z}/settings/websockets`);
  if (wsS.ok && wsS.j.result.value !== "on") { await cf(c, "PATCH", `/zones/${Z}/settings/websockets`, { value: "on" }); log("WebSocket در Cloudflare روشن شد"); }
};

// 7 ─ panel variables
S.rw_vars = async (c, s, log) => {
  const cfg = s.cfg;
  const vars = {
    PORT: "8080", CORE_IMAGE, PANEL_DOMAIN: cfg.domain, REX_PANEL_KEY: cfg.key, REX_INIT_PASSWORD: cfg.password,
    REX_REALITY: "0", REX_SS: s.rw.tcp ? "1" : "0", REX_EXTRA_DOMAINS: (cfg.mirrors || []).join(","), REX_ALT_DOMAINS: s.rw.domain,
    REX_REGION: REGIONS[cfg.region].id,
  };
  await rw(c, "mutation($i:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$i)}",
    { i: { projectId: s.rw.project, environmentId: s.rw.env, serviceId: s.rw.service, skipDeploys: true, variables: vars } });
  s.rw.vars = Object.keys(vars);
  log(`${Object.keys(vars).length} متغیر تنظیم شد (کلید ورود و رمز تصادفی)`);
};

// 8 ─ connect the repo. Connecting starts a deploy by itself, so we adopt it (a 2nd deploy would race it for the volume)
async function latestDeploy(c, s) {
  const d = await rw(c, "query($p:String!,$s:String!){deployments(first:3,input:{projectId:$p,serviceId:$s}){edges{node{id status createdAt}}}}", { p: s.rw.project, s: s.rw.service });
  return d.deployments.edges.map((x) => x.node);
}
S.rw_deploy = async (c, s, log) => {
  const { service: Sv, env: E } = s.rw;
  if (!s.rw.connected) {
    try { await rw(c, "mutation($id:String!,$i:ServiceConnectInput!){serviceConnect(id:$id,input:$i){id}}", { id: Sv, i: { repo: s.gh.repo, branch: "main" } }); }
    catch (e) { fail(String(e.message || e) + " — حساب GitHub باید در Railway وصل باشد (railway.com/account → GitHub)" + (s.gh.private ? "؛ مخزن خصوصی است: به Railway اجازه‌ی این مخزن را بده یا مخزن عمومی بساز" : "")); }
    s.rw.connected = true; s.rw.deployStart = Date.now(); log(`Railway به ${s.gh.repo} وصل شد`);
  }
  for (let k = 0; k < 6; k++) {
    const list = await latestDeploy(c, s);
    if (list.length) { s.rw.deploy = list[0].id; return log("استقرار خودکار شروع شد · " + s.gh.commit.slice(0, 7)); }
    await sleep(2500);
  }
  const d = await rw(c, "mutation($s:String!,$e:String!,$c:String!){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}", { s: Sv, e: E, c: s.gh.commit });
  s.rw.deploy = d.serviceInstanceDeployV2; log("استقرار شروع شد · " + s.gh.commit.slice(0, 7));
};
S.rw_wait = async (c, s, log) => {
  const list = await latestDeploy(c, s);
  const cur = list.find((x) => x.id === s.rw.deploy) || list[0];
  if (list[0] && list[0].id !== s.rw.deploy && !["FAILED", "CRASHED", "REMOVED"].includes(list[0].status)) s.rw.deploy = list[0].id;
  const st = (list.find((x) => x.id === s.rw.deploy) || cur).status, sec = Math.round((Date.now() - (s.rw.deployStart || Date.now())) / 1000);
  if (st === "SUCCESS") return log(`پنل بالا آمد (${sec} ثانیه)`);
  if (["FAILED", "CRASHED"].includes(st)) {
    const ev = await rw(c, "query($d:String!){deploymentEvents(id:$d,first:30){edges{node{step payload{error}}}}}", { d: s.rw.deploy }, true);
    const why = ev && ev.deploymentEvents ? ev.deploymentEvents.edges.map((x) => x.node.payload && x.node.payload.error).filter(Boolean).join(" | ") : "";
    const busy = list.some((x) => ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"].includes(x.status));
    s.rw.redeploys = (s.rw.redeploys || 0) + 1;
    if (s.rw.redeploys <= 3 && (busy || /volume|another deployment|timed out|healthcheck/i.test(why) || !why)) {
      if (busy) return { retry: 8000, msg: "یک استقرار دیگر در جریان است، منتظرم…" };
      const d = await rw(c, "mutation($s:String!,$e:String!,$c:String!){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}", { s: s.rw.service, e: s.rw.env, c: s.gh.commit });
      s.rw.deploy = d.serviceInstanceDeployV2; log(`⚠️ استقرار ناموفق (${(why || st).slice(0, 120)}) → تلاش دوباره ${s.rw.redeploys}/3`);
      return { retry: 8000, msg: "استقرار دوباره…" };
    }
    const l = await rw(c, "query($d:String!){deploymentLogs(deploymentId:$d,limit:40){message}}", { d: s.rw.deploy }, true);
    const tail = l && l.deploymentLogs ? l.deploymentLogs.slice(-5).map((x) => x.message).join(" | ") : "";
    fail(`استقرار ${st} شد. ${why} ${tail}`.slice(0, 700));
  }
  return { retry: 6000, msg: `${st === "BUILDING" ? "ساخت ایمیج" : st === "DEPLOYING" ? "اجرای پنل" : st} · ${sec} ثانیه` };
};

// 9 ─ SSL on the custom domain
S.domain_wait = async (c, s, log) => {
  const d = await rw(c, "query($p:String!,$s:String!,$e:String!){domains(projectId:$p,serviceId:$s,environmentId:$e){customDomains{domain status{certificateStatus}}}}",
    { p: s.rw.project, s: s.rw.service, e: s.rw.env });
  const cd = (d.domains.customDomains || []).find((x) => x.domain === s.cfg.domain);
  const cert = (cd && cd.status && cd.status.certificateStatus) || "?";
  let health = 0;
  try { health = (await fetch(`https://${s.cfg.domain}/health`, { redirect: "manual" })).status; } catch {}
  if (health === 200) { s.panel = { base: `https://${s.cfg.domain}` }; return log(`https://${s.cfg.domain} آماده است (SSL ✓)`); }
  s.domainTries = (s.domainTries || 0) + 1;
  if (s.domainTries > 80) {
    s.panel = { base: `https://${s.rw.domain}`, sslPending: true };
    return log("⚠️ SSL دامنه هنوز صادر نشده (معمولاً تا ۳۰ دقیقه خودش درست می‌شود). فعلاً از دامنه‌ی Railway ادامه می‌دهم.");
  }
  return { retry: 7000, msg: `گواهی: ${cert.replace("CERTIFICATE_STATUS_TYPE_", "")} · health ${health || "—"}` };
};

// 10 ─ login + test user + subscription
async function panelLogin(s) {
  const B = s.panel.base;
  const e = await fetch(`${B}/${s.cfg.key}`, { redirect: "manual" });
  const ck = (e.headers.get("set-cookie") || "").match(/rx_k=[^;]+/);
  const cookie = ck ? ck[0] : `rx_k=${s.cfg.key}`;
  const t = await fetch(`${B}/api/admin/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: `username=admin&password=${encodeURIComponent(s.cfg.password)}` });
  if (!t.ok) return null;
  return { B, h: { Authorization: "Bearer " + (await t.json()).access_token, Cookie: cookie, "Content-Type": "application/json" } };
}
function b64d(t) { t = t.trim().replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; const bin = atob(t); return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))); }
export function linkName(l) {
  try {
    if (l.startsWith("vmess://")) return JSON.parse(b64d(l.slice(8))).ps;
    return decodeURIComponent(l.split("#").pop());
  } catch { return l.slice(0, 30); }
}
S.panel_user = async (c, s, log) => {
  const p = await panelLogin(s);
  if (!p) return { retry: 6000, msg: "پنل هنوز در حال آماده‌سازی ورود است…" };
  const ib = await (await fetch(`${p.B}/api/inbounds`, { headers: p.h })).json();
  const inbounds = {}; for (const k in ib) inbounds[k] = ib[k].map((x) => x.tag);
  const proxies = { vless: {}, vmess: {}, trojan: {} };
  if (inbounds.shadowsocks && inbounds.shadowsocks.length) proxies.shadowsocks = { method: "chacha20-ietf-poly1305" };
  const U = s.cfg.testUser;
  let r = await fetch(`${p.B}/api/user`, { method: "POST", headers: p.h, body: JSON.stringify({ username: U, proxies, inbounds, data_limit: s.cfg.testGB * 1073741824, expire: 0, note: "SABI-REX Forge test user" }) });
  if (r.status === 409) r = await fetch(`${p.B}/api/user/${U}`, { method: "PUT", headers: p.h, body: JSON.stringify({ proxies, inbounds, data_limit: s.cfg.testGB * 1073741824 }) });
  if (!r.ok) return { retry: 6000, msg: "ساخت کاربر: " + r.status };
  const u = await r.json();
  const sub = u.subscription_url.startsWith("http") ? u.subscription_url : p.B + u.subscription_url;
  const txt = await (await fetch(sub, { headers: { "User-Agent": "v2rayNG/1.8.5" } })).text();
  let links = []; try { links = b64d(txt).split("\n").filter(Boolean); } catch {}
  s.panel.inbounds = Object.values(inbounds).flat();
  s.panel.sub = sub.replace(p.B, `https://${s.cfg.domain}`);
  s.panel.links = links;
  s.subTries = (s.subTries || 0) + 1;
  // the host guard fills in every route within ~20-40s after the first start
  if (links.length < 30 && s.subTries < 12) return { retry: 8000, msg: `محافظ مسیرها در حال چیدن کانفیگ‌ها… (${links.length})` };
  log(`کاربر ${U} · ${s.cfg.testGB} گیگ · ${links.length} کانفیگ`);
};

// 11 ─ HTTP checks on every route (the real proxy test runs inside the apps)
S.checks = async (c, s, log) => {
  const res = [];
  const add = (name, ok, info) => { res.push({ name, ok, info }); log(`${ok ? "✅" : "⚠️"} ${name}${info ? " · " + info : ""}`); };
  const t0 = Date.now();
  let r = await fetch(`https://${s.cfg.domain}/health`).catch(() => null); add("سلامت پنل", r && r.status === 200, r ? `${r.status} · ${Date.now() - t0}ms` : "خطا");
  r = await fetch(`https://${s.cfg.domain}/`).catch(() => null); add("صفحه‌ی پوششی (بدون کلید)", r && r.status !== 0, r ? r.status + "" : "");
  r = await fetch(`https://${s.cfg.domain}/${s.cfg.key}`, { redirect: "manual" }).catch(() => null); add("ورود مخفی", r && r.status < 400, r ? r.status + "" : "");
  r = await fetch(s.panel.sub, { headers: { "User-Agent": "Mozilla/5.0" } }).catch(() => null); add("صفحه‌ی اشتراک", r && r.ok, r ? r.status + "" : "");
  for (const m of s.cfg.mirrors || []) {
    r = await fetch(`https://${m}/`).catch(() => null); add(`CDN ${m}`, r && r.ok, r ? r.status + "" : "خطا (DNS ممکن است چند دقیقه طول بکشد)");
  }
  r = await fetch(`https://${s.rw.domain}/health`).catch(() => null); add("Railway Gate", r && r.status === 200, r ? r.status + "" : "");
  const kinds = {};
  for (const l of s.panel.links || []) { const n = linkName(l).split("·").pop().trim(); kinds[n] = (kinds[n] || 0) + 1; }
  s.panel.kinds = kinds;
  add("کانفیگ‌ها", (s.panel.links || []).length > 0, Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(" · "));
  s.checks = res; s.doneAt = new Date().toISOString();
};

// ✖ undo: removes everything this run created (Railway project, DNS records, worker route + script; repo only if asked)
S.destroy = async (c, s, log) => {
  if (s.rw && s.rw.project) { const d = await rw(c, "mutation($id:String!){projectDelete(id:$id)}", { id: s.rw.project }, true); log(d.__err ? "⚠️ Railway: " + d.__err : "پروژه‌ی Railway حذف شد"); }
  if (s.cf && s.cf.zone) {
    for (const k of ["panelRecord", "verifyRecord", "cdnRecord"]) if (s.cf[k]) { const r = await cf(c, "DELETE", `/zones/${s.cf.zone}/dns_records/${s.cf[k]}`); log(r.ok ? `رکورد DNS حذف شد (${k})` : "⚠️ " + r.err); }
    if (s.cf.route) { const r = await cf(c, "DELETE", `/zones/${s.cf.zone}/workers/routes/${s.cf.route}`); log(r.ok ? "Route ورکر حذف شد" : "⚠️ " + r.err); }
    if (s.cfg && s.cfg.worker && s.cf.account) { const r = await cf(c, "DELETE", `/accounts/${s.cf.account}/workers/scripts/${s.cfg.worker}?force=true`); log(r.ok ? "ورکر CDN حذف شد" : "⚠️ " + r.err); }
  }
  if (s.cfg && s.cfg.deleteRepo && s.gh && s.gh.repo && !s.gh.reused) { const r = await gh(c, "DELETE", `/repos/${s.gh.repo}`); log(r.status === 204 ? "مخزن GitHub حذف شد" : "⚠️ مخزن حذف نشد (" + r.status + ")"); }
};

export async function runStep(id, creds, state, log) {
  const fn = S[id];
  if (!fn) throw new StepError("مرحله‌ی ناشناخته: " + id);
  state.cfg = state.cfg || {};
  return (await fn(creds, state, log)) || { done: true };
}

// ---------------------------------------------------------------- report
export function report(s) {
  const L = [], line = "═".repeat(60), hr = "─".repeat(60);
  const kv = (k, v) => L.push(`  ${k.padEnd(26, " ")} ${v ?? "—"}`);
  L.push(line, "  SABI-REX · گزارش کامل نصب خودکار (SABI-REX Forge)", `  تاریخ: ${s.doneAt || new Date().toISOString()}`, line, "");
  L.push("■ ورود به پنل"); kv("آدرس ورود مخفی", `https://${s.cfg.domain}/${s.cfg.key}`); kv("نام کاربری", "admin"); kv("رمز عبور", s.cfg.password);
  kv("آدرس پنل بعد از ورود", `https://${s.cfg.domain}/dashboard/`);
  L.push("  نکته: بدون آدرس ورود مخفی، پنل فقط یک صفحه‌ی ساده نشان می‌دهد و لو نمی‌رود.", "");
  L.push("■ کاربر تست"); kv("نام کاربر", s.cfg.testUser); kv("حجم", s.cfg.testGB + " GB · بدون انقضا"); kv("لینک اشتراک", s.panel && s.panel.sub);
  kv("تعداد کانفیگ", s.panel && s.panel.links ? s.panel.links.length : 0);
  if (s.panel && s.panel.kinds) kv("پروتکل‌ها", Object.entries(s.panel.kinds).map(([k, v]) => `${k}×${v}`).join("  "));
  L.push("");
  L.push("■ دامنه‌ها و مسیرها");
  kv("دامنه‌ی پنل", s.cfg.domain + "  (CNAME → " + (s.rw && s.rw.cname) + ", DNS only)");
  kv("دامنه‌ی Railway (Railway Gate)", s.rw && s.rw.domain);
  (s.cfg.mirrors || []).forEach((m, i) => kv(i ? "Worker Gate (workers.dev)" : "CDN Shield (Cloudflare)", m));
  if (s.rw && s.rw.tcp) kv("Shadowsocks (TCP Proxy)", `${s.rw.tcp.domain}:${s.rw.tcp.port}`);
  kv("CDN Storm", "۱۲ IP تمیز Cloudflare × ۶ پورت HTTPS (443/2053/2083/2087/2096/8443)");
  kv("منطقه‌ی سرور", REGIONS[s.cfg.region] ? REGIONS[s.cfg.region].name : "");
  L.push("");
  L.push("■ GitHub"); kv("حساب", s.gh && s.gh.login); kv("مخزن", s.gh && `https://github.com/${s.gh.repo}` + (s.gh.private ? " (خصوصی)" : " (عمومی)")); kv("کامیت مستقر", s.gh && s.gh.commit); kv("منبع", "https://github.com/" + SOURCE_REPO); L.push("");
  L.push("■ Railway"); kv("حساب", s.rw && s.rw.email); kv("Project ID", s.rw && s.rw.project); kv("Environment ID", s.rw && s.rw.env); kv("Service ID", s.rw && s.rw.service);
  kv("Volume", (s.rw && s.rw.volume) + "  → /var/lib/sabirex"); kv("Deployment", s.rw && s.rw.deploy);
  kv("داشبورد", s.rw && `https://railway.com/project/${s.rw.project}`); kv("Healthcheck", "/health · ری‌استارت خودکار ALWAYS · بدون خواب");
  kv("متغیرها", (s.rw && s.rw.vars || []).join(", ")); L.push("");
  L.push("■ Cloudflare"); kv("Zone", s.cf && `${s.cf.zoneName} (${s.cf.zone})`); kv("Account ID", s.cf && s.cf.account); kv("ورکر CDN", s.cfg.worker);
  kv("رکورد DNS پنل", s.cf && s.cf.panelRecord); kv("رکورد DNS CDN", s.cf && s.cf.cdnRecord); kv("Route ورکر", s.cf && s.cf.route); L.push("");
  if (s.checks) { L.push("■ نتیجه‌ی تست‌ها"); s.checks.forEach((x) => L.push(`  ${x.ok ? "✅" : "⚠️"} ${x.name}  ${x.info || ""}`)); L.push(""); }
  if (s.panel && s.panel.links) { L.push("■ همه‌ی کانفیگ‌ها"); s.panel.links.forEach((l, i) => L.push(`  ${String(i + 1).padStart(2, "0")}. ${linkName(l).split("✦").pop().trim()}`)); L.push(""); }
  L.push(hr, "■ راهنما");
  L.push("  • لینک اشتراک را در v2rayNG / Hiddify / Streisand / Happ اضافه کن و تست پینگ بگیر؛ سریع‌ترین را انتخاب کن.");
  L.push("  • اگر دامنه‌ی اصلی فیلتر شد: کانفیگ‌های ☁️ CDN Shield، 🌩 CDN Storm، 🛡 Worker Gate و 🚉 Railway Gate جایگزین‌اند.");
  L.push("  • رمز ادمین را از منوی پنل عوض کن؛ عوض کردنش چیزی را خراب نمی‌کند.");
  L.push("  • به‌روزرسانی: هر تغییری در مخزن GitHub بدهی، Railway خودکار دوباره مستقر می‌کند.");
  L.push("  • فراموشی رمز: در Railway متغیر RESET_ADMIN_PASSWORD=1 بگذار و Redeploy کن.");
  L.push("  • این فایل رمزها را دارد؛ جای امن نگهش دار.");
  L.push(line);
  return L.join("\n");
}
