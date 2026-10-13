# SABI-REX Forge

Cloudflare Worker that builds a complete SABI-REX panel from three tokens (GitHub, Cloudflare, Railway).

* `worker.js` — UI + step API (access code in secret `FORGE_CODE`, `FORGE_SECRET`)
* `engine.js` — the 13 install steps + undo + TXT report
* `ui.html` — the interface

Tokens are never stored: the browser sends them with every step call and keeps them in memory only.
