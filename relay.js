'use strict';
// Small RTSP relay for players that choke on this NVR's stream description (VLC: "Unknown codec name for RTP payload type 97").
// It does NOT decode or re-encode anything. It forwards bytes and only
//   - removes the audio section from the SDP (the NVR lists it without a codec),
//   - forces TCP interleaved transport (UDP video from the NVR does not reach most PCs),
//   - swaps the server address in URLs so the player keeps talking to the relay.
// The player's URL (with its user/password) is passed to the NVR unchanged: the NVR does the authentication.
const net = require('net');

class Framer {   // splits an RTSP-over-TCP byte stream into text messages and interleaved '$' frames
  constructor(onText, onFrame) { this.buf = Buffer.alloc(0); this.onText = onText; this.onFrame = onFrame; this.bad = false; }
  push(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      let b = this.buf;
      while (b.length && (b[0] === 0x0d || b[0] === 0x0a)) b = b.subarray(1);   // stray line breaks between messages
      this.buf = b;
      if (!b.length) return;
      if (b[0] === 0x24) {
        if (b.length < 4) return;
        const len = b.readUInt16BE(2);
        if (b.length < 4 + len) return;
        this.onFrame(b[1], b.subarray(0, 4 + len)); this.buf = b.subarray(4 + len); continue;
      }
      const i = b.indexOf('\r\n\r\n');
      if (i < 0) { if (b.length > 65536) this.bad = true; return; }
      const head = b.subarray(0, i).toString('latin1'), m = /^content-length:\s*(\d+)/im.exec(head), len = m ? +m[1] : 0;
      if (len > 1e6) { this.bad = true; return; }
      if (b.length < i + 4 + len) return;
      this.onText(head, b.subarray(i + 4, i + 4 + len)); this.buf = b.subarray(i + 4 + len);
    }
  }
}

function stripAudio(sdp) {
  const out = []; let skip = false;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) skip = line.startsWith('m=audio');
    if (!skip && line !== '') out.push(line);
  }
  return out.join('\r\n') + '\r\n';
}

function handle(client, upstream, log) {
  const up = upstream();
  if (!up || !up.host) return client.destroy();
  const server = net.connect(up.port, up.host);
  const channels = new Set();   // interleaved channels the player actually set up
  let auth = null;              // how the player addressed us, e.g. 127.0.0.1:8554
  const nvr = `rtsp://${up.host}:${up.port}`, nvrBare = `rtsp://${up.host}`;
  const fwd = (dst, src, buf) => { if (dst.destroyed) return; if (!dst.write(buf)) { src.pause(); dst.once('drain', () => src.resume()); } };
  const closeBoth = () => { client.destroy(); server.destroy(); };

  const c2s = new Framer((head, body) => {
    let h = head;
    const m = /^[A-Z_]+ rtsp:\/\/([^\/\s]+)/.exec(h);
    if (m && !auth) auth = m[1];
    if (auth) h = h.split('rtsp://' + auth).join(nvr);
    if (/^SETUP /.test(h)) {   // always ask the NVR for TCP, whatever the player asked for
      const t = /^Transport:\s*(.*)$/im.exec(h), il = t && /interleaved=(\d+)-(\d+)/.exec(t[1]);
      const a = il ? +il[1] : channels.size, b = il ? +il[2] : channels.size + 1;
      channels.add(a); channels.add(b);
      const line = `Transport: RTP/AVP/TCP;unicast;interleaved=${a}-${b}`;
      h = t ? h.replace(/^Transport:.*$/im, line) : h + '\r\n' + line;
    }
    fwd(server, client, Buffer.concat([Buffer.from(h + '\r\n\r\n', 'latin1'), body]));
  }, (ch, frame) => fwd(server, client, frame));   // player's RTCP receiver reports

  const s2c = new Framer((head, body) => {
    let h = head, b = body;
    if (auth) h = h.split(nvr).join('rtsp://' + auth).split(nvrBare).join('rtsp://' + auth);
    if (/^content-type:\s*application\/sdp/im.test(h)) {
      b = Buffer.from(stripAudio(body.toString('latin1')), 'latin1');
      h = h.replace(/^content-length:.*$/im, `Content-Length: ${b.length}`);
    }
    fwd(client, server, Buffer.concat([Buffer.from(h + '\r\n\r\n', 'latin1'), b]));
  }, (ch, frame) => { if (channels.has(ch)) fwd(client, server, frame); });   // drop audio frames the player never asked for

  client.on('data', d => { c2s.push(d); if (c2s.bad) closeBoth(); });
  server.on('data', d => { s2c.push(d); if (s2c.bad) closeBoth(); });
  client.on('close', closeBoth); server.on('close', closeBoth);
  client.on('error', closeBoth); server.on('error', e => { log(`RTSP relay: NVR connection failed (${e.code || e.message})`); closeBoth(); });
  client.setNoDelay(true); server.setNoDelay(true);
}

function startRelay({ port, bind, upstream, log = console.log, maxConn = 16 }) {
  let n = 0;
  const srv = net.createServer(c => { if (n >= maxConn) return c.destroy(); n++; c.on('close', () => n--); handle(c, upstream, log); });
  srv.on('error', e => log('RTSP relay not started: ' + e.message));
  srv.listen(port, bind, () => log(`RTSP relay: rtsp://${bind}:${port}`));
  return srv;
}
module.exports = { startRelay, stripAudio };
