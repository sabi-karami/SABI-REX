#!/bin/bash
set -e
echo "=== ⚡ SABI-REX on Railway ==="
# ⚡ more open connections for nginx + Xray (many users / many tabs at once), never fatal
ulimit -n 65535 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true

# No hard-coded env login: the admin lives in the database, so a password changed in the panel really works.
# (first install = admin / admin, see ensure_admin.py)
unset SUDO_USERNAME SUDO_PASSWORD
# internal wiring is forced too, so a wrong Railway variable can never break the panel
export UVICORN_HOST=127.0.0.1
export UVICORN_PORT=8000
export XRAY_JSON=/var/lib/sabirex/xray_config.json
export SQLALCHEMY_DATABASE_URL=sqlite:////var/lib/sabirex/db.sqlite3
export JWT_ACCESS_TOKEN_EXPIRE_MINUTES="${JWT_ACCESS_TOKEN_EXPIRE_MINUTES:-1440}"
# ⚡ our own subscription page (sub.html)
export CUSTOM_TEMPLATES_DIRECTORY=/opt/rex/templates/
export SUBSCRIPTION_PAGE_TEMPLATE=subscription/index.html
# what apps see when they fetch the subscription: title, support link, auto-update every 6h
export SUB_PROFILE_TITLE="${SUB_PROFILE_TITLE:-SABI-REX}"
# SABI-REX: no API docs, ever
export DOCS=False
export SUB_SUPPORT_URL="${SUB_SUPPORT_URL:-}"
export SUB_UPDATE_INTERVAL="${SUB_UPDATE_INTERVAL:-6}"
# 🔗 every app gets plain share links (the same way the SABI-REX panels that ping well do it):
#    the app builds its own config, so no panel JSON template can ever break the connection.
#    Set USE_CUSTOM_JSON_FOR_V2RAYNG=True (etc.) in Railway Variables to switch back to full JSON.
export USE_CUSTOM_JSON_FOR_V2RAYNG="${USE_CUSTOM_JSON_FOR_V2RAYNG:-False}"
export USE_CUSTOM_JSON_FOR_V2RAYN="${USE_CUSTOM_JSON_FOR_V2RAYN:-False}"
export USE_CUSTOM_JSON_FOR_STREISAND="${USE_CUSTOM_JSON_FOR_STREISAND:-False}"
export USE_CUSTOM_JSON_FOR_HAPP="${USE_CUSTOM_JSON_FOR_HAPP:-False}"

