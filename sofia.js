// Xiongmai "Sofia"/DVRIP client (TCP 34567). JSON request/response + XM media demux.
const net = require('net'), crypto = require('crypto'), EventEmitter = require('events');

function sofiaHash(p) {
  const d = crypto.createHash('md5').update(p).digest();
  const c = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) s += c[(d[2 * i] + d[2 * i + 1]) % 62];
  return s;
}
const sid = n => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

class Conn extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.seq = 0; this.sess = 0; this.raw = false; this.closed = false; }
  async open() {
    this.sock = net.connect(this.cfg.sofiaPort || 34567, this.cfg.host);
    this.sock.setNoDelay(true);
    this.sock.on('data', d => this.onData(d));
    this.sock.on('close', () => { this.closed = true; this.waiters.splice(0).forEach(w => w.reject(new Error('closed'))); this.emit('close'); });
    this.sock.on('error', () => this.sock.destroy());
    await new Promise((res, rej) => { this.sock.once('connect', res); this.sock.once('error', rej); });
    const r = await this.req(1000, { EncryptType: 'MD5', LoginType: 'DVRIP-Web', PassWord: sofiaHash(this.cfg.password), UserName: this.cfg.user }, false);
    if (r.Ret !== 100) { this.close(); throw new Error('login failed, Ret ' + r.Ret); }
    this.sess = parseInt(r.SessionID, 16);
    this.info = r;
    return r;
  }
  send(mid, obj) {
    const body = Buffer.from(JSON.stringify(obj) + '\n');
    const h = Buffer.alloc(20);
    h[0] = 0xff; h.writeUInt32LE(this.sess, 4); h.writeUInt32LE(this.seq++, 8); h.writeUInt16LE(mid, 14); h.writeUInt32LE(body.length, 16);
    this.sock.write(Buffer.concat([h, body]));
  }
  req(mid, obj, addSid = true, timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('closed'));
      if (addSid) obj = { ...obj, SessionID: sid(this.sess) };
      const w = {
        resolve: (m, body) => {
          clearTimeout(t);
          const txt = body.toString().replace(/\0/g, '').trim();
          try { resolve(JSON.parse(txt)); } catch { resolve({ Ret: -1, raw: txt.slice(0, 500) }); }
        },
        reject: e => { clearTimeout(t); reject(e); }
      };
      const t = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('timeout mid ' + mid)); }, timeout);
      this.waiters.push(w);
      this.send(mid, obj);
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 20) {
      const len = this.buf.readUInt32LE(16);
      if (this.buf.length < 20 + len) break;
      const mid = this.buf.readUInt16LE(14), body = this.buf.subarray(20, 20 + len);
      this.buf = this.buf.subarray(20 + len);
      this.onMsg(mid, body);
    }
  }
  onMsg(mid, body) {
    if (this.raw) { if (mid === 1426) this.emit('media', body); return; }
    if (mid === 1504 || (mid !== 1501 && body.includes('"AlarmInfo"'))) {
      // An alarm push has AlarmInfo at the top level. A config reply that merely mentions it deeper inside (Detect.*, Alarm.*) is a normal reply.
      let o = null; try { o = JSON.parse(body.toString().replace(/\0/g, '').trim()); } catch {}
      if (mid === 1504 || (o && o.AlarmInfo !== undefined)) { if (o) this.emit('alarm', o); return; }
    }
    const w = this.waiters.shift();
    if (w) w.resolve(mid, body);
  }
  close() { this.closed = true; try { this.sock.destroy(); } catch {} }
}

// Shared, auto-reconnecting control connection with serialized calls.
class Sofia extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; this.conn = null; this.chain = Promise.resolve(); this.opening = null; }
  async ensure() {
    if (this.conn && !this.conn.closed) return this.conn;
    if (!this.opening) {
      this.opening = (async () => {
        const c = new Conn(this.cfg);
        await c.open();
        c.on('alarm', a => this.emit('alarm', a));
        c.on('close', () => { clearInterval(this.ka); this.emit('state', false); });
        this.conn = c;
        await c.req(1500, { Name: '' }).catch(() => {});      // subscribe to alarm push
        clearInterval(this.ka);
        this.ka = setInterval(() => this.call(1006, { Name: 'KeepAlive' }).catch(() => {}), 15000);
        this.emit('state', true);
        return c;
      })().finally(() => { this.opening = null; });
    }
    return this.opening;
  }
  call(mid, obj) {
    const run = async () => {
      const c = await this.ensure();
      try { return await c.req(mid, obj); }
      catch (e) { if (/timeout|closed/.test(e.message)) c.close(); throw e; }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  shutdown() { clearInterval(this.ka); if (this.conn) this.conn.close(); this.conn = null; }
  getConfig(name) { return this.call(1042, { Name: name }); }
  async setConfig(name, value) { return this.call(1040, { Name: name, [name]: value }); }
  async newConn() { const c = new Conn(this.cfg); await c.open(); return c; }

  // Recording search, paged (device returns at most 64 per query).
  async findFiles(ch, begin, end, limit = 3000) {
    const out = [], seen = new Set();
    let from = begin;
    for (let i = 0; i < 60 && out.length < limit; i++) {
      const r = await this.call(1440, { Name: 'OPFileQuery', OPFileQuery: { BeginTime: from, EndTime: end, Channel: ch, DriverTypeMask: '0x0000FFFF', Event: '*', StreamType: '0x00000000', Type: 'h264' } });
      const list = r.OPFileQuery;
      if (!Array.isArray(list) || !list.length) break;
      let added = 0;
      for (const f of list) if (!seen.has(f.FileName)) { seen.add(f.FileName); out.push(f); added++; }
      if (list.length < 64 || !added) break;
      from = list[list.length - 1].BeginTime;
    }
    return out;
  }
}

// XM proprietary media stream -> H.264 Annex-B access units.
class XMDemux {
  constructor(cb) { this.b = Buffer.alloc(0); this.cb = cb; }
  push(d) {
    const b = this.b = Buffer.concat([this.b, d]);
    let p = 0;
    for (;;) {
      if (b.length - p < 8) break;
      if (b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1) {
        const t = b[p + 3];
        if (t === 0xFC) {
          if (b.length - p < 16) break;
          const len = b.readUInt32LE(p + 12);
          if (b.length - p < 16 + len) break;
          this.cb({ key: true, fps: b[p + 5], tm: xmTime(b.readUInt32LE(p + 8)), data: b.subarray(p + 16, p + 16 + len) });
          p += 16 + len; continue;
        }
        if (t === 0xFD) {
          const len = b.readUInt32LE(p + 4);
          if (b.length - p < 8 + len) break;
          this.cb({ key: false, data: b.subarray(p + 8, p + 8 + len) });
          p += 8 + len; continue;
        }
        if (t === 0xFA) {
          const len = b.readUInt16LE(p + 6);
          if (b.length - p < 8 + len) break;
          p += 8 + len; continue;
        }
      }
      p++;
    }
    this.b = b.subarray(p);
  }
}
function xmTime(v) {
  const p = n => String(n).padStart(2, '0');
  return `${2000 + (v >>> 26)}-${p((v >>> 22) & 15)}-${p((v >>> 17) & 31)} ${p((v >>> 12) & 31)}:${p((v >>> 6) & 63)}:${p(v & 63)}`;
}

module.exports = { Sofia, Conn, XMDemux, sofiaHash };
