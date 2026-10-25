<p align="center">
  <img src="web/public/logo.png" width="140" alt="WebSpeak3 logo">
</p>

<h1 align="center">WebSpeak3</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="Dockerfile"><img src="https://img.shields.io/badge/docker-build%20passing-2496ED?logo=docker&logoColor=white" alt="Docker Build"></a>
  <a href="gateway/package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node Version"></a>
  <a href="connector/Cargo.toml"><img src="https://img.shields.io/badge/rust-2021-000000?logo=rust&logoColor=white" alt="Rust Version"></a>
  <a href="https://github.com/WebSpeak3/webspeak3/releases"><img src="https://img.shields.io/github/v/release/WebSpeak3/webspeak3?include_prereleases&label=release" alt="Latest Release"></a>
  <img src="https://img.shields.io/badge/status-public%20beta-f0b429" alt="Project Status">
</p>

<p align="center">
  <b>A modern, self-hosted browser client for TeamSpeak, TeaSpeak, and VoySpeak servers — no install, just open a tab.</b>
</p>

<p align="center">
  <a href="https://webspeak3.de">🌐 Website</a> ·
  <a href="https://client.webspeak3.de">💬 Open Client</a> ·
  <a href="https://demo.webspeak3.de">🕹️ Live Demo</a> ·
  <a href="#-quick-start">🚀 Quick Start</a> ·
  <a href="#-installation">📖 Installation</a> ·
  <a href="ROADMAP.md">🗺️ Roadmap</a> ·
  <a href="https://github.com/WebSpeak3/webspeak3/issues">🐛 Report Bug</a>
</p>