mkdir -p /var/lib/sabirex /run/rex
# 🔐 secret config path /cdn/<random id> (SABI-REX style): made once, kept in the Volume = configs never change.
#    REX_PATH_SECRET in Railway Variables sets your own id (8-64 letters / digits / -).
JX_FILE=/var/lib/sabirex/rex_path
JX_ID="$(printf '%s' "${REX_PATH_SECRET:-}" | tr -cd 'A-Za-z0-9-')"
if [ ${#JX_ID} -lt 8 ] || [ ${#JX_ID} -gt 64 ]; then
  [ -n "${REX_PATH_SECRET:-}" ] && echo "[start] WARNING: REX_PATH_SECRET must be 8-64 letters/digits/- -> ignored"
  JX_ID="$( (tr -cd 'A-Za-z0-9-' < "$JX_FILE") 2>/dev/null || true)"
fi
if [ ${#JX_ID} -lt 8 ] || [ ${#JX_ID} -gt 64 ]; then
  JX_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python -c 'import uuid; print(uuid.uuid4())')"
fi
printf '%s' "$JX_ID" > "$JX_FILE.tmp" 2>/dev/null && mv -f "$JX_FILE.tmp" "$JX_FILE" || echo "[start] WARNING: could not save the config path"
export REX_WS_BASE="/cdn/$JX_ID"
# 🗝 SABI-REX secret entrance key: the panel only exists for browsers that opened /<key> once.
#    REX_PANEL_KEY in Railway Variables sets your own (16-64 letters/digits), otherwise made once and kept in the Volume.
RK_FILE=/var/lib/sabirex/rex_panel_key
RK="$(printf '%s' "${REX_PANEL_KEY:-}" | tr -cd 'A-Za-z0-9')"
if [ ${#RK} -lt 16 ] || [ ${#RK} -gt 64 ]; then
  [ -n "${REX_PANEL_KEY:-}" ] && echo "[start] WARNING: REX_PANEL_KEY must be 16-64 letters/digits -> ignored"
  RK="$( (tr -cd 'A-Za-z0-9' < "$RK_FILE") 2>/dev/null || true)"
fi
if [ ${#RK} -lt 16 ] || [ ${#RK} -gt 64 ]; then
  RK="$(head -c 64 /dev/urandom | tr -cd 'A-Za-z0-9' | head -c 24)"
fi
printf '%s' "$RK" > "$RK_FILE.tmp" && mv -f "$RK_FILE.tmp" "$RK_FILE"; chmod 600 "$RK_FILE" 2>/dev/null || true
export REX_PANEL_KEY="$RK"
echo "[start] secret entrance ready: https://<your-domain>/$RK"
echo "[start] secret config path ready"
if ! python /opt/lock.py; then
  # safety net: never a dead deploy because of the config builder -> last good config, else the plain repo config
  echo "[lock] WARNING: config builder failed -> using the last good Xray config"
  [ -s /var/lib/sabirex/xray_config.json ] || python - <<'PY' || cp /opt/xray_config.json /var/lib/sabirex/xray_config.json
import json, os
b = json.load(open("/opt/xray_config.json")); l = json.load(open("/opt/locked_inbound.json")); B = os.environ.get("REX_WS_BASE", "/cdn/rex")
l["streamSettings"]["wsSettings"]["path"] = B
for i in b["inbounds"]:
    w = (i.get("streamSettings") or {}).get("wsSettings")
    if isinstance(w, dict) and i.get("tag") in ("VLESS WS", "VMESS WS", "TROJAN WS"):
        w["path"] = B + {"VLESS WS": "/v", "VMESS WS": "/m", "TROJAN WS": "/t"}[i["tag"]]
b["inbounds"].insert(0, l)
json.dump(b, open("/var/lib/sabirex/xray_config.json", "w"), ensure_ascii=False, indent=2)
PY
fi

PUBLIC_DOMAIN="${PANEL_DOMAIN:-${RAILWAY_PUBLIC_DOMAIN:-$CF_TUNNEL_HOSTNAME}}"
if [ -z "$XRAY_SUBSCRIPTION_URL_PREFIX" ] && [ -n "$PUBLIC_DOMAIN" ]; then
  export XRAY_SUBSCRIPTION_URL_PREFIX="https://$PUBLIC_DOMAIN"
fi
echo "[start] domain: ${PUBLIC_DOMAIN:-NOT SET} | sub prefix: ${XRAY_SUBSCRIPTION_URL_PREFIX:-NOT SET}"
[ -d /var/lib/sabirex ] && touch /var/lib/sabirex/.write-test && rm -f /var/lib/sabirex/.write-test \
  || echo "[start] WARNING: /var/lib/sabirex not writable"
mountpoint -q /var/lib/sabirex 2>/dev/null || echo "[start] WARNING: no Volume on /var/lib/sabirex, data will reset on redeploy"
# all 4 Railway regions work; EU West (Amsterdam) gives the lowest ping from Iran
case "${RAILWAY_REPLICA_REGION:-}" in
  *europe*|"") echo "[start] region: ${RAILWAY_REPLICA_REGION:-unknown} (Amsterdam = best for Iran)";;
  *) echo "[start] NOTE: region is ${RAILWAY_REPLICA_REGION} -> works, but for the lowest ping from Iran pick EU West (Amsterdam) in Settings > Regions";;
esac

# panel always on 8080; if Railway injected another PORT, listen there too (healthcheck never misses)
# nginx config rendered from the template with the secret path (every start, so it always matches Xray)
sed -e "s#__JXB__#${REX_WS_BASE}#g" -e "s#__RXK__#${REX_PANEL_KEY}#g" /opt/rex/nginx.conf.tpl > /etc/nginx/conf.d/sabirex.conf
printf 'if ($cookie_rx_k != "%s") { return 404; }\n' "$REX_PANEL_KEY" > /etc/nginx/rex-key.inc
if [ "${REX_OLD_PATHS:-0}" = "0" ]; then
  : > /etc/nginx/rex-old.inc
  echo "[start] old config paths closed (REX_OLD_PATHS=0)"
else
  cat > /etc/nginx/rex-old.inc <<NGX
location = /panel-ws { rewrite ^ ${REX_WS_BASE} break;   proxy_pass http://127.0.0.1:2004; include /etc/nginx/ws.inc; }
location = /vless    { rewrite ^ ${REX_WS_BASE}/v break; proxy_pass http://127.0.0.1:2001; include /etc/nginx/ws.inc; }
location = /vmess    { rewrite ^ ${REX_WS_BASE}/m break; proxy_pass http://127.0.0.1:2002; include /etc/nginx/ws.inc; }
location = /trojan   { rewrite ^ ${REX_WS_BASE}/t break; proxy_pass http://127.0.0.1:2003; include /etc/nginx/ws.inc; }
location = /vhu      { rewrite ^ ${REX_WS_BASE}/u break; proxy_pass http://127.0.0.1:2005; include /etc/nginx/ws.inc; }
NGX
fi
if [ -n "$PORT" ] && [ "$PORT" != "8080" ]; then
  echo "listen ${PORT} reuseport;" > /etc/nginx/rex-port.inc
  echo "[start] Railway PORT=$PORT -> nginx listens on 8080 and $PORT"
else
  : > /etc/nginx/rex-port.inc
fi
if ! nginx -t; then
  # safety net: never a dead deploy because of the web config -> plain panel on 8080 (skin/extras off until fixed)
  echo "[start] WARNING: nginx config failed the test -> emergency config (panel only)"
  # fail-closed: no panel, no limits bypass. Only the healthcheck + an honest 503 until the config is fixed.
  cat > /etc/nginx/conf.d/sabirex.conf <<'NGX'
server {
  listen 8080 reuseport;
  include /etc/nginx/rex-port.inc;
  server_tokens off;
  location = /health { proxy_pass http://127.0.0.1:8090/rex-api/panel-health; }
  location / { default_type text/plain; return 503 "temporarily unavailable"; }
}
NGX
  nginx -t
fi
nginx

# Cloudflare Tunnel (optional): CF_TUNNEL_TOKEN + CF_TUNNEL_HOSTNAME
if [ -n "$CF_TUNNEL_TOKEN" ] && ! command -v cloudflared >/dev/null 2>&1; then
  echo "[tunnel] WARNING: cloudflared is not in this image (download failed at build) -> direct Railway mode"
elif [ -n "$CF_TUNNEL_TOKEN" ]; then
  echo "[tunnel] starting Cloudflare tunnel -> ${CF_TUNNEL_HOSTNAME:-?}"
  ( while true; do
      cloudflared tunnel --no-autoupdate --protocol auto --edge-ip-version 4 --retries 10 \
        run --token "$CF_TUNNEL_TOKEN" 2>&1 | sed -u 's/^/[tunnel] /' || true
      echo "[tunnel] disconnected, reconnecting in 5s"; sleep 5
    done ) &
else
  echo "[tunnel] CF_TUNNEL_TOKEN not set, direct Railway mode"
fi

cd /code
FRESH=0; [ -s /var/lib/sabirex/db.sqlite3 ] || FRESH=1
alembic upgrade head
if ! python /opt/ensure_admin.py; then
  if [ "$FRESH" = "1" ]; then
    # brand-new install only: the panel still opens with admin / admin
    FB_PW="${REX_INIT_PASSWORD:-$(head -c 48 /dev/urandom | tr -cd 'A-Za-z0-9' | head -c 20)}"
    echo "[admin] WARNING: admin manager failed on a fresh install -> first login: admin / $FB_PW"
    export SUDO_USERNAME=admin SUDO_PASSWORD="$FB_PW"
    printf '{"username": "admin", "password": "%s"}' "$FB_PW" > /run/rex/system.json
  else
    # existing panel: your own admin and password stay as they are (never re-opens admin / admin)
    echo "[admin] WARNING: admin manager failed; existing admins are unchanged, log in with your own password"
  fi
fi

# 📶 sing-box / Clash apps (SFA, SFI, Karing, Clash): auto "best latency" tested over plain http = one round trip
#    less per test, so the ping number they show is lower AND still real. Built from this image's own templates.
python - <<'PY' || echo "[start] latency-test templates skipped (apps keep their default test)"
import json, os
T = "http://cp.cloudflare.com/"
src, dst = "/code/app/templates/singbox/default.json", "/opt/rex/templates/singbox/default.json"
if os.path.exists(src) and (os.environ.get("SINGBOX_SUBSCRIPTION_TEMPLATE") or "singbox/default.json") == "singbox/default.json":
    c = json.load(open(src, encoding="utf-8"))
    n = 0
    for o in c.get("outbounds") or []:
        if isinstance(o, dict) and o.get("type") == "urltest":
            o["url"] = T; o.setdefault("interval", "3m"); o.setdefault("tolerance", 50); n += 1
    if n:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        json.dump(c, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"[start] sing-box apps: best-latency test -> {T}", flush=True)
for name in ("clash/default.yml", "clash/settings.yml"):
    s_, d_ = "/code/app/templates/" + name, "/opt/rex/templates/" + name
    if os.path.exists(s_):
        t = open(s_, encoding="utf-8").read()
        t2 = t.replace("https://www.gstatic.com/generate_204", T).replace("http://www.gstatic.com/generate_204", T)
        if t2 != t:
            os.makedirs(os.path.dirname(d_), exist_ok=True); open(d_, "w", encoding="utf-8").write(t2)
            print(f"[start] clash apps: latency test -> {T}", flush=True)
PY

python main.py &
MAIN=$!
echo "$MAIN" > /run/rex/core.pid
trap 'kill -TERM $MAIN 2>/dev/null; wait $MAIN; exit 0' TERM INT

# helpers restart themselves if they ever stop; the panel keeps running no matter what
#   (set +e inside: a crash must restart the helper, not end its loop)
( set +e; while true; do python /opt/rex_api.py; echo "[account] restarting in 2s"; sleep 2; done ) &
( set +e; while true; do python /opt/enforce_hosts.py; echo "[guard] restarting in 5s"; sleep 5; done ) &
( set +e; while true; do python /opt/doctor.py; echo "[doctor] restarting in 5s"; sleep 5; done ) &

set +e
wait "$MAIN"
CODE=$?
echo "[start] panel exited with code $CODE -> container restart"
exit 1
