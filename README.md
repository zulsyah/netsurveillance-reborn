# NVR Viewer

A modern web viewer and manager for Xiongmai / JFTech "NetSurveillance" NVRs and HVRs, replacing the old Internet Explorer / ActiveX client. No dependencies: just Node.js.

## Features

- Live view (RTSP to WebSocket to WebCodecs), main/sub stream per camera, PTZ
- Playback with a zoomable timeline, fast seeking, MP4 download, calendar of recorded days
- Events and alarms, storage, system info
- Settings (searchable, with a weekly schedule editor), cameras (auto search), users and groups stored in the NVR
- Config backup and restore
- RTSP relay so VLC can play the streams (the NVR's own RTSP link fails in VLC)
- Optional automatic NVR time sync, also when nobody is signed in
- NVR address set from the web page (no file editing)

## Run

```
node server.js
```

Open http://127.0.0.1:8088. On first run you pick the NVR address, then sign in with an account of the NVR itself.

Needs Node.js 18 or newer and a browser with WebCodecs (Chrome or Edge). WebCodecs needs a secure context: `localhost` works, anything else needs HTTPS.

## Settings

| Setting | How |
|---|---|
| Web port | env `PORT` or `port` in `config.json` (default 8088) |
| Bind address | env `BIND` or `bind` in `config.json` (default 127.0.0.1; `0.0.0.0` = LAN) |
| Extra host names | env `ALLOWED_HOSTS`, comma separated (IPv4 addresses are always accepted when `BIND` is not loopback) |
| RTSP relay port | env `RTSP_RELAY_PORT` or `relayPort` (default 8554, `0` = off) |
| RTSP relay bind | env `RTSP_RELAY_BIND` (default 127.0.0.1) |

`config.json`, `settings.json` and `timesync-login.json` are created at run time and are not in the repository.

## Security notes

- Sign-in uses the NVR's own accounts. Sessions live in memory; the server stores no passwords, except the optional time-sync login (plain text in `timesync-login.json`, only if you tick that box).
- The server listens on 127.0.0.1 and only accepts `localhost` / `127.0.0.1` host names. Putting it on a network needs HTTPS and a reverse proxy, and is not done yet.
- Firmware flashing is deliberately not implemented.

## Naming

The app shows "NetSurveillance NVR" by default. You can rename it in Settings › This viewer; the name is saved in `settings.json`.

## License

MIT, see `LICENSE`. This is an unofficial project and is not affiliated with Xiongmai / JFTech.

## Tested with

Firmware V4.03.R11.C638023D, hardware NBD80X16S-KL. Other Xiongmai devices that speak the same protocol (TCP 34567) may work.
