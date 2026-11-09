// Modern NVR viewer bridge: RTSP (H264, TCP-interleaved) -> WebSocket -> browser WebCodecs.
// No dependencies. Listens on 127.0.0.1 by default (BIND / config.json "bind" to change).
const http = require('http'), net = require('net'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const { Sofia, Conn, XMDemux, sofiaHash } = require('./sofia');
const { muxH264 } = require('./mp4');
const { startRelay } = require('./relay');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const PORT = +process.env.PORT || cfg.port || 8088;
const RELAY_PORT = process.env.RTSP_RELAY_PORT !== undefined ? +process.env.RTSP_RELAY_PORT : (cfg.relayPort !== undefined ? +cfg.relayPort : 8554);   // 0 = off
const RELAY_BIND = process.env.RTSP_RELAY_BIND || '127.0.0.1';
const BIND = process.env.BIND || cfg.bind || '127.0.0.1';   // 0.0.0.0 = whole LAN; needs HTTPS (or an SSH tunnel) for WebCodecs off localhost
const ALLOW_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);   // extra host names, e.g. pi.lan
let HOST = cfg.host || '', SOFIA_PORT = cfg.sofiaPort || 34567, RTSP_PORT = cfg.rtspPort || 554;   // the NVR; set from the web page on first run
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---- app settings (display name etc.), stored next to the server ----
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const appSettings = { name: 'NetSurveillance NVR', timeSync: { enabled: false, everyMin: 60 } };
try { Object.assign(appSettings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}

// ---- accounts & sessions: users sign in with their NVR credentials ----
const accounts = new Map();   // user -> { user, password, sofia, recent[], sse:Set, chanCache }
const sessions = new Map();   // token -> { user, acct, last }
const SESSION_MS = 12 * 3600e3;
function getAccount(user, password) {
  let a = accounts.get(user);
  if (a && a.password !== password) { dropAccount(a); a = null; }
  if (!a) {
    a = { user, password, sofia: new Sofia({ host: HOST, sofiaPort: SOFIA_PORT, user, password }), recent: [], sse: new Set(), chanCache: null };
    a.sofia.on('alarm', al => {
      const ev = { t: new Date().toISOString(), ...(al.AlarmInfo || al) };
      a.recent.unshift(ev); a.recent.length = Math.min(a.recent.length, 200);
      for (const r of a.sse) r.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    accounts.set(user, a);
  }
  return a;
}
function dropAccount(a) {
  accounts.delete(a.user);
  a.sofia.shutdown();
  for (const r of a.sse) { try { r.end(); } catch {} }
  for (const st of [...streams.values()]) if (st.acct === a) st.stop();
  for (const [t, ss] of sessions) if (ss.acct === a) sessions.delete(t);
}
function cookieOf(req, name) {
  for (const part of (req.headers.cookie || '').split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
function getSession(req) {
  const t = cookieOf(req, 'nvr_sid'), s = t && sessions.get(t);
  if (!s) return null;
  if (Date.now() - s.last > SESSION_MS) { endSession(t); return null; }
  s.last = Date.now(); s.token = t;
  return s;
}
function endSession(token) {
  const s = sessions.get(token);
  sessions.delete(token);
  if (s && ![...sessions.values()].some(x => x.acct === s.acct)) dropAccount(s.acct);
}
setInterval(() => { for (const [t, s] of sessions) if (Date.now() - s.last > SESSION_MS) endSession(t); }, 600e3).unref();
const fails = new Map();   // ip -> { n, t }
const SC = Buffer.from([0, 0, 0, 1]);
const streams = new Map();

class Stream {
  constructor(ch, sub, acct) {
    this.acct = acct; this.key = `${acct.user}/${ch}/${sub}`; this.ch = ch; this.sub = sub; this.clients = new Set();
    this.buf = Buffer.alloc(0); this.pending = []; this.cseq = 1;
    this.nals = []; this.fu = null; this.curTs = null;
    this.sps = null; this.pps = null; this.lastKey = null; this.stopTimer = null; this.dead = false;
    this.start().catch(e => { console.log(`[${ch}/${sub}] error: ${e.message}`); this.stop(); });
  }
  get url() {
    return `rtsp://${HOST}:${RTSP_PORT}/user=${this.acct.user}&password=${this.acct.password}&channel=${this.ch}&stream=${this.sub}.sdp?real_stream`;
  }
  req(method, url, headers = {}) {
    return new Promise((resolve, reject) => {
      const h = { CSeq: this.cseq++, 'User-Agent': 'nvr-viewer', ...headers };
      let msg = `${method} ${url} RTSP/1.0\r\n`;
      for (const k in h) msg += `${k}: ${h[k]}\r\n`;
      const t = setTimeout(() => reject(new Error(method + ' timeout')), 8000);
      this.pending.push(r => { clearTimeout(t); resolve(r); });
      this.sock.write(msg + '\r\n');
    });
  }
  async start() {
    this.sock = net.connect(RTSP_PORT, HOST);
    this.sock.setNoDelay(true);
    this.sock.on('data', d => this.onData(d));
    this.sock.on('close', () => this.stop());
    this.sock.on('error', () => this.stop());
    await new Promise((res, rej) => { this.sock.once('connect', res); this.sock.once('error', rej); });
    const url = this.url;
    await this.req('OPTIONS', url);
    const d = await this.req('DESCRIBE', url, { Accept: 'application/sdp' });
    if (!/200/.test(d.head.split('\r\n')[0])) throw new Error('DESCRIBE ' + d.head.split('\r\n')[0]);
    const base = (/content-base:\s*(\S+)/i.exec(d.head) || [])[1] || url;
    const vsec = d.body.split(/m=/).find(s => s.startsWith('video')) || '';
    const ctl = (/a=control:(\S+)/.exec(vsec) || [])[1] || 'trackID=3';
    const sp = /sprop-parameter-sets=([^,;\s]+),([^;\s]+)/.exec(vsec);
    if (sp) { this.sps = Buffer.from(sp[1], 'base64'); this.pps = Buffer.from(sp[2], 'base64'); }
    const trackUrl = /^rtsp:/.test(ctl) ? ctl : base.replace(/\/$/, '') + '/' + ctl;
    const s = await this.req('SETUP', trackUrl, { Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    if (!/200/.test(s.head.split('\r\n')[0])) throw new Error('SETUP ' + s.head.split('\r\n')[0]);
    this.session = ((/session:\s*([^;\r\n]+)/i.exec(s.head) || [])[1] || '').trim();
    const p = await this.req('PLAY', base, { Session: this.session, Range: 'npt=0-' });
    if (!/200/.test(p.head.split('\r\n')[0])) throw new Error('PLAY ' + p.head.split('\r\n')[0]);
    console.log(`[${this.ch}/${this.sub}] playing`);
    this.ka = setInterval(() => { try { this.sock.write(`OPTIONS ${url} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\nSession: ${this.session}\r\n\r\n`); } catch {} }, 20000);
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (!b.length) return;
      if (b[0] === 0x24) {
        if (b.length < 4) return;
        const len = b.readUInt16BE(2);
        if (b.length < 4 + len) return;
        const chn = b[1], pkt = b.subarray(4, 4 + len);
        this.buf = b.subarray(4 + len);
        if (chn === 0) this.onRtp(pkt);
      } else {
        const i = b.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = b.subarray(0, i).toString();
        const m = /content-length:\s*(\d+)/i.exec(head), cl = m ? +m[1] : 0;
        if (b.length < i + 4 + cl) return;
        const body = b.subarray(i + 4, i + 4 + cl).toString();
        this.buf = b.subarray(i + 4 + cl);
        const cb = this.pending.shift();
        if (cb) cb({ head, body });
      }
    }
  }
  onRtp(pkt) {
    if (pkt.length < 13) return;
    const cc = pkt[0] & 15;
    let off = 12 + cc * 4;
    if (pkt[0] & 0x10) off += 4 + pkt.readUInt16BE(off + 2) * 4;
    const marker = (pkt[1] & 0x80) !== 0, ts = pkt.readUInt32BE(4), pl = pkt.subarray(off);
    if (!pl.length) return;
    if (this.curTs !== null && ts !== this.curTs) this.flush();
    this.curTs = ts;
    const t = pl[0] & 31;
    if (t >= 1 && t <= 23) this.nals.push(pl);
    else if (t === 24) {
      let p = 1;
      while (p + 2 <= pl.length) { const l = pl.readUInt16BE(p); p += 2; this.nals.push(pl.subarray(p, p + l)); p += l; }
    } else if (t === 28 && pl.length > 2) {
      const fu = pl[1];
      if (fu & 0x80) this.fu = [Buffer.from([(pl[0] & 0xe0) | (fu & 31)])];
      if (this.fu) { this.fu.push(pl.subarray(2)); if (fu & 0x40) { this.nals.push(Buffer.concat(this.fu)); this.fu = null; } }
    }
    if (marker) this.flush();
  }
  flush() {
    const nals = this.nals; this.nals = [];
    if (!nals.length) return;
    let key = false, hasPs = false;
    for (const n of nals) {
      const t = n[0] & 31;
      if (t === 5) key = true;
      if (t === 7) { this.sps = n; hasPs = true; }
      if (t === 8) { this.pps = n; hasPs = true; }
    }
    const parts = [Buffer.from([key ? 1 : 0])];
    if (key && !hasPs && this.sps && this.pps) parts.push(SC, this.sps, SC, this.pps);
    for (const n of nals) parts.push(SC, n);
    const msg = Buffer.concat(parts);
    if (key) this.lastKey = msg;
    for (const c of this.clients) c.send(msg);
  }
  addClient(c) {
    clearTimeout(this.stopTimer);
    this.clients.add(c);
    if (this.lastKey) c.send(this.lastKey);
  }
  removeClient(c) {
    this.clients.delete(c);
    if (!this.clients.size) this.stopTimer = setTimeout(() => this.stop(), 10000);
  }
  stop() {
    if (this.dead) return;
    this.dead = true;
    clearInterval(this.ka); clearTimeout(this.stopTimer);
    try { this.sock.destroy(); } catch {}
    streams.delete(this.key);
    for (const c of this.clients) c.close();
  }
}

// ---- minimal WebSocket (server -> client binary only) ----
class WS {
  constructor(sock) {
    this.sock = sock; this.closed = false;
    sock.on('data', d => {
      for (let i = 0; i + 1 < d.length;) {
        const op = d[i] & 15, len = d[i + 1] & 127;
        if (op === 8) { this.close(); return; }
        if (len > 125 || !(d[i + 1] & 128) || i + 6 + len > d.length) return;
        if (op === 1 && len >= 1 && this.onmsg) { let s = ''; for (let k = 0; k < len; k++) s += String.fromCharCode(d[i + 6 + k] ^ d[i + 2 + (k & 3)]); this.onmsg(s); }
        i += 6 + len;
      }
    });
    sock.on('close', () => { this.closed = true; this.onclose && this.onclose(); });
    sock.on('error', () => sock.destroy());
  }
  send(buf, lossless = false) {
    if (this.closed) return;
    if (!lossless && this.sock.writableLength > 4e6) return; // drop frames for slow clients
    const n = buf.length;
    let h;
    if (n < 126) h = Buffer.from([0x82, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x82; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x82; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    this.sock.write(Buffer.concat([h, buf]));
  }
  close() { if (!this.closed) { this.closed = true; try { this.sock.end(Buffer.from([0x88, 0])); } catch {} } }
}

// ---- HTTP API ----
const LOOPBACK = /^(127\.|localhost$|::1$)/.test(BIND);
// Host header must be loopback, or (when bound beyond loopback) a bare IPv4 / allow-listed name on our port. Blocks DNS rebinding.
const hostOk = h => {
  if (typeof h !== 'string') return false;
  if (h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`) return true;
  if (LOOPBACK) return false;
  const m = /^(.+):(\d+)$/.exec(h);
  if (!m || +m[2] !== PORT) return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(m[1]) || ALLOW_HOSTS.includes(m[1].toLowerCase());
};
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', d => { b += d; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } }); });
const fmtT = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const hexMB = v => parseInt(v, 16);
async function channels(A) {
  if (A.chanCache) return A.chanCache;
  const S = A.sofia;
  try {
    const r = await S.getConfig('AVEnc.VideoWidget');
    const arr = r['AVEnc.VideoWidget'];
    const n = S.conn && S.conn.info && S.conn.info.ChannelNum || arr.length;
    A.chanCache = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: (arr[i] && arr[i].ChannelTitle && arr[i].ChannelTitle.Name) || `Camera ${i + 1}` }));
  } catch { return cfg.channels || [1, 2, 3, 4].map(id => ({ id, name: `Camera ${id}` })); }
  return A.chanCache;
}
const ptzDog = new Map();
const PTZ_CMDS = new Set(['DirectionUp', 'DirectionDown', 'DirectionLeft', 'DirectionRight', 'DirectionLeftUp', 'DirectionLeftDown', 'DirectionRightUp', 'DirectionRightDown', 'ZoomTile', 'ZoomWide', 'FocusNear', 'FocusFar', 'IrisSmall', 'IrisLarge', 'GotoPreset', 'SetPreset', 'ClearPreset']);


// ---- camera auto search on a /24 (ONVIF + Xiongmai UDP probes and a TCP port scan) ----
const dgram = require('dgram');
const privateNet = s => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s || ''); if (!m) return false; const [a, b, c] = m.slice(1).map(Number); return a <= 255 && b <= 255 && c <= 255 && (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)); };
const onvifProbe = () => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>uuid:${crypto.randomUUID()}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`);
async function discover(subnet, keepHost) {
  const found = new Map();
  const add = (ip, o) => { const cur = found.get(ip) || { ip, ports: [] }; const ports = cur.ports; Object.assign(cur, o); cur.ports = ports; found.set(ip, cur); return cur; };
  const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const udp = new Promise(done => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => {});
    s.on('message', (m, r) => {
      if (!r.address.startsWith(subnet + '.')) return;
      const t = m.toString('utf8');
      if (t.includes('ProbeMatches')) {
        const x = /<[\w:]*XAddrs>([^<]+)/.exec(t), sc = (/<[\w:]*Scopes>([^<]+)/.exec(t) || [])[1] || '';
        const nm = /onvif:\/\/www\.onvif\.org\/name\/(\S+)/.exec(sc), hw = /onvif:\/\/www\.onvif\.org\/hardware\/(\S+)/.exec(sc);
        const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
        add(r.address, { kind: 'ONVIF', name: nm && dec(nm[1]), model: hw && dec(hw[1]), xaddr: x && x[1].trim().split(/\s+/)[0] });
      } else {
        try { const j = JSON.parse(m.subarray(20).toString().replace(/\0/g, '').trim()); const n = j['NetWork.NetCommon'] || j; add(r.address, { kind: 'Xiongmai', name: n.HostName, model: n.SN, port: n.TCPPort }); } catch {}
      }
    });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch {}
      const xm = Buffer.alloc(20); xm[0] = 0xff; xm.writeUInt16LE(1530, 14);
      const ov = onvifProbe();
      for (const ip of hosts) { s.send(ov, 3702, ip, () => {}); s.send(xm, 34569, ip, () => {}); }
      s.send(xm, 34569, subnet + '.255', () => {});
      setTimeout(() => { try { s.close(); } catch {} done(); }, 3500);
    });
  });
  const PORTS = [80, 554, 8000, 8080, 8899, 34567], jobs = [];
  for (const ip of hosts) for (const p of PORTS) jobs.push([ip, p]);
  let k = 0;
  const worker = async () => {
    while (k < jobs.length) {
      const [ip, p] = jobs[k++];
      await new Promise(res => {
        const so = net.connect({ host: ip, port: p }), t = setTimeout(() => { so.destroy(); res(); }, 700);
        so.on('connect', () => { clearTimeout(t); add(ip, {}).ports.push(p); so.destroy(); res(); });
        so.on('error', () => { clearTimeout(t); res(); });
      });
    }
  };
  await Promise.all([udp, ...Array.from({ length: 150 }, worker)]);
  return [...found.values()]
    .map(d => ({ ...d, kind: d.kind || (d.ports.includes(34567) ? 'Xiongmai' : d.ports.includes(554) || d.ports.includes(8899) ? 'RTSP' : 'Web') }))
    .filter(d => d.kind !== 'Web' && (keepHost || d.ip !== HOST))
    .sort((a, b) => +a.ip.split('.')[3] - +b.ip.split('.')[3]);
}


// ---- NVR user & group management (accounts live inside the NVR itself) ----
const NAME_RE = /^[A-Za-z0-9_.\-]{1,16}$/;
const oops = (m, c = 400) => Object.assign(new Error(m), { status: c });
const pubUser = u => ({ name: u.Name, group: u.Group, memo: u.Memo || '', authority: u.AuthorityList || [], reserved: !!u.Reserved, sharable: u.Sharable !== false });
const pubGroup = g => ({ name: g.Name, memo: g.Memo || '', authority: g.AuthorityList || [] });
async function userData(S) {
  const [ur, gr, ar] = await Promise.all([S.call(1472, { Name: 'OPUserList' }), S.call(1474, { Name: 'OPGroupList' }), S.call(1470, { Name: 'OPAuthorityList' })]);
  return { users: ur.Users || [], groups: gr.Groups || [], auths: ar.AuthorityList || [] };
}
const canAccount = u => !!(u && (u.AuthorityList || []).includes('Account'));
function pickAuth(list, all) {
  if (!Array.isArray(list)) throw oops('Bad permission list');
  const bad = list.find(x => !all.includes(x));
  if (bad) throw oops('Unknown permission: ' + String(bad).slice(0, 30));
  return [...new Set(list)];
}
function checkPass(pw) {
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 32) throw oops('Password must be 6\u201332 characters');
  return pw;
}
async function userAdmin(A, S, b) {
  const d = await userData(S), me = d.users.find(u => u.Name === A.user), find = n => d.users.find(u => u.Name === n);
  const need = () => { if (!canAccount(me)) throw oops('Your account may not manage users', 403); };
  const wr = async (mid, body) => { const r = await S.call(mid, body); if (r.Ret !== 100) throw oops(`NVR refused the change (Ret ${r.Ret})`, 502); return r; };
  const lockout = after => { if (!after.some(canAccount)) throw oops('That would leave nobody able to manage accounts'); };
  const userBody = (u, name) => ({ AuthorityList: u.AuthorityList, Group: u.Group, Memo: u.Memo || '', Name: name || u.Name, Password: u.Password, Reserved: !!u.Reserved, Sharable: u.Sharable !== false });
  const name = String(b.name || '');
  // The NVR only accepts a new user with the group's own permissions; extra/fewer ones are applied with a modify right after.
  const addUser = async (u, g, tries = 1) => {
    const first = { ...u, AuthorityList: g.AuthorityList };
    let ok = false;
    for (let i = 0; i < tries && !ok; i++) { if (i) await new Promise(r => setTimeout(r, 1000)); ok = (await S.call(1482, { Name: 'OPUserAdd', User: first })).Ret === 100; }
    if (!ok) return false;
    if (JSON.stringify([...u.AuthorityList].sort()) !== JSON.stringify([...g.AuthorityList].sort())) await wr(1484, { Name: 'OPUserModify', UserName: u.Name, User: u });
    return true;
  };
  const delUser = async u => {   // 104 = still signed in; the NVR needs a moment to drop their session
    for (let i = 0; i < 5; i++) {
      const r = await S.call(1486, { Name: u.Name, User: u });
      if (r.Ret === 100) return;
      if (r.Ret !== 104) throw oops(`NVR refused the change (Ret ${r.Ret})`, 502);
      await new Promise(r => setTimeout(r, 1200));
    }
    throw oops('That user is still signed in at the NVR. Try again in a minute.', 409);
  };
  const endViewer = n => { const a2 = accounts.get(n); if (a2 && n !== A.user) dropAccount(a2); };   // a signed-in user cannot be deleted
  switch (b.action) {
    case 'password': {   // change your own password (the NVR wants the old one)
      checkPass(b.new);
      if (typeof b.old !== 'string' || !b.old) throw oops('Enter your current password');
      const r = await S.call(1488, { EncryptType: 'MD5', NewPassWord: sofiaHash(b.new), PassWord: sofiaHash(b.old), UserName: A.user });
      if (r.Ret === 106) throw oops('Current password is wrong');
      if (r.Ret !== 100) throw oops(`NVR refused the change (Ret ${r.Ret})`, 502);
      { const l = syncLogin.get(); if (l && l.user === A.user) syncLogin.set(A.user, b.new); }   // keep the saved time-sync login working
      return { ret: 100, relogin: true };
    }
    case 'add': {
      need();
      if (!NAME_RE.test(name)) throw oops('User name: 1\u201316 letters, digits, . _ -');
      if (d.users.some(u => u.Name.toLowerCase() === name.toLowerCase())) throw oops('That user already exists');
      checkPass(b.password);
      const g = d.groups.find(x => x.Name === b.group);
      if (!g) throw oops('Pick a group');
      const u = { AuthorityList: pickAuth(b.authority || g.AuthorityList, d.auths), Group: g.Name, Memo: String(b.memo || '').slice(0, 32), Name: name, Password: sofiaHash(b.password), Reserved: false, Sharable: b.sharable !== false };
      if (!(await addUser(u, g))) throw oops('NVR refused the new user', 502);
      return { ret: 100 };
    }
    case 'modify': {
      need();
      const u = find(name); if (!u) throw oops('No such user', 404);
      const g = d.groups.find(x => x.Name === (b.group || u.Group)); if (!g) throw oops('Pick a group');
      const nu = { ...userBody(u), AuthorityList: pickAuth(b.authority || u.AuthorityList, d.auths), Group: g.Name, Memo: String(b.memo == null ? u.Memo || '' : b.memo).slice(0, 32), Sharable: b.sharable == null ? u.Sharable !== false : !!b.sharable };
      if (name === A.user && !nu.AuthorityList.includes('Account')) throw oops('You cannot remove your own "Manage accounts" permission');
      lockout(d.users.map(x => x.Name === name ? { ...x, AuthorityList: nu.AuthorityList } : x));
      await wr(1484, { Name: 'OPUserModify', UserName: name, User: nu });
      const a2 = accounts.get(name); if (a2 && name !== A.user) dropAccount(a2);   // rights change at next sign-in
      return { ret: 100 };
    }
    case 'delete': {
      need();
      const u = find(name); if (!u) throw oops('No such user', 404);
      if (name === A.user) throw oops('You cannot delete the account you are signed in with');
      if (u.Reserved) throw oops('That account is built in');
      lockout(d.users.filter(x => x.Name !== name));
      endViewer(name);
      await delUser(u);
      return { ret: 100 };
    }
    case 'reset': {   // the NVR only lets a user change their own password, so an admin reset = delete + re-add
      need();
      const u = find(name); if (!u) throw oops('No such user', 404);
      if (name === A.user) throw oops('Use "Change my password" for your own account');
      if (u.Reserved) throw oops('That account is built in');
      checkPass(b.password);
      const g = d.groups.find(x => x.Name === u.Group) || { AuthorityList: u.AuthorityList };
      endViewer(name);
      await delUser(u);
      if (!(await addUser({ ...userBody(u), Password: sofiaHash(b.password) }, g, 4))) {
        const back = await addUser(userBody(u), g, 4);   // put the old one back
        throw oops(back ? 'NVR would not accept the new password; the old account was restored' : 'NVR removed the account and would not re-create it. Add the user again.', 502);
      }
      return { ret: 100 };
    }
    case 'gadd': case 'gmodify': {
      need();
      if (!NAME_RE.test(name)) throw oops('Group name: 1\u201316 letters, digits, . _ -');
      const old = d.groups.find(g => g.Name === name);
      const g = { AuthorityList: pickAuth(b.authority || [], d.auths), Memo: String(b.memo || '').slice(0, 32), Name: name };
      if (b.action === 'gadd') {
        if (d.groups.some(x => x.Name.toLowerCase() === name.toLowerCase())) throw oops('That group already exists');
        await wr(1476, { Name: 'OPGroupAdd', Group: g });
      } else {
        if (!old) throw oops('No such group', 404);
        if (name === 'admin' && !g.AuthorityList.includes('Account')) throw oops('The admin group must keep the Account permission');
        await wr(1478, { Name: 'OPGroupModify', GroupName: name, Group: g });
      }
      return { ret: 100 };
    }
    case 'gdelete': {
      need();
      const g = d.groups.find(x => x.Name === name); if (!g) throw oops('No such group', 404);
      if (name === 'admin' || name === 'user') throw oops('That group is built in');
      if (d.users.some(u => u.Group === name)) throw oops('Move its users to another group first');
      await wr(1480, { Name: name, Group: g });
      return { ret: 100 };
    }
  }
  throw oops('bad action');
}


// ---- settings backup & restore (only a fixed list of config names is ever read or written) ----
const BK_FIXED = ['General.General', 'General.Location', 'General.AutoMaintain', 'System.TimeZone', 'fVideo.GUISet', 'fVideo.Tour', 'fVideo.OSDInfo', 'AVEnc.VideoWidget',
  'NetWork.NetCommon', 'NetWork.NetDHCP', 'NetWork.NetDNS', 'NetWork.NetPPPoE', 'NetWork.NetNTP', 'NetWork.NetEmail', 'NetWork.NetFTP', 'NetWork.NetDDNS', 'NetWork.NetARSP', 'NetWork.Upnp', 'NetWork.RTSP', 'NetWork.NetIPFilter',
  'NetWork.NetMobile', 'NetWork.NetKeyboard', 'NetWork.PMS', 'NetWork.SPVMN', 'NetWork.CloudStorage', 'NetWork.RemoteDeviceV3', 'Alarm.AlarmOut', 'Alarm.NetAlarm', 'Alarm.NetAbort', 'Alarm.IPCAlarm'];
const BK_PER_CH = ['AVEnc.VideoColor', 'Camera.Param', 'Record', 'Detect.MotionDetect', 'Detect.BlindDetect', 'Detect.LossDetect', 'Uart.PTZ', 'Uart.Comm'];
const bkNames = n => [...BK_FIXED, ...BK_PER_CH.flatMap(b => Array.from({ length: n }, (_, i) => `${b}.[${i}]`))];
async function cfgValue(S, name) {
  const r = await S.getConfig(name);
  const k = name in r ? name : Object.keys(r).find(x => !['Name', 'Ret', 'SessionID', 'raw'].includes(x));
  return r.Ret === 100 && k && r[k] != null ? r[k] : undefined;
}
async function restoreCfg(A, S, b) {
  const n = (await channels(A)).length, ok = new Set(bkNames(n));
  const cfg = b.config && typeof b.config === 'object' ? b.config : null;
  if (!cfg) throw oops('Not a backup file');
  const names = (Array.isArray(b.names) ? b.names : Object.keys(cfg)).filter(x => typeof x === 'string');
  const items = [];
  for (const name of Object.keys(cfg)) {
    if (!ok.has(name)) { items.push({ name, state: 'skipped' }); continue; }
    const cur = await cfgValue(S, name);
    items.push({ name, state: cur === undefined ? 'missing' : JSON.stringify(cur) === JSON.stringify(cfg[name]) ? 'same' : 'differs' });
  }
  if (b.action !== 'apply') return { items };
  const done = [], failed = [];
  for (const it of items) {
    if (it.state !== 'differs' || !names.includes(it.name)) continue;
    let v = JSON.parse(JSON.stringify(cfg[it.name]));
    if (it.name === 'NetWork.NetCommon') { const cur = await cfgValue(S, it.name); if (cur && cur.MAC) v.MAC = cur.MAC; }   // never copy a MAC address between devices
    const r = await S.setConfig(it.name, v);
    (r.Ret === 100 ? done : failed).push(r.Ret === 100 ? it.name : { name: it.name, ret: r.Ret });
  }
  return { done, failed, items };
}


// ---- keep the NVR clock in step with this computer ----
// Runs through whoever is signed in. If the user also ticked "keep going when nobody is signed in", the login of
// that account is kept in timesync-login.json (plain text, never sent to the browser) and used for the check.
const tsState = { checkedAt: 0, lastCheck: null, driftSec: null, lastSet: null, error: null };
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
const SYNC_LOGIN_FILE = path.join(__dirname, 'timesync-login.json');
const syncLogin = {
  get() { try { const j = JSON.parse(fs.readFileSync(SYNC_LOGIN_FILE, 'utf8')); return j && j.user && typeof j.password === 'string' ? j : null; } catch { return null; } },
  set(user, password) { fs.writeFileSync(SYNC_LOGIN_FILE, JSON.stringify({ user, password }), { mode: 0o600 }); tsState.badLogin = false; },
  clear() { try { fs.unlinkSync(SYNC_LOGIN_FILE); } catch {} }
};
async function timeSyncTick() {
  const ts = appSettings.timeSync;
  if (!ts || !ts.enabled || !HOST || Date.now() - tsState.checkedAt < ts.everyMin * 60e3) return;
  let sofia, own = false;
  const a = [...accounts.values()].find(x => x.sofia.conn && !x.sofia.conn.closed);
  if (a) sofia = a.sofia;
  else {
    const l = syncLogin.get();
    if (!l || tsState.badLogin) return;
    sofia = new Sofia({ host: HOST, sofiaPort: SOFIA_PORT, user: l.user, password: l.password }); own = true;
  }
  tsState.checkedAt = Date.now();
  try {
    const q = await sofia.call(1452, { Name: 'OPTimeQuery' });
    const nvr = new Date(String(q.OPTimeQuery).replace(' ', 'T')).getTime();
    if (!nvr) throw new Error('could not read the NVR clock');
    const drift = Math.round((Date.now() - nvr) / 1000);
    tsState.driftSec = drift; tsState.lastCheck = Date.now(); tsState.error = null;
    if (Math.abs(drift) > 2) {
      const r = await sofia.call(1450, { Name: 'OPTimeSetting', OPTimeSetting: fmtT(new Date()) });
      if (r.Ret === 100) { tsState.lastSet = Date.now(); console.log(`time sync: NVR was ${drift}s off, corrected`); }
      else { tsState.error = `NVR refused the new time (Ret ${r.Ret})`; }
    }
  } catch (e) {
    if (own && /login failed/.test(e.message)) { tsState.badLogin = true; tsState.error = 'The saved login no longer works. Open this page while signed in and save it again.'; }   // do not retry: repeated wrong passwords can lock the NVR account
    else { tsState.error = e.message; tsState.checkedAt = Date.now() - ts.everyMin * 60e3 + 60e3; }   // retry in a minute
  } finally { if (own) sofia.shutdown(); }
}
setInterval(() => timeSyncTick().catch(() => {}), 20e3).unref();

async function api(req, res, u, sess) {
  const A = sess.acct, S = A.sofia;
  const q = u.searchParams, p = u.pathname;
  if (req.method === 'POST' && (req.headers['x-nvr'] !== '1' || !/application\/json/.test(req.headers['content-type'] || ''))) return json(res, { error: 'bad request' }, 400);
  if (p === '/api/channels') return json(res, await channels(A));
  if (p === '/api/state') return json(res, { ok: !!(S.conn && !S.conn.closed) });
  if (p === '/api/info') {
    const [si, st, tm, gen] = await Promise.all([S.call(1020, { Name: 'SystemInfo' }), S.call(1020, { Name: 'StorageInfo' }), S.call(1452, { Name: 'OPTimeQuery' }), S.getConfig('General.General')]);
    return json(res, { system: si.SystemInfo, storage: st.StorageInfo, time: tm.OPTimeQuery, general: gen['General.General'], login: S.conn && S.conn.info });
  }
  if (p === '/api/discover') {
    const subnet = q.get('subnet') || HOST.split('.').slice(0, 3).join('.');
    if (!privateNet(subnet)) return json(res, { error: 'Use a private network, e.g. 192.168.30' }, 400);
    return json(res, { subnet, devices: await discover(subnet) });
  }
  if (p === '/api/cfg' && req.method === 'GET') {
    const name = q.get('name') || '';
    if (!/^[A-Za-z0-9_.\[\]]{1,60}$/.test(name)) return json(res, { error: 'bad name' }, 400);
    const r = await S.getConfig(name);
    const vk = name in r ? name : Object.keys(r).find(k => !['Name', 'Ret', 'SessionID', 'raw'].includes(k));
    return json(res, { ret: r.Ret, value: vk ? r[vk] : undefined, raw: r.raw });
  }
  if (p === '/api/cfg' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^[A-Za-z0-9_.\[\]]{1,60}$/.test(b.name || '') || b.value === undefined) return json(res, { error: 'bad request' }, 400);
    const r = await S.setConfig(b.name, b.value);
    return json(res, { ret: r.Ret });
  }
  if (p === '/api/files') {
    const ch = (+q.get('ch') || 1) - 1, date = q.get('date') || fmtT(new Date()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, { error: 'bad date' }, 400);
    const files = await S.findFiles(ch, `${date} 00:00:00`, `${date} 23:59:59`);
    return json(res, files.map(f => ({ begin: f.BeginTime, end: f.EndTime, size: parseInt(f.FileLength, 16) * 1024, name: f.FileName, type: (/\[([A-Z])\]/.exec(f.FileName) || [])[1] || '?' })));
  }
  if (p === '/api/days') {   // days of a month that have recordings (bit i of the mask = day i+1)
    const ch = (+q.get('ch') || 1) - 1, month = q.get('month') || fmtT(new Date()).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return json(res, { error: 'bad month' }, 400);
    const r = await S.call(1446, { Name: 'OPSCalendar', OPSCalendar: { Channel: ch, Event: '*', FileType: 'h264', Month: +month.slice(5), Year: +month.slice(0, 4) } });
    let mask = r.OPSCalendar ? r.OPSCalendar.Mask : 0;
    if (typeof mask === 'string') mask = parseInt(mask, 16) || 0;
    const days = []; for (let i = 0; i < 31; i++) if ((mask >>> i) & 1) days.push(i + 1);
    return json(res, { ret: r.Ret, days });
  }
  if (p === '/api/logs') {
    const end = q.get('end') || fmtT(new Date()), begin = q.get('begin') || fmtT(new Date(Date.now() - 3 * 864e5));
    const r = await S.call(1442, { Name: 'OPLogQuery', OPLogQuery: { BeginTime: begin, EndTime: end, LogPosition: +q.get('pos') || 0, Type: q.get('type') || 'LogAll' } });
    return json(res, { ret: r.Ret, logs: r.OPLogQuery || [] });
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ hello: true, recent: A.recent.slice(0, 50) })}\n\n`);
    A.sse.add(res); req.on('close', () => A.sse.delete(res));
    return;
  }
  if (p === '/api/ptz' && req.method === 'POST') {
    const b = await readBody(req);
    if (!PTZ_CMDS.has(b.cmd)) return json(res, { error: 'bad cmd' }, 400);
    const ch = (+b.ch || 1) - 1, step = Math.max(1, Math.min(8, +b.step || 5));
    const ptz = stop => S.call(1400, { Name: 'OPPTZControl', OPPTZControl: { Command: b.cmd, Parameter: { AUX: { Number: 0, Status: 'On' }, Channel: ch, MenuOpts: 'Enter', POINT: { bottom: 0, left: 0, right: 0 }, Pattern: 'SetBegin', Preset: stop ? 65535 : (+b.preset || -1), Step: step, Tour: 0 } } });
    const key = A.user + ':' + ch;
    clearTimeout(ptzDog.get(key));
    if (!b.stop) ptzDog.set(key, setTimeout(() => { console.log('ptz watchdog stop', b.cmd); ptz(true).catch(() => {}); }, 10000));   // never let a camera run away
    console.log('ptz', b.cmd, b.stop ? 'STOP' : 'start', 'ch', ch + 1);
    const r = await ptz(!!b.stop);
    return json(res, { ret: r.Ret });
  }
  if (p === '/api/users' && req.method === 'GET') {
    const d = await userData(S), me = d.users.find(u => u.Name === A.user), ok = canAccount(me);
    return json(res, { me: { name: A.user, group: me && me.Group, canManage: ok }, authorities: d.auths, users: (ok ? d.users : d.users.filter(u => u.Name === A.user)).map(pubUser), groups: ok ? d.groups.map(pubGroup) : [] });
  }
  if (p === '/api/users' && req.method === 'POST') {
    try {
      const r = await userAdmin(A, S, await readBody(req));
      if (r.relogin) { dropAccount(A); res.setHeader('Set-Cookie', 'nvr_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); }
      return json(res, r);
    } catch (e) { if (e.status) return json(res, { error: e.message }, e.status); throw e; }
  }
  if (p === '/api/rtsp' && req.method === 'GET') {   // link for VLC, Frigate, etc. The password is only included when asked for.
    const n = (await channels(A)).length, ch = +q.get('ch') || 1, sub = q.get('sub') === '1' ? 1 : 0;
    if (!(ch >= 1 && ch <= n)) return json(res, { error: 'bad channel' }, 400);
    const enc = s => /^[\w.\-]*$/.test(s) ? s : encodeURIComponent(s);
    const pw = q.get('pw') === '1' ? enc(A.password) : 'YOUR_PASSWORD';
    const via = q.get('via') === 'app' && RELAY_PORT, where = via ? `${(req.headers.host || '127.0.0.1').replace(/:\d+$/, '')}:${RELAY_PORT}` : `${HOST}:${RTSP_PORT}`;
    return json(res, { relay: !!RELAY_PORT, via: !!via, url: `rtsp://${where}/user=${enc(A.user)}&password=${pw}&channel=${ch}&stream=${sub}.sdp?real_stream`, host: HOST, port: RTSP_PORT });
  }
  if (p === '/api/backup' && req.method === 'GET') {
    const n = (await channels(A)).length, config = {};
    for (const name of bkNames(n)) { const v = await cfgValue(S, name); if (v !== undefined) config[name] = v; }
    const si = (await S.call(1020, { Name: 'SystemInfo' }).catch(() => ({}))).SystemInfo || {};
    const body = JSON.stringify({ format: 'nvr-viewer-backup', version: 1, created: new Date().toISOString(), host: HOST, device: { serial: si.SerialNo, firmware: si.SoftWareVersion, build: si.BuildTime }, config }, null, 1);
    const stamp = fmtT(new Date()).replace(/[: ]/g, m => m === ' ' ? '-' : '').replace(/-/g, '');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="nvr-backup-${stamp}.json"`, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  if (p === '/api/restore' && req.method === 'POST') {
    try {
      const me = (await userData(S)).users.find(u => u.Name === A.user);
      if (!(me && ((me.AuthorityList || []).includes('ImExport') || canAccount(me)))) return json(res, { error: 'Your account may not import settings' }, 403);
      return json(res, await restoreCfg(A, S, await readBody(req)));
    } catch (e) { if (e.status) return json(res, { error: e.message }, e.status); throw e; }
  }
  const tsReply = () => { const l = syncLogin.get(); return { ...appSettings.timeSync, background: l ? { user: l.user } : null, you: A.user, state: tsState }; };
  if (p === '/api/timesync' && req.method === 'GET') return json(res, tsReply());
  if (p === '/api/timesync' && req.method === 'POST') {
    const b = await readBody(req);
    if (![5, 15, 60, 360, 1440].includes(+b.everyMin)) return json(res, { error: 'bad interval' }, 400);
    appSettings.timeSync = { enabled: !!b.enabled, everyMin: +b.everyMin };
    // background: keep the signed-in account's login on disk so the check also runs when nobody is signed in
    if (b.background && appSettings.timeSync.enabled) { const l = syncLogin.get(); if (!l || b.replace || l.user === A.user) syncLogin.set(A.user, A.password); }   // changing only the interval never swaps the saved account
    else syncLogin.clear();
    tsState.checkedAt = 0; tsState.error = null; saveSettings();
    timeSyncTick().catch(() => {});
    return json(res, tsReply());
  }
  if (p === '/api/time' && req.method === 'POST') {
    const b = await readBody(req);
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(b.time || '')) return json(res, { error: 'bad time' }, 400);
    const r = await S.call(1450, { Name: 'OPTimeSetting', OPTimeSetting: b.time });
    return json(res, { ret: r.Ret });
  }
  if (p === '/api/machine' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.action !== 'Reboot' || b.confirm !== 'REBOOT') return json(res, { error: 'confirmation required' }, 400);
    const r = await S.call(1450, { Name: 'OPMachine', OPMachine: { Action: 'Reboot' } });
    return json(res, { ret: r.Ret });
  }
  if (p === '/api/storage' && req.method === 'POST') {
    const b = await readBody(req);
    if (!['Clear', 'SetType', 'Recover'].includes(b.action)) return json(res, { error: 'bad action' }, 400);
    if (b.action === 'Clear' && b.confirm !== 'FORMAT') return json(res, { error: 'confirmation required' }, 400);
    const r = await S.call(1460, { Name: 'OPStorageManager', OPStorageManager: { Action: b.action, PartNo: +b.part || 0, SerialNo: +b.serial || 0, Type: b.type || 'Data' } });
    return json(res, { ret: r.Ret });
  }
  if (p === '/api/download') {   // one recording as MP4 (H.264 video, real frame rate)
    const name = q.get('file') || '';
    if (!/^\/idea\d+\/[\d-]+\/\d+\/[\w.\-\[\]@]+\.h264$/.test(name)) return json(res, { error: 'bad file' }, 400);
    const c = await S.newConn();
    const frames = []; let fps = 0, idle, finished = false;
    const done = () => {
      if (finished) return; finished = true; clearTimeout(idle); c.close();
      try {
        const mp4 = muxH264(frames, fps || 25);
        const fn = name.split('/').pop().replace(/\.h264$/, '').replace(/[^\w.\-]/g, '_') + '.mp4';
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length, 'Content-Disposition': `attachment; filename="${fn}"` });
        res.end(mp4);
      } catch (e) { if (!res.headersSent) json(res, { error: e.message }, 502); else res.end(); }
    };
    const demux = new XMDemux(f => { if (f.fps) fps = f.fps; frames.push({ key: f.key, data: Buffer.from(f.data) }); });
    c.on('media', d => { demux.push(d); clearTimeout(idle); idle = setTimeout(done, 2500); });
    req.on('close', () => { finished = true; clearTimeout(idle); c.close(); });
    await startPlayback(c, name, q.get('begin'), q.get('end'));
    idle = setTimeout(done, 8000);
    return;
  }
  json(res, { error: 'not found' }, 404);
}


// ---- NVR address: set from the web (first run, or later from Settings / setup page) ----
const os = require('os');
const CFG_FILE = path.join(__dirname, 'config.json');
const tcpOpen = (host, port, ms = 2500) => new Promise(res => {
  const s = net.connect({ host, port }), t = setTimeout(() => { s.destroy(); res(false); }, ms);
  s.on('connect', () => { clearTimeout(t); s.destroy(); res(true); });
  s.on('error', () => { clearTimeout(t); res(false); });
});
const identify = host => new Promise(res => {   // ask the device for its name (Xiongmai UDP discovery, best effort)
  const s = dgram.createSocket('udp4'), done = v => { clearTimeout(t); try { s.close(); } catch {} res(v); }, t = setTimeout(() => done(null), 1500);
  s.on('error', () => done(null));
  s.on('message', m => { try { const j = JSON.parse(m.subarray(20).toString().replace(/\0/g, '').trim()), n = j['NetWork.NetCommon'] || j; done({ name: n.HostName, serial: n.SN }); } catch { done(null); } });
  const xm = Buffer.alloc(20); xm[0] = 0xff; xm.writeUInt16LE(1530, 14);
  s.send(xm, 34569, host, e => { if (e) done(null); });
});
const localSubnets = () => {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) { const s = i.address.split('.').slice(0, 3).join('.'); if (privateNet(s)) out.add(s); }
  return [...out];
};
const validHost = h => typeof h === 'string' && h.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9.\-]*$/.test(h) && h !== 'localhost' && !/^(127|0)\./.test(h) && !/^169\.254\./.test(h)
  && (!/^\d+(\.\d+){3}$/.test(h) || h.split('.').every(x => +x <= 255));
const setupHits = new Map();
const setupOk = ip => { const f = setupHits.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - f.t > 60e3) { f.n = 0; f.t = Date.now(); } f.n++; setupHits.set(ip, f); return f.n <= 30; };
function applyNvrAddress(host, sp, rp) {
  HOST = host; SOFIA_PORT = sp; RTSP_PORT = rp; cfg.host = host; cfg.channels = null;
  if (sp !== 34567) cfg.sofiaPort = sp; else delete cfg.sofiaPort;
  if (rp !== 554) cfg.rtspPort = rp; else delete cfg.rtspPort;
  fs.writeFileSync(CFG_FILE, JSON.stringify({ host: cfg.host, port: PORT, ...(cfg.sofiaPort ? { sofiaPort: cfg.sofiaPort } : {}), ...(cfg.rtspPort ? { rtspPort: cfg.rtspPort } : {}) }, null, 2));
  for (const st of [...streams.values()]) st.stop();
  for (const a of [...accounts.values()]) dropAccount(a);   // everyone signs in again, against the new NVR
  syncLogin.clear();   // the saved login belongs to the old NVR
  Object.assign(tsState, { checkedAt: 0, lastCheck: null, driftSec: null, lastSet: null, error: null });
  console.log(`NVR address set to ${host}:${sp}`);
}

async function authApi(req, res, u, sess) {
  const p = u.pathname;
  if (p === '/api/branding' && req.method === 'GET') return json(res, { name: appSettings.name, host: HOST });
  if (p === '/api/session') return json(res, sess ? { user: sess.user, name: appSettings.name } : { user: null }, sess ? 200 : 401);
  const sip = req.socket.remoteAddress;
  const canChange = async () => !HOST || !!sess || !(await tcpOpen(HOST, SOFIA_PORT));   // locked once set, unless you are signed in or the NVR cannot be reached
  if (p === '/api/setup' && req.method === 'GET') {
    const reachable = HOST ? await tcpOpen(HOST, SOFIA_PORT) : false;
    return json(res, { configured: !!HOST, host: HOST, sofiaPort: SOFIA_PORT, rtspPort: RTSP_PORT, reachable, signedIn: !!sess, canChange: !HOST || !!sess || !reachable, subnets: localSubnets(), name: appSettings.name });
  }
  if (p === '/api/nvr/find' && req.method === 'GET') {
    if (!setupOk(sip)) return json(res, { error: 'Too many requests' }, 429);
    if (!(await canChange())) return json(res, { error: 'Sign in first' }, 403);
    const want = u.searchParams.get('subnet'), subs = want ? (privateNet(want) ? [want] : []) : localSubnets().slice(0, 4);
    if (!subs.length) return json(res, { error: want ? 'Use a private network such as 192.168.1' : 'This computer has no private network address', devices: [] }, 400);
    const found = (await Promise.all(subs.map(s => discover(s, true)))).flat().filter(d => d.kind === 'Xiongmai' || d.ports.includes(34567));
    return json(res, { subnets: subs, devices: found });
  }
  if (req.method !== 'POST' || req.headers['x-nvr'] !== '1' || !/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'bad request' }, 400);
  if (p === '/api/nvr/test' || p === '/api/nvr/set') {
    if (!setupOk(sip)) return json(res, { error: 'Too many requests' }, 429);
    if (!(await canChange())) return json(res, { error: 'Sign in first' }, 403);
    const b = await readBody(req), host = String(b.host || '').trim(), sp = +b.sofiaPort || 34567, rp = +b.rtspPort || 554;
    if (!validHost(host)) return json(res, { error: 'Enter the NVR\'s IP address or host name' }, 400);
    if (!(sp >= 1 && sp <= 65535 && rp >= 1 && rp <= 65535)) return json(res, { error: 'Ports must be 1\u201365535' }, 400);
    const open = await tcpOpen(host, sp, 4000), why = `Nothing answered at ${host}:${sp}. Check the address, that the NVR is on, and that this computer can reach it.`;
    if (p === '/api/nvr/test') return json(res, { ok: open, ident: open ? await identify(host) : null, error: open ? undefined : why });
    if (!open) return json(res, { error: why }, 400);
    applyNvrAddress(host, sp, rp);
    res.setHeader('Set-Cookie', 'nvr_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, { ok: true, host });
  }
  if (p === '/api/logout') {
    if (sess) endSession(sess.token);
    res.setHeader('Set-Cookie', 'nvr_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, { ok: true });
  }
  if (p === '/api/login') {
    const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 60e3) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) return json(res, { error: 'Too many attempts. Wait a minute.' }, 429);
    const b = await readBody(req);
    const user = String(b.user || ''), password = String(b.password || '');
    if (!user || user.length > 32 || password.length > 64) return json(res, { error: 'Enter username and password' }, 400);
    if (!HOST) return json(res, { error: 'The NVR address is not set yet' }, 409);
    const c = new Conn({ host: HOST, sofiaPort: SOFIA_PORT, user, password });
    let ok = false, why = '';
    try { await Promise.race([c.open(), new Promise((_, no) => setTimeout(() => no(new Error('NVR not responding')), 8000))]); ok = true; } catch (e) { why = e.message; }
    c.close();
    if (!ok) {
      f.n++; fails.set(ip, f);
      await new Promise(r => setTimeout(r, 600));
      return json(res, { error: /login failed/.test(why) ? 'Wrong username or password' : why }, 401);
    }
    fails.delete(ip);
    const acct = getAccount(user, password);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { user, acct, last: Date.now() });
    res.setHeader('Set-Cookie', `nvr_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
    acct.sofia.ensure().catch(() => {});
    return json(res, { user, name: appSettings.name });
  }
  if (p === '/api/branding') {
    if (!sess) return json(res, { error: 'unauthorized' }, 401);
    const b = await readBody(req), name = String(b.name || '').trim().slice(0, 40);
    if (!name) return json(res, { error: 'Name required' }, 400);
    appSettings.name = name;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
    return json(res, { name });
  }
  json(res, { error: 'not found' }, 404);
}
const pbBody = (c, action, file, begin, end) => ({ Name: 'OPPlayBack', OPPlayBack: { Action: action, StartTime: begin, EndTime: end, Parameter: { FileName: file, PlayMode: 'ByName', StreamType: 0, Value: 0, TransMode: 'TCP' } }, SessionID: '0x' + c.sess.toString(16).toUpperCase().padStart(8, '0') });
async function startPlayback(c, file, begin, end) {
  const r = await c.req(1424, pbBody(c, 'Claim', file, begin, end), false);
  if (r.Ret !== 100) throw new Error('claim Ret ' + r.Ret);
  c.raw = true;
  c.send(1420, pbBody(c, 'DownloadStart', file, begin, end));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const sess = getSession(req);
    if (u.pathname.startsWith('/api/')) {
      if (['/api/login', '/api/logout', '/api/session', '/api/branding', '/api/setup', '/api/nvr/find', '/api/nvr/test', '/api/nvr/set'].includes(u.pathname)) return await authApi(req, res, u, sess);
      if (!sess) return json(res, { error: 'unauthorized' }, 401);
      return await api(req, res, u, sess);
    }
    let f = u.pathname === '/' ? '/index.html' : u.pathname;
    if (!HOST && (f === '/index.html' || f === '/login.html')) { res.writeHead(302, { Location: '/setup.html' }); return res.end(); }
    if (f === '/index.html' && !sess) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    if (f === '/login.html' && sess) { res.writeHead(302, { Location: '/' }); return res.end(); }
    const full = path.join(PUB, path.normalize(f));
    if (!full.startsWith(PUB + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(full));
  } catch (e) {
    console.log('api error', u.pathname, e.message);
    if (!res.headersSent) json(res, { error: e.message }, 502); else res.end();
  }
});
function wsHandshake(req, sock) {
  const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  return new WS(sock);
}
server.on('upgrade', async (req, sock) => {
  const u = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  if (!hostOk(req.headers.host) || (origin && new URL(origin).host !== req.headers.host)) { sock.destroy(); return; }
  const sess = getSession(req);
  if (!sess) { sock.destroy(); return; }
  const A = sess.acct;
  if (u.pathname === '/wsp') {   // recorded playback: XM stream -> H.264 access units
    const file = u.searchParams.get('file') || '';
    const TS = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, begin = u.searchParams.get('begin') || '', end = u.searchParams.get('end') || '';
    if (!/^\/idea\d+\/[\d-]+\/\d+\/[\w.\-\[\]@]+\.h264$/.test(file) || !TS.test(begin) || !TS.test(end)) { sock.destroy(); return; }
    const from = Math.max(0, Math.min(+u.searchParams.get('from') || 0, 172800));
    const stamp = s => s ? fmtT(new Date(new Date(begin.replace(' ', 'T')).getTime() + s * 1000)) : begin;
    const ws = wsHandshake(req, sock);
    let c;
    try {
      c = await A.sofia.newConn();
      ws.onclose = () => c.close();
      let sentMeta = false, idle, held = false, dropping = false, lastMedia = 0, seekN = 0, demux;
      // The connection stays open after the clip ends (the client may seek back); it closes with the socket.
      const finish = () => ws.send(Buffer.from([3]), true);
      const newDemux = () => new XMDemux(f => {
        if (dropping) return;
        if (!sentMeta && f.key) { sentMeta = true; ws.send(Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ fps: f.fps || 25, t0: f.tm }))]), true); }
        if (!sentMeta) return;
        ws.send(Buffer.concat([Buffer.from([f.key ? 1 : 0]), f.data]), true);
      });
      demux = newDemux();
      c.on('media', d => {
        lastMedia = Date.now();
        if (dropping) return;
        demux.push(d); if (!held) { clearTimeout(idle); idle = setTimeout(finish, 2500); }
        if (ws.sock.writableLength > 8e6) { c.sock.pause(); ws.sock.once('drain', () => c.sock.resume()); }
      });
      // Seek on the SAME NVR session: Stop, let the old stream run dry, Start at the new time.
      // A fresh Claim costs 1-3 s on this NVR whenever another playback session was just closed; Stop/Start costs ~0.3 s.
      const seek = async s => {
        const n = ++seekN; held = false; clearTimeout(idle); dropping = true; c.sock.resume();
        const t0 = Date.now(), at = stamp(s);
        c.send(1420, pbBody(c, 'DownloadStop', file, at, end));
        while (!c.closed && n === seekN && !(Date.now() - lastMedia > 250 && Date.now() - t0 > 250) && Date.now() - t0 < 3000) await sleep(25);
        if (n !== seekN || c.closed) return;
        demux = newDemux(); sentMeta = false; dropping = false;
        c.send(1420, pbBody(c, 'DownloadStart', file, at, end));
        idle = setTimeout(finish, 8000);
      };
      ws.onmsg = m => {
        if (m === 'p') { if (!dropping) { held = true; clearTimeout(idle); c.sock.pause(); } }
        else if (m === 'r') { if (!dropping) { held = false; clearTimeout(idle); idle = setTimeout(finish, 2500); c.sock.resume(); } }
        else if (m[0] === 's' && /^s\d{1,6}$/.test(m)) { const s = Math.min(+m.slice(1), 172800); if (ready) seek(s).catch(() => {}); else pending = s; }
      };
      let ready = false, pending = null;
      await startPlayback(c, file, stamp(from), end);
      ready = true; idle = setTimeout(finish, 8000);
      if (pending != null) seek(pending).catch(() => {});
    } catch (e) { console.log('playback error', e.stack); ws.close(); if (c) c.close(); }
    return;
  }
  if (u.pathname !== '/ws') { sock.destroy(); return; }
  const ch = +u.searchParams.get('ch'), sub = u.searchParams.get('sub') === '0' ? 0 : 1;
  if (!(ch >= 1 && ch <= (await channels(A)).length)) { sock.destroy(); return; }
  const ws = wsHandshake(req, sock);
  const id = `${A.user}/${ch}/${sub}`;
  let s = streams.get(id);
  if (!s) { s = new Stream(ch, sub, A); streams.set(id, s); }
  s.addClient(ws);
  ws.onclose = () => s.removeClient(ws);
});
server.listen(PORT, BIND, () => console.log(`NVR viewer: http://${BIND === '0.0.0.0' ? '127.0.0.1' : BIND}:${PORT}` + (LOOPBACK ? '' : `  (LAN: bound to ${BIND})`)));
if (RELAY_PORT) startRelay({ port: RELAY_PORT, bind: RELAY_BIND, upstream: () => ({ host: HOST, port: RTSP_PORT }), log: console.log });