> The [live demo](https://demo.webspeak3.de) runs entirely in your browser with simulated data — no real TeamSpeak server involved. It's there to show the UI, not the real connection.

---

## 📸 Preview

<table>
  <tr>
    <th>Desktop</th>
    <th>Mobile</th>
  </tr>
  <tr>
    <td width="72%"><img src="docs/screenshots/webspeak_current.png" width="100%" alt="WebSpeak3 desktop client connected to a TeamSpeak server"></td>
    <td width="28%" align="center"><img src="docs/screenshots/webspeak_mobile.png" width="260" alt="WebSpeak3 mobile client connected to a TeamSpeak server"></td>
  </tr>
</table>

## 🚀 Quick Start

Run the ready-made container and open **http://localhost:8080**:

```bash
docker run -d --name webspeak3 --restart unless-stopped -p 8080:8080 moepchi/webspeak3:latest
```

Enter the address and port of **any reachable TeamSpeak 3, TeamSpeak 6,
TeaSpeak, or VoySpeak server** in the connection dialog. The server does
not need to be installed on the same machine, modified, or operated by you.

> Voice requires a secure context. Microphone access works on `localhost`; for
> access from other devices, place WebSpeak3 behind an HTTPS reverse proxy.

## ✨ Features

|  |  |
|---|---|
| 🔌 **Real TeamSpeak protocol** | Connects to actual TS3/TS6, TeaSpeak, and VoySpeak servers over a WebSocket gateway — the server stays exactly as-is |
| 🎙️ **Low-latency voice** | Opus-encoded voice with voice activation ("Sprachaktivierung") and adjustable sensitivity |
| 🤫 **Whisper** | Target your voice at specific channels or clients instead of your whole current channel |
| 🔊 **Custom audio output picker** | Route playback to any output device — works even in browsers without `AudioContext.setSinkId` |
| 💬 **Full text chat** | Channel, server-wide, and private (1:1) chat, each in its own tab — Shift+Enter for a newline |
| 🌳 **Live channel/client tree** | Correct ordering, status icons (channel commander, away, muted, deafened), country flags, click to switch channels |
| 🖱️ **Right-click context menu** | Private chat, poke, copy name, whisper-target toggle, and a per-person volume slider straight from a client's row |
| 🔎 **Tree search** | Filter channels and users by name; matches stay in place with their parent channels |
| 🖼️ **Avatars** | Shows the TeamSpeak avatars people have set, in the tree, the speaking bar, and the info panel |
| 📜 **Server log** | Join/leave/switch, channel-group, and channel/server-change events shown inline, like the native client |
| 🔔 **Custom sound notifications** | Per-event sounds (connect, poke, messages, ...) with volume control and `.ts3soundpack` import |
| 🪪 **Persistent identity** | Keeps the same client UID across sessions instead of generating a new one every connect |
| 👉 **Poke & away status** | Poke clients with an optional message; set yourself away with presets or a custom status |
| ⭐ **Favorites & reconnect** | Remembers your last server/nickname; switch servers without leaving your tab |
| 📱 **Mobile-friendly layout** | Responsive single-column layout for narrow screens, not just a shrunk desktop UI |
| 🌍 **Localized UI** | Interface available in German, English, Simplified Chinese, and Persian (Beta), detected automatically or switchable in Options |
| 🌗 **Dark / light theme** | Clean, modern UI that adapts to your preference |
| 🔁 **Multi-join (server tabs)** | Several connections in parallel — one tab per server, like VoySpeak. Audio stays on the active tab |
| 🔁 **Seamless reconnect** | Switch or add connections mid-session without tearing down unrelated tabs; dropped connections come back on their own, with the channel tree intact |
| ⌨️ **Keyboard & screen readers** | Arrow keys through the channel tree (exposed as an ARIA tree) and through menus, Enter joins, context-menu key opens the menu; focus-trapped dialogs, labelled toolbar buttons |
| 🍵 **VoySpeak support** | Connects to real VoySpeak servers (formerly GreenTeaSpeak), not just TS3/TS6/TeaSpeak |
| 🖥️ **Screen streaming to/from TS6** | <sub>**ALPHA · UNSTABLE**</sub> Share your screen to native TeamSpeak 6 clients and watch theirs. Built on TS6's undocumented Stream/Call protocol — expect it to break; see [Roadmap](ROADMAP.md) |

## 🧱 Tech Stack

<p>
  <img src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" alt="Docker">
</p>

<details>
<summary><b>🏗️ Architecture details</b></summary>

<br>

Browsers can't send raw UDP, which is what TeamSpeak's native protocol runs
over, so a pure client-side implementation isn't possible — a server-side
gateway is required that speaks the real TS protocol on one side and
WebSocket to the browser on the other.

```
Browser (web/)  <--WebSocket-->  Gateway (gateway/)  <--stdin/stdout JSON-->  Rust connector (connector/)  <--TS3/TS6/TeaSpeak/VoySpeak protocol-->  Server
```

- **`web/`** — Vite + React frontend. TS3-lookalike UI: channel tree, chat
  tabs, voice controls.
- **`gateway/`** — Node.js/TypeScript WebSocket server. Spawns the Rust
  connector **per browser WebSocket** and relays newline-delimited JSON events
  between it and the browser. Multi-join opens one `/ws` connection per server
  tab (parallel connectors).
- **`connector/`** — Rust binary wrapping [`tsclientlib`](https://github.com/ReSpeak/tsclientlib)
  (vendored as a git submodule in `tsclientlib/`, currently tracking a fork
  with TeaSpeak/VoySpeak protocol support), the actual TS3/TS6/TeaSpeak
  protocol implementation. Handles connecting, channel/client state, chat,
  and Opus-encoded voice. Auto-detects the server dialect on connect (or it
  can be forced via `--server-type`).

</details>

## 🌐 Browser Support

| Browser | Status | Notes |
|---|---|---|
| Chrome / Edge / Chromium | ✅ Primary target | Recommended for the most complete audio and device support |
| Firefox | ✅ Supported | Core client and voice functionality are supported |
| Safari | 🧪 Experimental | Audio and microphone behavior still needs broader real-device testing |
| Mobile Chromium | ✅ Supported | Responsive client with microphone support over HTTPS |
| Mobile Safari | 🧪 Experimental | UI is responsive; audio behavior remains under active validation |

WebSpeak3 is a public beta. See the [beta roadmap](ROADMAP.md) for the current
scope, known limitations, and the next milestones.

## 🚀 Installation

### 🐳 Docker (recommended)

Clone the repo (the Rust connector depends on a git submodule, so pull it in too):

```bash
git clone --recurse-submodules https://github.com/WebSpeak3/webspeak3.git
cd webspeak3
```

This is what ships in [`docker-compose.yml`](docker-compose.yml):

```yaml
services:
  webspeak3:
    build: .
    image: moepchi/webspeak3:latest
    container_name: webspeak3
    restart: unless-stopped
    environment:
      - PORT=8080
```

Port publishing is left out on purpose — set it in a local, gitignored `docker-compose.override.yml` so it doesn't clash with whatever else is already using a port on your host:

```yaml
services:
  webspeak3:
    ports:
      - "8080:8080"
```

Then `docker compose up -d` and open `http://localhost:8080` (or whatever host port you chose).

Prefer to skip the build entirely? A prebuilt image for `linux/amd64` and `linux/arm64` (e.g. a Raspberry Pi 4/5 on a 64-bit OS) is published on [Docker Hub](https://hub.docker.com/r/moepchi/webspeak3):

```bash
docker run -d -p 8080:8080 --name webspeak3 moepchi/webspeak3:latest
```

The UI shows a small **Ko-fi donation button** in the bottom right corner. Building it yourself and would rather not carry someone else's donation link? `docker compose build --build-arg DONATE_URL=` removes it (any other value points it somewhere else). Outside Docker the same thing is a build-time variable: `VITE_DONATE_URL= npm run build` in `web/`.

The **Design Store** (browse/upload community themes) points at the maintainer's shared catalog by default, same as the official client — no setup needed. Want to run your own store instead, backed by your own gateway (`STORE_ENABLED=1`, see below)? `docker compose build --build-arg STORE_URL=https://your-gateway.example.com/api/store/themes`. Outside Docker: `VITE_STORE_URL=https://your-gateway.example.com/api/store/themes npm run build` in `web/`.

#### Account sync

Options → Account lets people carry identities, favorites, settings, designs and whisper lists to their other devices. Like Mullvad, an account is just a random 16-digit number, optionally with a random password: no email, no name. Everything is encrypted in the browser (PBKDF2 → AES-GCM) before upload, so the sync server only ever stores unreadable blobs; it keeps no IP addresses and deletes accounts nobody opened for a year.

By default every client uses the official sync server. To run your own, start the same image with a different command and point your gateway at it:

```yaml
  webspeak3-sync:
    image: moepchi/webspeak3:latest
    command: ["node", "dist/sync-server.js"]
    environment:
      - SYNC_DATA_DIR=/app/sync-data
      - TRUST_PROXY=cloudflare
    volumes:
      - ./sync-data:/app/sync-data   # owned by uid 1000 (the image runs as "node")
```

Route `/api/sync/*` to it in your proxy/tunnel and set `SYNC_URL=https://your-host/api/sync` on the gateway. Accounts only exist on the server they were created on. Optional: `SYNC_POW_BITS` (proof-of-work difficulty for new accounts, default `15`), `SYNC_MAX_ACCOUNTS` (default `100000`), `SYNC_ALLOWED_ORIGIN` (CORS, default `*`).

#### Environment variables

All optional; add them under `environment:` in your compose override next to `PORT`. These are the common ones - the full list (logging, feedback form, Design Store details, build-time variables) is on the wiki's [Configuration & Environment Variables](https://github.com/WebSpeak3/webspeak3/wiki/Configuration-and-Environment-Variables) page.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the gateway listens on. |
| `WEB_STATIC` | on | Set to `0` to disable serving the built UI (`web/dist`) entirely — the gateway then only answers `/ws`, `/api/feedback` and `/healthz`. Use this when the UI is hosted elsewhere (e.g. a CDN/static host) and the gateway is purely a backend. |
| `WEB_DIST` | `web/dist` next to the gateway | Overrides the directory served when `WEB_STATIC` is on. Only needed for non-standard layouts. |
| `DEFAULT_SERVER` / `DEFAULT_CHANNEL` | unset | Server (and optionally channel) every visitor auto-connects to — see [Bake in a default server](#2-bake-in-a-default-server). |
| `BROADCAST_TOKEN` | unset | Bearer token required to call `/api/broadcast` (send an in-app notice to all connected clients before a maintenance restart). Endpoint 404s while unset. |
| `TLS_CERT` / `TLS_KEY` | unset | Paths to serve the gateway over HTTPS/WSS directly instead of behind a reverse proxy/tunnel. Both must be set together. |
| `STORE_ENABLED` | off | Set to `1` to turn this gateway's own `/api/store/themes` endpoint on. Only needed if you want to run your own Design Store instead of using the maintainer's shared one (see `STORE_URL` build arg above) — the endpoint 404s while unset. The store can also run as its own process (`node dist/store-server.js`, same image) so redeploying it never drops voice connections; route `/api/store/*` to it in your reverse proxy. |
| `STORE_DATA_FILE` | `store-themes.json` in the container's working dir | Where submitted themes (including screenshots) are stored. Mount a volume over this path if they should survive a container recreate. |
| `STORE_ALLOWED_ORIGIN` | `*` | CORS origin allowed to call the store endpoint, if you want to restrict it to your own frontend's origin. |
| `STORE_ADMIN_TOKEN` | unset | Bearer token for moderation. New submissions wait as "pending" until approved on the review page at `/api/store/admin` (enter the token there); the token holder's own submissions and the reserved author name(s) skip the queue. Without it, nothing ever gets published. Submitted CSS is also checked server-side: no `@import`/`@font-face`, no external `url()` — only inline `data:` images. |
| `ALLOWED_SERVERS` | unset (any server) | Comma-separated list of server addresses this gateway is allowed to connect to (e.g. `ts.example.com,*.example.net`). A port is matched separately from the host, so listing `ts.example.com` allows any port on it. An entry starting with `*.` matches any subdomain (`*.example.com` allows `ts.example.com`, not `example.com` itself - list that separately too if it should also be reachable). Locks a self-hosted instance down to specific server(s) instead of acting as a general "connect anywhere" client; a rejected `connect` gets an error back before any connector process is even spawned. An entry may carry a port (`ts.example.com:9988`): it still allows every port, but that's the address the connect dialog offers (see `SERVER_PICKER`). |
| `SERVER_PICKER` | on | With `ALLOWED_SERVERS` set (and no `*.` entries in it), the connect dialog's address field becomes a dropdown of those servers, or a locked field if there's only one. Set to `0` for the plain text field instead. Only works when the gateway serves the web client itself (the Docker image does). |
| `ALLOW_PRIVATE_TARGETS` | off | By default the gateway refuses to connect to private/internal addresses (loopback, `10.x`, `192.168.x`, CGNAT, link-local, …), no matter how they were reached (IP, DNS, SRV, TSDNS, nickname, file-transfer redirect), so it can't be abused to probe the network it runs in. **If your TeamSpeak server is on the same LAN as the gateway, set this to `1`.** |
| `TURN_URLS` | unset | Comma-separated TURN URLs (e.g. `turn:turn.example.com:3478`) offered to browsers for screen streams, for viewers or publishers behind NATs where direct P2P fails. Pair with `TURN_SECRET` (coturn's `use-auth-secret`; each browser gets its own credential valid for 24 h) or with static `TURN_USERNAME` / `TURN_CREDENTIAL`, which every visitor can read. |
| `ALLOWED_ORIGINS` | unset (any origin) | Comma-separated list of web origins allowed to open `/ws` (e.g. `https://client.example.com`). Stops other websites from silently using your gateway as their relay. |
| `MAX_CONNECTIONS_PER_IP` / `MAX_CONNECTIONS` | `10` / `300` | Concurrent `/ws` connections per client IP and in total (each can hold a live TeamSpeak session). `0` disables a limit. |
| `CONNECT_RATE_LIMIT` | `30` | Server connects per client IP per minute. Each one starts a new TeamSpeak session, so this stops anyone from flooding a server through your gateway. `0` disables it. |
| `TRUST_PROXY` | off | Only when the gateway is reachable **solely** through a proxy/tunnel, so per-IP limits see the real client instead of the proxy: `cloudflare` (Cloudflare Tunnel or proxy) uses `CF-Connecting-IP`; `1` (your own nginx/Caddy/Traefik) uses the last `X-Forwarded-For` entry, the one your proxy appended. Don't set it on a directly exposed gateway - clients could then fake their IP. |
| `TELEMETRY` | on | Set to `0` to turn off the anonymous usage ping (see below). |
| `NEWS_TICKER` | on | Set to `0` to hide the news ticker at the bottom of the client. |
| `NEWS_TICKER_CENTRAL` | on | Set to `0` to drop the official WebSpeak3 news (releases, new store designs, announcements) and only show your own messages. |
| `NEWS_TICKER_MESSAGES` | – | Your own ticker messages, separated by `\|`, e.g. `Maintenance tonight at 10pm \| Welcome!` |
| `SYNC_URL` | official sync server | Account sync server your visitors use (Options → Account), e.g. `https://sync.example.com/api/sync`. Only needed if you run your own (see below). |

> **Anonymous usage ping:** when the gateway starts and then once a day, it sends a random instance ID (made up on first start, stored in `instance-id` in the working directory, used for nothing else) and its version number to `gateway.webspeak3.de`. That's the only way to tell whether anyone self-hosts WebSpeak3 at all, and how many instances still run an old version, e.g. after a security fix. Nothing else is sent: no hostnames, no TeamSpeak servers, no users, no settings. The receiving side doesn't store IP addresses. The startup log says when it's on. Turn it off with `TELEMETRY=0`.

> **News ticker:** like the native TS3 client, a small scrolling line at the bottom shows news. Your users' browsers load the official news straight from `gateway.webspeak3.de`, the same way the Design Store works. Your own messages come from `NEWS_TICKER_MESSAGES`. Users can hide the ticker with ✕ until something new comes in.

> **Trust model:** the gateway speaks the TeamSpeak protocol on the user's behalf, so whoever runs it necessarily handles their identity key, server/channel passwords and privilege keys (they're kept out of process listings, but the operator can still see them). Only use gateways you trust, and serve them over HTTPS/WSS (`TLS_CERT`/`TLS_KEY` or a TLS-terminating proxy) - plain HTTP exposes all of that on the wire. File uploads are limited to 24 MiB, downloads to 25 MiB.

> **Stored in the browser:** identities (including their private keys), favorites with any passwords you typed into them, and settings live in the browser's `localStorage`, unencrypted - the same way the native client keeps them in its settings files. Anyone with access to your browser profile can read them; leave favorite password fields empty on shared machines and export identities you care about. Server banners load directly from the host the server admin configured; turn them off under Options → Application if you don't want that host to see your IP.

<details>
<summary><b>🛠️ Manual installation (without Docker)</b></summary>

<br>

**Prerequisites**

- **Node.js** 20+ and npm
- **Rust** (stable toolchain) — [rustup.rs](https://rustup.rs)
- **CMake** and a C/C++ toolchain — needed to build the Opus codec library (`audiopus_sys`) used for voice. On Windows, the Visual Studio "Desktop development with C++" workload covers this; on Linux, install `cmake` and `build-essential` (or equivalent); on macOS, `cmake` via Homebrew plus Xcode command line tools.
- **git**

**1. Clone the repository**

The Rust connector depends on the `tsclientlib` crate, vendored as a git submodule — make sure to pull it in too:

```bash
git clone --recurse-submodules https://github.com/WebSpeak3/webspeak3.git
cd webspeak3
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

**2. Build the Rust connector**

```bash
cd connector
cargo build
```

> **Note:** if the build fails with a CMake error like `Compatibility with CMake < 3.5 has been removed`, it's because the vendored Opus source uses an old `cmake_minimum_required`. Work around it with:
>
> ```bash
> CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build
> ```
> (On Windows PowerShell: `$env:CMAKE_POLICY_VERSION_MINIMUM = "3.5"; cargo build`)

This produces `connector/target/debug/ts-connector` (or `ts-connector.exe` on Windows), which the gateway spawns automatically — no manual step needed after this.

**3. Install and start the gateway**

```bash
cd gateway
npm install
npm run dev
```

This starts the WebSocket gateway on `ws://localhost:8080`. Open **http://localhost:8080** for the UI (serves `web/dist`). After UI changes run `cd web && npm run build`, then reload. Optional Vite (`npm run dev` in `web/`, typically `:5173`) is only for HMR. `WEB_STATIC=0 npm run dev` serves API/WebSocket only.

**4. Install and start the web frontend**

In a separate terminal:

```bash
cd web
npm install
npm run dev
```

Vite will print a local dev URL (typically `http://localhost:5173`) — open it in a browser.
The Vite app connects to the gateway at `ws://localhost:8080/ws`.

> **Preferred UI:** **http://localhost:8080** (static `web/dist` — refresh after `cd web && npm run build`). Vite `:5173` is optional HMR only.

**5. Connect**

In the web UI, enter the address of a TeamSpeak server and a nickname, then click **Connect**. Voice requires microphone permission when you enable the mic button; the output-device picker (if your browser supports it) requires no extra permission.

**Rebuilding after changes**

- Frontend and gateway changes hot-reload automatically (`npm run dev` in both cases).
- Connector changes require a rebuild (`cargo build` in `connector/`) and a reconnect from the browser — if the old `ts-connector` binary is still running (an active browser connection), disconnect first or the build will fail to overwrite the binary.

</details>

## 🔗 Auto-Connect Links

Skip the connect dialog entirely and drop visitors straight into a TeamSpeak server. Two ways to do it — use either, or both together.

### 1. Share a link

Add a `connect` parameter to your instance's URL and send that link out — in a Discord post, a landing page button, a QR code, wherever:

```
https://your-instance/?connect=voice.example.com&nickname=Guest&channel=Lobby#token=abc123
```

| Parameter  | Required | What it does |
|------------|----------|--------------|
| `connect`  | yes      | Server address to join, `host` or `host:port` |
| `nickname` | no       | Nickname to connect with — omit it and the visitor gets an auto-generated `Guest-XXXX` |
| `channel`  | no       | Default channel to join |
| `token`    | no       | Server/channel privilege key, if the target requires one. Put it after `#` (as above) so it never reaches server logs or `Referer` headers; `?token=` still works too |

This works on **any** deployment — no rebuild, no configuration. WebSpeak3 connects as soon as the page loads and immediately strips these parameters from the address bar, so refreshing the tab (or someone screenshotting/forwarding the URL later) won't silently reconnect off a stale link.

### 2. Bake in a default server

Running a dedicated instance for one community or event? Set a default server so **every** visitor auto-connects with zero parameters, no link needed. With the Docker image that's just two environment variables, no rebuild:

```yaml
    environment:
      - DEFAULT_SERVER=voice.example.com
      - DEFAULT_CHANNEL=Lobby
```

The gateway hands them to the UI it serves itself, so this needs `WEB_STATIC` left on. Returning visitors' browsers keep the cached app (including its default) until the next image update, so a later change of these values reaches them only then — new visitors get it right away.

Building it yourself, you can bake the default in instead: `docker compose build --build-arg DEFAULT_SERVER=voice.example.com --build-arg DEFAULT_CHANNEL=Lobby` (the environment variables above win over these if both are set). Outside Docker, the same thing is a build-time variable:

```bash
VITE_DEFAULT_SERVER=voice.example.com VITE_DEFAULT_CHANNEL=Lobby npm run build
```

(in `web/`). Leave `DEFAULT_CHANNEL`/`VITE_DEFAULT_CHANNEL` out to just join the server's default channel.

A share link (above) always takes priority over the baked-in default when both are present — so you can point most visitors at your default server while still sending specific people somewhere else via link.

Either way: on your own hosted instance, the mandatory first-visit Terms of Use is shown and accepted before anything auto-connects; and if the connection fails, the connect dialog opens prefilled so the visitor can fix it and retry by hand.

## Credits

The vast majority of this project's code was written by [Claude Code](https://claude.com/claude-code) (Anthropic's Claude), working iteratively with the repo owner one feature at a time.

## 🌈 In Memory of Akimo

<!-- Permanent: never remove this section. -->
<img src="web/src/assets/akimo.jpg" alt="Akimo" width="120" align="left" />

WebSpeak3 is dedicated to Akimo, the project owner's dog, who crossed the rainbow bridge on October 21, 2026. 🐾

<br clear="left" />

## Star History

<a href="https://www.star-history.com/?repos=webspeak3%2Fwebspeak3&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=webspeak3/webspeak3&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=webspeak3/webspeak3&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=webspeak3/webspeak3&type=date&legend=bottom-right" />
 </picture>
</a>

---

### Legal / Disclaimer

**WebSpeak3** is an independent, open-source, self-hosted project and is
**not** affiliated with, associated with, authorized by, endorsed by, or in
any way officially connected with TeamSpeak Systems GmbH.

"TeamSpeak", "TS3", and related logos or names are registered trademarks of
TeamSpeak Systems GmbH. Likewise, WebSpeak3 is not affiliated with,
associated with, authorized by, or endorsed by TeaSpeak or VoySpeak (formerly GreenTeaSpeak);
"TeaSpeak" and "VoySpeak" are names of their respective projects/
operators. All product and company names are trademarks™ or registered®
trademarks of their respective holders. Use of them does not imply any
affiliation with or endorsement by them.
