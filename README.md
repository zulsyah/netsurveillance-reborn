# netsurveillance-reborn

**A modern web viewer and manager for Xiongmai / JFTech "NetSurveillance" NVRs and HVRs.**
Replaces the old Internet Explorer / ActiveX client. Zero dependencies, just Node.js.

![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

| Area | What you get |
|---|---|
| **Live view** | RTSP to WebSocket to WebCodecs, main/sub stream per camera, PTZ |
| **Playback** | Zoomable timeline, fast seeking, MP4 download, calendar of recorded days |
| **Monitoring** | Events and alarms, storage, system info |
| **Configuration** | Searchable settings with a weekly schedule editor, camera auto search, users and groups stored in the NVR |
| **Backup** | Config backup and restore |
| **RTSP relay** | Lets VLC play the streams (the NVR's own RTSP link fails in VLC) |
| **Time sync** | Optional automatic NVR time sync, even when nobody is signed in |
| **Setup** | NVR address is set from the web page, no file editing |

## Quick start

```bash
node server.js
```

Open <http://127.0.0.1:8088>. On first run you pick the NVR address, then sign in with an account of the NVR itself.

**Requirements**

- Node.js 18 or newer
- A browser with WebCodecs (Chrome or Edge)
- WebCodecs needs a secure context: `localhost` works, anything else needs HTTPS

## Configuration

| Setting | How | Default |
|---|---|---|
| Web port | env `PORT` or `port` in `config.json` | `8088` |
| Bind address | env `BIND` or `bind` in `config.json` | `127.0.0.1` (`0.0.0.0` = whole LAN) |
| Extra host names | env `ALLOWED_HOSTS`, comma separated | none |
| RTSP relay port | env `RTSP_RELAY_PORT` or `relayPort` | `8554` (`0` = off) |
| RTSP relay bind | env `RTSP_RELAY_BIND` | `127.0.0.1` |

When `BIND` is not loopback, bare IPv4 addresses are always accepted as the host name. Any other name must be listed in `ALLOWED_HOSTS`.

`config.json`, `settings.json` and `timesync-login.json` are created at run time and are not in the repository.

## Using it from another PC

```bash
BIND=0.0.0.0 PORT=8199 node server.js
```

Then open `http://<server-ip>:8199`. Because that is plain HTTP, the browser hides WebCodecs and live view will not play. Pick one:

1. **SSH tunnel** (no browser changes): `ssh -L 8199:127.0.0.1:8199 user@server`, then open `http://localhost:8199`
2. **Chrome / Edge flag**: add the address to `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
3. **HTTPS reverse proxy** in front of the server

## CasaOS

`casaos/docker-compose.yml` runs the viewer as a CasaOS app (`node:22-alpine`, host network, port 8199, LAN bind).

1. Edit the bind-mount `source` to where you cloned this repo.
2. Copy the file to `/var/lib/casaos/apps/netsurveillance-reborn/`.
3. Run `docker compose up -d` in that folder.

The same browser limits as above apply when opening it from another PC.

## Security notes

- Sign-in uses the NVR's own accounts. Sessions live in memory. The server stores no passwords, except the optional time-sync login (plain text in `timesync-login.json`, only if you tick that box).
- By default the server listens on `127.0.0.1` and accepts only `localhost` / `127.0.0.1` host names. LAN mode is opt-in and has no built-in HTTPS, so keep it on a trusted network.
- Firmware flashing is deliberately not implemented.

## Naming

The app shows "NetSurveillance NVR" by default. Rename it in **Settings › This viewer**; the name is saved in `settings.json`.

## Tested with

Firmware `V4.03.R11.C638023D`, hardware `NBD80X16S-KL`. Other Xiongmai devices that speak the same protocol (TCP 34567) may work.

## License

MIT, see [`LICENSE`](LICENSE). This is an unofficial project and is not affiliated with Xiongmai / JFTech.
