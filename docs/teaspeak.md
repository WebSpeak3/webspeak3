# TeaSpeak / VoySpeak (formerly GreenTeaSpeak) support (WebSpeak3)

WebSpeak3 can speak the TeamSpeak 3/6 protocol via `ts-connector` / `tsclientlib`.
TeaSpeak / GreenTeaSpeak servers need an extra identity handshake before `clientinit`.

## Implemented

- `--server-type teamspeak|teaspeak|auto` (connector; UI Connect dialog; gateway relay)
- `--privilege-key` / `client_default_token` on connect
- `clientinitiv` with **`-teaspeak` switch** (not `teaspeak=1`), `ip=unknown`, alpha bit0
- Classic TeaSpeak crypto via **`initivexpand`** (P-256 ECDH, 20-byte IV) when the server
  answers that way — required for GreenTeaSpeak hubs that disable TeamSpeak clients
- TEAMSPEAK identity handshake after crypto when needed
- DNS SRV `_gts._udp` in addition to `_ts3._udp`

Verified against `ts.greenteaspeak.de` (Official GreenTeaSpeak Public Server).

## Not yet (follow-up)

- TEAFORO / forum identity (`greenteaspeak.de` login + method 0)
- Native TeaSpeak POW / `teaclient_connection.node` parity
- GTS badges / HWID extras beyond the basic handshake
- Forum-reject → automatic ECC identity retry (GreenTeaSpeak 2 desktop behavior)
