'use strict';
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
async function api(path, body) {
  const o = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NVR': '1' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, o);
  let j; try { j = await r.json(); } catch { j = {}; }
  if (r.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
function toast(msg, cls = '') {
  const t = h('div', { class: cls }, msg); $('#toast').append(t); setTimeout(() => t.remove(), 4500);
}
const today = () => new Date().toLocaleDateString('en-CA');
const pad = n => String(n).padStart(2, '0');
const mmss = s => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
const store = { get: (k, d) => { try { const v = localStorage.getItem('nvr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('nvr.' + k, JSON.stringify(v)); } catch {} } };

/* ---------- H.264 decode (WebCodecs, Annex-B) ---------- */
function codecFrom(d) {
  for (let i = 0; i + 8 < d.length && i < 600; i++)
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3] & 31) === 7)
      return 'avc1.' + [d[i + 4], d[i + 5], d[i + 6]].map(x => x.toString(16).padStart(2, '0')).join('');
  return 'avc1.4d0032';
}
class Dec {
  constructor(cv, onFrame) { this.cv = cv; this.ctx = cv.getContext('2d'); this.onFrame = onFrame; this.d = null; this.n = 0; }
  // returns 1 = accepted, 0 = busy (retry), 2 = skipped (waiting for key frame)
  feed(key, data) {
    if (!this.d) {
      if (!key) return 2;
      this.d = new VideoDecoder({
        output: f => {
          if (this.cv.width !== f.displayWidth || this.cv.height !== f.displayHeight) { this.cv.width = f.displayWidth; this.cv.height = f.displayHeight; }
          this.ctx.drawImage(f, 0, 0); f.close(); this.onFrame && this.onFrame();
        },
        error: e => { console.warn('decoder', e.message); this.d = null; }
      });
      this.d.configure({ codec: codecFrom(data), optimizeForLatency: true, avc: { format: 'annexb' } });
    }
    if (this.d.state !== 'configured') { this.d = null; return 2; }
    if (this.d.decodeQueueSize > 30) return 0;
    try { this.d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (this.n++) * 40000, data })); } catch { this.d = null; return 2; }
    return 1;
  }
  reset() { try { if (this.d && this.d.state !== 'closed') this.d.close(); } catch {} this.d = null; }
}
const wsUrl = p => `ws://${location.host}${p}`;

/* ---------- RTSP link dialog (for VLC, Frigate, ...) ---------- */
function rtspDialog(chans, startCh) {
  let ch = startCh || (chans[0] && chans[0].id) || 1, via = true, pw = false, relayOk = true;
  const dlg = h('dialog', { class: 'dlg' });
  const mk = () => h('input', { type: 'text', readonly: true, style: 'width:100%', onclick: e => e.target.select(), spellcheck: false });
  const rows = [['Main stream', 0, mk()], ['Sub stream', 1, mk()]];
  const cmdOf = u => via && relayOk ? `"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --rtsp-tcp "${u}"` : `ffplay -rtsp_transport tcp "${u}"`;
  const note = h('div', { class: 'note', style: 'margin-top:12px' });
  async function refresh() {
    try {
      const res = await Promise.all(rows.map(([, st]) => api(`/api/rtsp?ch=${ch}&sub=${st}&pw=${pw ? 1 : 0}&via=${via ? 'app' : 'nvr'}`)));
      relayOk = res[0].relay; if (!relayOk && via) { via = false; routeSel.value = 'nvr'; return refresh(); }
      rows.forEach(([, , inp], i) => { inp.value = res[i].url; });
      note.textContent = via ? 'Via this app: works in VLC, ffplay and similar players, on this PC while this app is running. The app only passes the video along, it does not decode it, so CPU use is tiny.'
        : 'Direct to the NVR: works in ffmpeg-based tools (ffplay, mpv, Frigate, go2rtc). VLC cannot open this link: the NVR lists an audio track VLC cannot read.';
    } catch (e) { rows.forEach(([, , inp]) => { inp.value = e.message; }); }
  }
  const copy = text => async () => {
    try { await navigator.clipboard.writeText(text()); } catch { const t = h('textarea', { style: 'position:fixed;opacity:0' }, text()); document.body.append(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove(); }
    toast('Copied', 'ok');
  };
  const chSel = h('select', { onchange: e => { ch = +e.target.value; refresh(); } }, chans.map(c => h('option', { value: c.id, selected: c.id === ch }, `${c.id} · ${c.name}`)));
  const routeSel = h('select', { onchange: e => { via = e.target.value === 'app'; refresh(); } }, [['app', 'Via this app (VLC and others)'], ['nvr', 'Direct to the NVR (ffmpeg tools, Frigate)']].map(([v, t]) => h('option', { value: v }, t)));
  const warn = h('div', { class: 'note', hidden: true }, 'The password will be visible in these links. Do not paste them anywhere you would not type your password.');
  const inc = h('input', { type: 'checkbox', onchange: e => { pw = e.target.checked; warn.hidden = !pw; refresh(); } });
  dlg.append(h('h3', { style: 'margin:0 0 12px' }, 'RTSP links'),
    h('div', { class: 'row' }, h('label', {}, 'Camera'), chSel), h('div', { class: 'row' }, h('label', {}, 'Route'), routeSel),
    h('label', { class: 'chk mut', style: 'margin:8px 0' }, inc, ' Include my password in the links'), warn,
    ...rows.map(([label, , inp]) => h('div', {}, h('div', { class: 'mut', style: 'margin:10px 0 4px;font-size:12.5px' }, label),
      h('div', { class: 'cprow' }, inp, h('button', { class: 'btn pri', onclick: copy(() => inp.value) }, 'Copy link'), h('button', { class: 'btn', title: 'Copy a ready-to-run command', onclick: copy(() => cmdOf(inp.value)) }, 'Copy command')))),
    note, h('p', { class: 'mut', style: 'font-size:12px;margin:10px 0 0' }, 'Replace YOUR_PASSWORD with your NVR password.'),
    h('p', { style: 'text-align:right;margin:14px 0 0' }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Close')));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg); dlg.showModal(); refresh();
}

/* ---------- Live ---------- */
class Cam {
  constructor(ch, name, onChange, sub = 1) {
    this.ch = ch; this.name = name; this.sub = sub; this.nosig = false; this.onChange = onChange; this.alive = true;
    this.cv = h('canvas', { width: 640, height: 360 });
    this.st = h('div', { class: 'st' }, 'connecting');
    this.ptz = this.makePtz();
    this.el = h('div', { class: 'cam' }, this.cv, h('div', { class: 'lbl' }, `${ch} · ${name}`), this.st, this.ptz);
    this.dec = new Dec(this.cv, () => { this.last = Date.now(); this.setSig(false); this.status(this.sub ? 'live · sub' : 'live · main', 'ok'); });
    this.connect();
    this.timer = setInterval(() => { if (this.ws && Date.now() - this.last > 6000) { this.setSig(true); this.status('no signal', 'bad'); } }, 1500);
  }
  setSig(v) { if (this.nosig !== v) { this.nosig = v; this.el.classList.toggle('nosig', v); this.onChange && this.onChange(); } }
  status(t, c = '') { this.st.textContent = t; this.st.className = 'st ' + c; }
  connect() {
    if (!this.alive) return;
    this.last = Date.now(); this.status('connecting');
    const ws = this.ws = new WebSocket(wsUrl(`/ws?ch=${this.ch}&sub=${this.sub}`));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = e => { const u = new Uint8Array(e.data); this.dec.feed(u[0] === 1, u.subarray(1)); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.dec.reset(); this.status('reconnecting', 'bad'); setTimeout(() => this.connect(), 3000); } };
  }
  drop() { const w = this.ws; this.ws = null; if (w) { w.onclose = null; w.close(); } this.dec.reset(); }
  setSub(s) { if (s === this.sub && this.ws) return; this.sub = s; this.drop(); this.connect(); }
  destroy() { this.alive = false; clearInterval(this.timer); this.drop(); }
  makePtz() {
    const step = () => store.get('ptzStep', 5);
    const send = (cmd, stop) => api('/api/ptz', { ch: this.ch, cmd, stop, step: step() }).catch(e => toast('PTZ: ' + e.message, 'bad'));
    // Press = start moving, release = stop. Stop is queued strictly AFTER the start request has finished,
    // and sent twice, so a quick tap can never leave the camera running.
    const hold = (b, cmd) => {
      let active = false, starting = null;
      const stop = () => {
        if (!active) return;
        active = false; b.classList.remove('on');
        (starting || Promise.resolve()).then(() => send(cmd, true)).then(() => new Promise(r => setTimeout(r, 200))).then(() => send(cmd, true));
      };
      b.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        if (active) return;
        active = true; b.classList.add('on');
        try { b.setPointerCapture(e.pointerId); } catch {}
        starting = send(cmd, false);
      });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, e => { e.stopPropagation(); stop(); });
      b.addEventListener('contextmenu', e => e.preventDefault());
      b.addEventListener('click', e => e.stopPropagation());
      return b;
    };
    const arrow = (cls, cmd, deg, title) => {
      const b = h('button', { class: 'b ' + cls, title });
      b.innerHTML = `<svg viewBox="0 0 24 24" style="transform:rotate(${deg}deg)"><path d="M6 15l6-6 6 6"/></svg>`;
      return hold(b, cmd);
    };
    const pad = h('div', { class: 'pad' },
      arrow('n', 'DirectionUp', 0, 'Up'), arrow('e', 'DirectionRight', 90, 'Right'), arrow('s', 'DirectionDown', 180, 'Down'), arrow('w', 'DirectionLeft', 270, 'Left'),
      arrow('d ne', 'DirectionRightUp', 45, 'Up-right'), arrow('d se', 'DirectionRightDown', 135, 'Down-right'), arrow('d sw', 'DirectionLeftDown', 225, 'Down-left'), arrow('d nw', 'DirectionLeftUp', 315, 'Up-left'),
      h('div', { class: 'hub' }, 'PTZ'));
    const lens = (label, plus, minus, tp, tm) => h('div', { class: 'lens' }, hold(h('button', { class: 'b2', title: tp }, '+'), plus), h('small', {}, label), hold(h('button', { class: 'b2', title: tm }, '−'), minus));
    const spd = h('input', { type: 'range', min: 1, max: 8, value: step(), oninput: e => store.set('ptzStep', +e.target.value) });
    const panel = h('div', { class: 'panel' },
      h('div', { class: 'row1' }, pad, lens('Zoom', 'ZoomTile', 'ZoomWide', 'Zoom in', 'Zoom out'), lens('Focus', 'FocusFar', 'FocusNear', 'Focus far', 'Focus near')),
      h('label', { class: 'spd' }, 'Speed', spd));
    const root = h('div', { class: 'ptz' + (store.get('ptzMin', false) ? ' min' : ''), onclick: e => e.stopPropagation() });
    const tog = h('button', { class: 'tog', title: 'Show / hide PTZ controls', onclick: e => { e.stopPropagation(); store.set('ptzMin', root.classList.toggle('min')); } });
    tog.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>';
    root.append(tog, panel);
    return root;
  }
}
async function liveView() {
  let hideEmpty = store.get('hideEmpty', true), single = null, cams = [];
  const grid = h('div', { id: 'liveGrid' }), empty = h('div', { class: 'mut', style: 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none' }, 'No camera with signal'), wrap = h('div', { id: 'liveWrap' }, grid, empty);
  const cbHide = h('input', { type: 'checkbox', checked: hideEmpty, onchange: e => { hideEmpty = e.target.checked; store.set('hideEmpty', hideEmpty); layout(); } });
  const back = h('button', { class: 'btn', hidden: true, onclick: () => setSingle(null) }, '← All cameras');
  const snap = h('button', { class: 'btn', hidden: true, onclick: () => { if (!single) return; single.cv.toBlob(b => { const a = h('a', { href: URL.createObjectURL(b), download: `cam${single.ch}-${Date.now()}.png` }); a.click(); }); } }, 'Snapshot');
  const full = h('button', { class: 'btn', onclick: () => { document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen(); } }, 'Fullscreen');
  const MODES = ['auto', 'main', 'sub'], MODE_LABEL = { auto: 'Auto', main: 'Main', sub: 'Sub' };
  let quality = store.get('liveQuality', 'auto');                 // default for every camera
  if (!MODES.includes(quality)) quality = 'auto';
  const perCh = store.get('liveQ', {}) || {};                      // per-camera overrides: { channel: 'main' | 'sub' | 'auto' }
  const modeOf = ch => MODES.includes(perCh[ch]) ? perCh[ch] : quality;
  // auto = small stream in the grid, full stream when that one camera is open
  const subFor = (ch, isSingle) => { const m = modeOf(ch); return m === 'main' ? 0 : m === 'sub' ? 1 : (isSingle ? 0 : 1); };
  const tileSels = new Map();
  const qsel = h('select', { title: 'Sets every camera. Main = full quality, uses more bandwidth. Sub = smaller picture, lighter. You can still change a single camera on its tile.', 'aria-label': 'Stream quality for all cameras', onchange: e => {
    quality = e.target.value; store.set('liveQuality', quality);
    for (const k of Object.keys(perCh)) delete perCh[k]; store.set('liveQ', perCh);
    tileSels.forEach((s, ch) => { s.value = modeOf(ch); });
    cams.forEach(o => { if (!single || o === single) o.setSub(subFor(o.ch, o === single)); });
  } }, MODES.map(v => h('option', { value: v, selected: v === quality }, v === 'auto' ? 'Auto' : v === 'main' ? 'Main stream' : 'Sub stream')));
  const bar = h('div', { class: 'bar' }, back, snap, h('label', {}, cbHide, ' Hide cameras without signal'), h('span', { class: 'grow' }), h('span', { class: 'mut', id: 'liveInfo' }), h('label', { class: 'mut' }, 'Quality ', qsel), h('button', { class: 'btn', title: 'Link to open this camera in VLC, Frigate, etc.', onclick: () => rtspDialog(chans, single ? single.ch : 0) }, 'RTSP link'), full);
  const root = h('div', { class: 'view' }, bar, wrap);
  function layout() {
    const vis = single ? [single] : cams.filter(c => !(hideEmpty && c.nosig));
    cams.forEach(c => { c.el.style.display = vis.includes(c) ? '' : 'none'; });
    const n = Math.max(vis.length, 1), W = wrap.clientWidth - 12, H = wrap.clientHeight - 12, g = 6;
    if (W <= 0 || H <= 0) return;
    let best = { w: 0, cols: 1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - (cols - 1) * g) / cols, ((H - (rows - 1) * g) / rows) * 16 / 9);
      if (w > best.w) best = { w, cols };
    }
    const tw = Math.floor(best.w), th = Math.floor(best.w * 9 / 16);
    grid.style.gridTemplateColumns = `repeat(${best.cols}, ${tw}px)`;
    grid.style.gridAutoRows = `${th}px`;
    $('#liveInfo', root) && ($('#liveInfo', root).textContent = `${vis.filter(c => !c.nosig).length}/${cams.length} cameras with signal`);
    empty.style.display = vis.length ? 'none' : 'flex';
  }
  function setSingle(c) {
    single = c; back.hidden = snap.hidden = !c;
    cams.forEach(o => { o.el.classList.toggle('single', o === c); if (c && o !== c) o.drop(); });
    if (c) c.setSub(subFor(c.ch, true)); else cams.forEach(o => o.setSub(subFor(o.ch, false)));
    layout();
  }
  let chans = [];
  try { chans = await api('/api/channels'); } catch (e) { toast('Cannot reach NVR: ' + e.message, 'bad'); }
  if (!('VideoDecoder' in window)) wrap.textContent = 'This browser lacks WebCodecs. Use Edge or Chrome.';
  cams = chans.map(c => new Cam(c.id, c.name, layout, subFor(c.id, false)));
  cams.forEach(c => {
    const s = h('select', { class: 'qsel', title: 'Stream for this camera only. Auto = Sub in the grid, Main when opened.', 'aria-label': `Stream for camera ${c.ch}`,
      onclick: e => e.stopPropagation(), ondblclick: e => e.stopPropagation(),
      onchange: e => { const v = e.target.value; if (v === quality) delete perCh[c.ch]; else perCh[c.ch] = v; store.set('liveQ', perCh); c.setSub(subFor(c.ch, single === c)); } },
      MODES.map(v => h('option', { value: v }, MODE_LABEL[v])));
    s.value = modeOf(c.ch); tileSels.set(c.ch, s); c.el.append(s);
  });
  cams.forEach(c => { grid.append(c.el); c.el.addEventListener('click', () => { if (!single) setSingle(c); }); });
  const ro = new ResizeObserver(layout); ro.observe(wrap);
  setTimeout(layout, 0);
  return { el: root, destroy() { ro.disconnect(); cams.forEach(c => c.destroy()); } };
}

/* ---------- Playback ---------- */
const secOf = t => { const [a, b, c] = t.split(' ')[1].split(':'); return +a * 3600 + +b * 60 + +c; };
const hms = (s, withSec = true) => { s = Math.max(0, Math.round(s)); return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}${withSec ? ':' + pad(s % 60) : ''}`; };
// One playback stream starting `off` seconds into a recording. Seeking = open a new PB at the new offset
// (the NVR starts streaming from that moment), so a seek costs well under a second.
class PB {
  constructor(cv, clip, cb, off = 0) {
    this.cv = cv; this.clip = clip; this.cb = cb; this.off = off; this.q = []; this.pos = 0; this.fps = 25; this.speed = 1; this.paused = false; this.ended = false; this.alive = true; this.held = false;
    this.dec = new Dec(cv); this.dur = clip.e - clip.s;
    const ws = this.ws = new WebSocket(wsUrl(`/wsp?file=${encodeURIComponent(clip.name)}&begin=${encodeURIComponent(clip.begin)}&end=${encodeURIComponent(clip.end)}&from=${Math.floor(off)}`));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = e => {
      const u = new Uint8Array(e.data);
      if (u[0] === 2) {
        this.awaiting = false;
        try {
          const m = JSON.parse(new TextDecoder().decode(u.subarray(1))); this.fps = m.fps || 25;
          // the NVR starts at a key frame near the time we asked for: show the real time
          if (m.t0) { const o = secOf(m.t0) - clip.s; if (o >= 0 && o <= this.dur + 5) this.off = o; }
        } catch {}
        cb.onState && cb.onState('playing'); cb.onFirst && cb.onFirst(); this.tick();
      }
      else if (this.awaiting) return;          // leftovers of the stream we just left
      else if (u[0] === 3) { this.ended = true; }
      else { this.q.push({ key: u[0] === 1, data: u.subarray(1) }); this.flow(); }
    };
    ws.onclose = () => { this.ended = true; };
    cb.onState && cb.onState('loading');
  }
  // Jump inside this clip without opening a new NVR session (about 0.3 s instead of 1-3 s). false = not possible, open a new one.
  seek(off) {
    if (!this.alive || this.ws.readyState !== 1) return false;
    this.off = off; this.q = []; this.pos = 0; this.ended = false; this.held = false; this.paused = false; this.awaiting = true;
    this.dec.reset(); clearTimeout(this.timer);          // the picture stays on screen until the new one arrives
    try { this.ws.send('s' + Math.max(0, Math.floor(off))); } catch { return false; }
    this.cb.onState && this.cb.onState('loading');
    return true;
  }
  // back-pressure: ask the server to stop sending when we are far ahead, resume when low
  flow() {
    const ahead = this.q.length - this.pos;
    if (!this.held && ahead > 40 * this.fps) { this.held = true; try { this.ws.send('p'); } catch {} }
    else if (this.held && ahead < 15 * this.fps) { this.held = false; try { this.ws.send('r'); } catch {} }
  }
  time() { return this.off + this.pos / this.fps; }
  tick() {
    clearTimeout(this.timer);
    if (!this.alive || this.paused) return;
    let delay = 1000 / (this.fps * this.speed);
    if (this.pos >= this.q.length) {
      if (this.ended) { this.cb.onTime(this.time(), this.dur); this.cb.onEnd && this.cb.onEnd(); return; }
      delay = 40;
    } else {
      const f = this.q[this.pos], r = this.dec.feed(f.key, f.data);
      if (r === 0) delay = 15; else { this.q[this.pos] = null; this.pos++; }
      this.cb.onTime(this.time(), this.dur);
    }
    this.flow();
    this.timer = setTimeout(() => this.tick(), delay);
  }
  pause(p) { this.paused = p; if (!p) this.tick(); }
  destroy() { this.alive = false; clearTimeout(this.timer); try { this.ws.onclose = null; this.ws.close(); } catch {} this.dec.reset(); }
}

// Zoomable, scrollable day timeline. Wheel = zoom, drag = pan, click = seek.
function makeTimeline(onSeek) {
  const cv = h('canvas'), tip = h('div', { class: 'tltip' });
  const zoomBy = (f, cx) => { const c = cx == null ? (a + b) / 2 : cx; setView(c - (c - a) * f, c + (b - c) * f); };
  const btn = (t, title, fn) => h('button', { title, onclick: fn }, t);
  const btns = h('div', { class: 'tlbtns' }, btn('−', 'Zoom out', () => zoomBy(1.6)), btn('+', 'Zoom in', () => zoomBy(1 / 1.6)), btn('Day', 'Show whole day', () => setView(0, 86400)), btn('◎', 'Center on playhead', () => { if (play != null) { const s = b - a; setView(play - s / 2, play + s / 2); } }));
  const el = h('div', { class: 'tlwrap' }, cv, tip, btns);
  let a = 0, b = 86400, clips = [], play = null, raf = 0, drag = null, hover = null;
  const COL = { R: '#3f78e0', M: '#e0a82e', A: '#e0475b', H: '#38b27a' };
  function setView(x, y) {
    const span = Math.min(86400, Math.max(120, y - x));
    x = (x + y) / 2 - span / 2; if (x < 0) x = 0; if (x + span > 86400) x = 86400 - span;
    a = x; b = x + span; schedule();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }
  function draw() {
    raf = 0;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const pps = W / (b - a), X = t => (t - a) * pps;
    g.fillStyle = '#10131a'; g.fillRect(0, 24, W, H - 24);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
    const step = steps.find(s => s * pps >= 90) || 21600;
    g.font = '11px system-ui'; g.textBaseline = 'top'; g.fillStyle = '#8a91a3'; g.strokeStyle = '#262b38'; g.lineWidth = 1;
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      const x = Math.round(X(t)) + .5;
      g.beginPath(); g.moveTo(x, 18); g.lineTo(x, H); g.stroke();
      g.fillText(hms(t, step < 60), x + 4, 4);
    }
    const y0 = 30, bh = H - 40;
    for (const c of clips) {
      if (c.e < a || c.s > b) continue;
      const x1 = X(Math.max(c.s, a)), x2 = Math.max(X(Math.min(c.e, b)), x1 + 1.5);
      g.fillStyle = COL[c.type] || '#6b7280'; g.fillRect(x1, y0, x2 - x1, bh);
    }
    if (play != null && play >= a && play <= b) {
      const x = Math.round(X(play)) + .5;
      g.strokeStyle = '#ff5a6a'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 14); g.lineTo(x, H); g.stroke();
      g.fillStyle = '#ff5a6a'; g.beginPath(); g.moveTo(x - 6, 12); g.lineTo(x + 6, 12); g.lineTo(x, 22); g.fill();
    }
    if (hover != null) { const x = Math.round(X(hover)) + .5; g.strokeStyle = '#ffffff55'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 24); g.lineTo(x, H); g.stroke(); }
  }
  const tAt = e => { const r = cv.getBoundingClientRect(); return a + (e.clientX - r.left) / r.width * (b - a); };
  cv.addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY > 0 ? 1.25 : 1 / 1.25, tAt(e)); }, { passive: false });
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, a, b, moved: 0 }; });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x; drag.moved = Math.max(drag.moved, Math.abs(dx));
      if (drag.moved > 4) { const d = -dx / r.width * (drag.b - drag.a); setView(drag.a + d, drag.b + d); cv.style.cursor = 'grabbing'; }
    }
    hover = tAt(e);
    const c = clips.find(c => hover >= c.s && hover <= c.e);
    tip.textContent = hms(hover) + (c ? `  ·  ${c.type === 'M' ? 'motion' : c.type === 'A' ? 'alarm' : c.type === 'R' ? 'regular' : c.type}` : '  ·  no recording');
    tip.style.display = 'block'; tip.style.left = Math.min(Math.max(e.clientX - r.left, 60), r.width - 100) + 'px';
    schedule();
  });
  cv.addEventListener('pointerleave', () => { hover = null; tip.style.display = 'none'; schedule(); });
  cv.addEventListener('pointerup', e => { if (drag && drag.moved <= 4) onSeek(tAt(e)); drag = null; cv.style.cursor = ''; });
  new ResizeObserver(schedule).observe(cv);
  return {
    el, view: () => [a, b],
    setClips(list) { clips = list; if (list.length) { const s = Math.min(...list.map(c => c.s)), e = Math.max(...list.map(c => c.e)); setView(s - 600, Math.max(e + 600, s + 3600)); } else setView(0, 86400); },
    setPlay(sec) { play = sec; if (sec != null && !drag && (sec < a || sec > b)) { const s = b - a; setView(sec - s * 0.25, sec + s * 0.75); } schedule(); }
  };
}

function playbackView() {
  let ch = store.get('pbch', 1), date = today(), clips = [], cur = null, pb = null;
  const chSel = h('select', { onchange: e => { ch = +e.target.value; store.set('pbch', ch); init(); } });
  // ---- calendar: only days that have recordings can be picked ----
  const dayCache = new Map();   // "ch-YYYY-MM" -> Set(day numbers)
  const monthDays = async (c, ym) => {
    const k = c + '-' + ym;
    if (!dayCache.has(k)) { try { dayCache.set(k, new Set((await api(`/api/days?ch=${c}&month=${ym}`)).days)); } catch { return new Set(); } }
    return dayCache.get(k);
  };
  const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  let viewMonth = date.slice(0, 7);
  const cal = h('div', { class: 'cal', hidden: true, onclick: e => e.stopPropagation() });
  const dateLbl = h('span', {}, fmtDate(date));
  const dateBtn = h('button', { class: 'btn datebtn', onclick: e => { e.stopPropagation(); cal.hidden = !cal.hidden; if (!cal.hidden) { viewMonth = date.slice(0, 7); drawCal(); } } },
    h('span', { html: '' }), dateLbl);
  dateBtn.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>');
  const setDate = d => { date = d; dateLbl.textContent = fmtDate(d); cal.hidden = true; load(); };
  async function drawCal() {
    const [Y, M] = viewMonth.split('-').map(Number);
    const days = await monthDays(ch, viewMonth);
    const nav = n => { const t = new Date(Y, M - 1 + n, 1); viewMonth = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; drawCal(); };
    const first = new Date(Y, M - 1, 1).getDay(), dim = new Date(Y, M, 0).getDate();
    const grid = h('div', { class: 'calgrid' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => h('span', { class: 'dow' }, d)));
    for (let i = 0; i < first; i++) grid.append(h('span'));
    for (let d = 1; d <= dim; d++) {
      const ds = `${viewMonth}-${pad(d)}`, has = days.has(d);
      grid.append(h('button', { class: 'day' + (has ? ' has' : '') + (ds === date ? ' sel' : '') + (ds === today() ? ' today' : ''), disabled: !has, title: has ? 'Has recordings' : 'No recordings', onclick: () => setDate(ds) }, d));
    }
    cal.replaceChildren(
      h('div', { class: 'calhead' }, h('button', { class: 'btn', onclick: () => nav(-1) }, '‹'), h('b', {}, new Date(Y, M - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' })), h('button', { class: 'btn', onclick: () => nav(1) }, '›')),
      grid, h('div', { class: 'callegend' }, h('i'), ' has recordings'));
  }
  const onDoc = () => { cal.hidden = true; };
  document.addEventListener('click', onDoc);
  // previous / next day that actually has recordings
  async function shift(dir) {
    const d = new Date(date + 'T12:00:00'), now = new Date();
    for (let i = 0; i < 800; i++) {
      d.setDate(d.getDate() + dir);
      if (dir > 0 && d > now) break;
      const set = await monthDays(ch, d.toLocaleDateString('en-CA').slice(0, 7));
      if (set.has(d.getDate())) return setDate(d.toLocaleDateString('en-CA'));
    }
    toast(dir < 0 ? 'No earlier recordings' : 'No later recordings');
  }
  // open on today, or the latest day that has recordings
  async function init() {
    const d = new Date();
    for (let m = 0; m < 12; m++) {
      const ym = d.toLocaleDateString('en-CA').slice(0, 7), set = await monthDays(ch, ym);
      if (set.size) { const last = Math.max(...set); const cand = `${ym}-${pad(last)}`; if (cand <= today()) { date = cand; break; } }
      d.setMonth(d.getMonth() - 1, 1);
    }
    dateLbl.textContent = fmtDate(date);
    load();
  }
  const list = h('div', { class: 'list' });
  const info = h('div', { class: 'mut', style: 'padding:6px 12px' });
  const side = h('div', { class: 'side' }, h('div', { class: 'bar', style: 'position:relative' }, chSel, h('button', { class: 'btn', title: 'Previous recorded day', onclick: () => shift(-1) }, '‹'), dateBtn, h('button', { class: 'btn', title: 'Next recorded day', onclick: () => shift(1) }, '›'), cal), info, list);
  const cv = h('canvas', { width: 1280, height: 720 });
  const stateL = h('span', { class: 'mut' }, 'Click the timeline or a clip');
  const play_ = h('button', { class: 'btn', onclick: () => togglePause() }, '❚❚');
  const speed = h('select', { onchange: e => { if (pb) pb.speed = +e.target.value; } }, [0.5, 1, 2, 4, 8].map(s => h('option', { value: s, selected: s === 1 }, s + '×')));
  let dragging = false;
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0,
    oninput: e => { dragging = true; if (cur) time.textContent = `${mmss(e.target.value / 1000 * (cur.e - cur.s))} / ${mmss(cur.e - cur.s)}`; },
    onchange: e => { dragging = false; if (cur) playAt(cur, e.target.value / 1000 * (cur.e - cur.s)); } });
  const time = h('span', { class: 'mut', style: 'min-width:92px' }, '00:00 / 00:00');
  const auto = h('input', { type: 'checkbox', checked: true });
  const dl = h('a', { class: 'btn', style: 'text-decoration:none;color:inherit', hidden: true }, 'Download MP4');
  const tl = makeTimeline(seekAbs);
  const pane = h('div', { class: 'pane' }, h('div', { class: 'player' }, h('div', { class: 'stage' }, cv), tl.el,
    h('div', { class: 'ctl' }, play_, speed, seek, time, h('label', { class: 'mut' }, auto, ' auto-next'), dl, stateL)));
  const root = h('div', { class: 'view' }, h('div', { class: 'split' }, side, pane));
  const fsz = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  function togglePause() { if (!pb) return; pb.pause(!pb.paused); play_.textContent = pb.paused ? '▶' : '❚❚'; }
  function playAt(c, off) {
    const base = c.s;
    if (pb && cur === c && pb.seek(off)) {          // same clip: seek on the open stream
      play_.textContent = '❚❚'; tl.setPlay(base + off); return;
    }
    // Different clip: open the new stream BEFORE letting go of the old one. The NVR is slow to
    // start a new session right after another one was closed (1-3 s); started first, it is instant.
    const old = pb; cur = c;
    if (old) { old.pause(true); old.dec.reset(); try { old.ws.send('p'); } catch {} }
    [...list.children].forEach(e => e.classList.toggle('on', e.dataset.name === c.name));
    let released = false; const release = () => { if (!released) { released = true; if (old) old.destroy(); } };
    let mine = null;   // (callbacks can fire while the constructor still runs)
    mine = pb = new PB(cv, c, {
      onState: s => { if (!mine || pb === mine) stateL.textContent = s === 'loading' ? 'loading…' : `${c.begin.slice(11)} – ${c.end.slice(11)}`; },
      onFirst: release,
      onTime: (t, tot) => { if (pb !== mine || dragging) return; time.textContent = `${mmss(t)} / ${mmss(tot)}`; seek.value = tot ? Math.min(1000, t / tot * 1000) : 0; tl.setPlay(base + t); },
      onEnd: () => { if (pb === mine && auto.checked) { const i = clips.indexOf(cur); if (clips[i + 1]) playAt(clips[i + 1], 0); } }
    }, off);
    setTimeout(release, 6000);
    pb.speed = +speed.value; play_.textContent = '❚❚'; tl.setPlay(base + off);
    dl.hidden = false; dl.href = `/api/download?file=${encodeURIComponent(c.name)}&begin=${encodeURIComponent(c.begin)}&end=${encodeURIComponent(c.end)}`;
  }
  // seek to absolute time-of-day (seconds): inside a clip, or the next clip after a gap
  function seekAbs(t) {
    t = Math.max(0, t);
    const c = clips.find(c => t >= c.s && t <= c.e);
    if (c) return playAt(c, t - c.s);
    const n = clips.find(c => c.s > t);
    if (n) playAt(n, 0); else toast('No recording after that time');
  }
  const onKey = e => {
    if (e.target.matches('input,select,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    else if (e.code === 'ArrowLeft' && cur && pb) { e.preventDefault(); seekAbs(cur.s + pb.time() - 10); }
    else if (e.code === 'ArrowRight' && cur && pb) { e.preventDefault(); seekAbs(cur.s + pb.time() + 10); }
  };
  document.addEventListener('keydown', onKey);
  async function load() {
    list.replaceChildren(); info.textContent = 'Searching…'; if (pb) { pb.destroy(); pb = null; } tl.setPlay(null);
    try {
      const raw = await api(`/api/files?ch=${ch}&date=${date}`);
      clips = raw.map(c => { const s = secOf(c.begin); let e = secOf(c.end); if (e < s) e = 86400; return { ...c, s, e }; });
      tl.setClips(clips);
      info.textContent = clips.length ? `${clips.length} clips · ${fsz(clips.reduce((a, c) => a + c.size, 0))}` : 'No recordings this day';
      for (const c of clips) list.append(h('div', { class: 'clip', dataset: { name: c.name }, onclick: () => playAt(c, 0) }, h('span', { class: 'badge ' + c.type }, c.type), `${c.begin.slice(11)} – ${c.end.slice(11)}`, h('span', { class: 'grow' }), h('span', { class: 'mut' }, fsz(c.size))));
    } catch (e) { info.textContent = 'Error: ' + e.message; }
  }
  api('/api/channels').then(c => { chSel.replaceChildren(...c.map(x => h('option', { value: x.id, selected: x.id === ch }, `${x.id} · ${x.name}`))); });
  init();
  return { el: root, destroy() { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDoc); if (pb) pb.destroy(); } };
}

/* ---------- Events ---------- */
function eventsView() {
  const feed = h('div', { class: 'list' });
  const logs = h('tbody'), type = h('select', {}, ['LogAll'].map(t => h('option', {}, t)));
  const days = h('select', {}, [1, 3, 7, 30].map(d => h('option', { value: d, selected: d === 3 }, `last ${d} day${d > 1 ? 's' : ''}`)));
  const status = h('span', { class: 'mut' });
  const addEv = e => {
    const nm = e.Event || e.Name || 'event', stt = e.Status || '';
    feed.prepend(h('div', { class: 'ev' }, h('span', { class: 't' }, (e.t ? new Date(e.t) : new Date()).toLocaleTimeString()), h('span', {}, `${nm}${e.Channel != null ? ' · cam ' + (+e.Channel + 1) : ''}${stt ? ' · ' + stt : ''}`)));
  };
  const es = new EventSource('/api/events');
  es.onmessage = m => { const j = JSON.parse(m.data); if (j.hello) j.recent.reverse().forEach(addEv); else addEv(j); };
  async function loadLogs() {
    logs.replaceChildren(); status.textContent = 'Loading…';
    const end = new Date(), begin = new Date(Date.now() - days.value * 864e5);
    const f = d => `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 8)}`;
    try {
      const r = await api(`/api/logs?begin=${encodeURIComponent(f(begin))}&end=${encodeURIComponent(f(end))}&type=${type.value}`);
      status.textContent = `${r.logs.length} entries (Ret ${r.ret})`;
      for (const l of r.logs.reverse()) logs.append(h('tr', {}, h('td', {}, l.Time), h('td', {}, l.Type), h('td', {}, l.User), h('td', {}, typeof l.Data === 'string' ? l.Data : JSON.stringify(l.Data))));
    } catch (e) { status.textContent = 'Error: ' + e.message; }
  }
  const root = h('div', { class: 'view' }, h('div', { class: 'split' },
    h('div', { class: 'side' }, h('div', { class: 'bar' }, h('strong', {}, 'Live alarms')), feed),
    h('div', { class: 'pane' }, h('div', { class: 'bar' }, h('strong', {}, 'System log'), type, days, h('button', { class: 'btn', onclick: loadLogs }, 'Load'), status),
      h('div', { class: 'scroll', style: 'padding:0' }, h('table', {}, h('thead', {}, h('tr', {}, ['Time', 'Type', 'User', 'Details'].map(x => h('th', {}, x)))), logs)))));
  loadLogs();
  return { el: root, destroy() { es.close(); } };
}

/* ---------- Settings ---------- */
// [group, [[label, config name, perChannel, description], ...]]
const PAGES = [
  ['General', [['Basics', 'General.General', 0, 'Device name, what happens when the disk is full, screen and sign-out timers.'], ['Date & language', 'General.Location', 0, 'Language, date and clock format, video standard, daylight saving.'], ['Time zone', 'System.TimeZone', 0, 'Time zone of the NVR clock.'], ['Auto maintenance', 'General.AutoMaintain', 0, 'Automatic reboot and deleting old files.'], ['Display', 'fVideo.GUISet', 0, 'On-screen menu and monitor output.'], ['Tour', 'fVideo.Tour', 0, 'Rotate channels on the local monitor.']]],
  ['Network', [['Basics', 'NetWork.NetCommon', 0, 'IP address, ports and host name of the NVR.'], ['DHCP', 'NetWork.NetDHCP', 0, 'Get the address automatically from your router.'], ['DNS', 'NetWork.NetDNS', 0, 'Name servers.'], ['Time server (NTP)', 'NetWork.NetNTP', 0, 'Keep the NVR clock right automatically.'], ['Email alerts', 'NetWork.NetEmail', 0, 'Send an email when an alarm happens.'], ['FTP', 'NetWork.NetFTP', 0, 'Upload recordings and snapshots to an FTP server.'], ['DDNS', 'NetWork.NetDDNS', 0, 'Reach the NVR by name from outside.'], ['Cloud (XMeye)', 'NetWork.NetARSP', 0, 'Manufacturer cloud / phone app access.'], ['UPnP', 'NetWork.Upnp', 0, 'Open router ports automatically.'], ['RTSP', 'NetWork.RTSP', 0, 'Standard video stream access.'], ['IP filter', 'NetWork.NetIPFilter', 0, 'Allow or block addresses.']]],
  ['Cameras', [['Image / color', 'AVEnc.VideoColor.[#]', 1, 'Brightness, contrast and color for a channel.'], ['Camera parameters', 'Camera.Param.[#]', 1, 'Exposure, white balance and other camera options.'], ['Titles & overlays', 'AVEnc.VideoWidget', 0, 'Channel name and time shown on the picture.'], ['OSD info', 'fVideo.OSDInfo', 0, 'What the on-screen display shows.']]],
  ['Recording', [['Recording & schedule', 'Record.[#]', 1, 'Mode, pre-record and the weekly schedule for a channel.']]],
  ['Alarms', [['Motion detect', 'Detect.MotionDetect.[#]', 1, 'Record or alert when something moves.'], ['Video blind', 'Detect.BlindDetect.[#]', 1, 'Alert when the lens is covered.'], ['Video loss', 'Detect.LossDetect.[#]', 1, 'Alert when the picture is lost.'], ['Alarm out', 'Alarm.AlarmOut', 0, 'Alarm output relay.'], ['Network alarm', 'Alarm.NetAlarm', 0, ''], ['Network abort', 'Alarm.NetAbort', 0, ''], ['IPC alarm', 'Alarm.IPCAlarm', 0, '']]],
  ['PTZ & serial', [['PTZ', 'Uart.PTZ.[#]', 1, 'Pan / tilt / zoom protocol and address.'], ['Serial port', 'Uart.Comm.[#]', 1, '']]],
  ['This viewer', [['NVR name', '@app', 0, 'The name shown in this app.']]],
  ['Advanced', [['PPPoE', 'NetWork.NetPPPoE'], ['3G', 'NetWork.Net3G'], ['WiFi', 'NetWork.Wifi'], ['Mobile', 'NetWork.NetMobile'], ['Keyboard', 'NetWork.NetKeyboard'], ['PMS', 'NetWork.PMS'], ['SPVMN', 'NetWork.SPVMN'], ['Cloud storage', 'NetWork.CloudStorage'], ['Digital manager', 'NetWork.DigManagerShow'], ['Record, all channels', 'Record'], ['Raw config editor', '*', 0, 'Any NVR config key as JSON.']]]
];
const humanize = k => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const LABELS = {
  MachineName: 'Device name', OverWrite: 'When the disk is full', AutoLogout: 'Auto sign-out (minutes, 0 = never)', ScreenAutoShutdown: 'Screen off after (minutes)', ScreenSaveTime: 'Screen saver after (minutes, 0 = off)',
  VideoOutPut: 'Monitor output', FontSize: 'Menu font size', VideoFormat: 'Video standard', DateFormat: 'Date order', DateSeparator: 'Date separator', TimeFormat: 'Clock', DSTRule: 'Daylight saving',
  HostName: 'Host name', HostIP: 'IP address', Submask: 'Subnet mask', GateWay: 'Gateway', HttpPort: 'Web port', TCPPort: 'Media port (TCP)', UDPPort: 'Media port (UDP)', SSLPort: 'HTTPS port',
  MaxBps: 'Bandwidth limit (kbps, 0 = none)', TCPMaxConn: 'Max clients', MonMode: 'Stream mode', TransferPlan: 'Priority', UseHSDownLoad: 'High-speed download', MAC: 'MAC address',
  UpdatePeriod: 'Update every (minutes)', PreRecord: 'Pre-record (seconds)', PacketLength: 'File length (minutes)', RecordMode: 'Mode', Redundancy: 'Redundant recording', Enable: 'Enabled',
  UserName: 'User name', Anonymity: 'Anonymous', UseSSL: 'Use SSL', SendAddr: 'Sender address', Recievers: 'Receivers', TimeZone: 'Time zone',
};
const HELP = { HostIP: 'Changing this changes how you reach the NVR.', Submask: '', GateWay: 'Usually your router.', OverWrite: 'Overwrite = delete the oldest recordings. Stop = stop recording.', PreRecord: 'Seconds of video kept from before an event starts.', MaxBps: 'Limit for remote viewing.' };
const OPTIONS = {
  OverWrite: ['OverWrite', 'StopRecord'], VideoFormat: ['PAL', 'NTSC'], DateFormat: ['YYMMDD', 'MMDDYY', 'DDMMYY'], DateSeparator: ['-', '/', '.'], TimeFormat: ['24', '12'], DSTRule: ['Off', 'On'],
  MonMode: ['TCP', 'UDP', 'MCAST'], RecordMode: ['ConfigRecord', 'ManualRecord', 'ClosedRecord'], TransferPlan: ['Quality', 'Fluency', 'AutoAdapt'],
};
const OPT_LABEL = { OverWrite: 'Overwrite oldest', StopRecord: 'Stop recording', ConfigRecord: 'By schedule', ManualRecord: 'Always on', ClosedRecord: 'Off', YYMMDD: 'Year-Month-Day', MMDDYY: 'Month-Day-Year', DDMMYY: 'Day-Month-Year', '24': '24-hour', '12': '12-hour', Quality: 'Image quality', Fluency: 'Smoothness', AutoAdapt: 'Automatic', MCAST: 'Multicast' };
const MORE_KEYS = new Set(['BandWidthTips', 'HddNum', 'IranCalendarEnable', 'IranCalendar', 'LocalNo', 'RebootNum', 'RepairDisk', 'RepairRebootNum', 'WorkDay', 'Reserved']);
const FIELD_ORDER = ['Enable', 'MachineName', 'HostName', 'HostIP', 'Submask', 'GateWay', 'MAC', 'HttpPort', 'SSLPort', 'TCPPort', 'UDPPort', 'Language', 'DateFormat', 'DateSeparator', 'TimeFormat', 'VideoFormat', 'OverWrite', 'RecordMode', 'PreRecord', 'PacketLength', 'Redundancy'];
const READONLY_KEYS =new Set(['MAC', 'SerialNo', 'HddNum']);
const isIpKey = k => /(Address|HostIP|GateWay|Gateway|Submask|DNS)$/i.test(k);
const hexIp = v => typeof v === 'string' && /^0x[0-9a-f]{8}$/i.test(v);
const toDotted = v => { const n = parseInt(v, 16); return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.'); };
const fromDotted = s => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m || m.slice(1).some(x => +x > 255)) throw new Error(`"${s}" is not a valid IP address`);
  return '0x' + (((+m[4] << 24) | (+m[3] << 16) | (+m[2] << 8) | +m[1]) >>> 0).toString(16).toUpperCase().padStart(8, '0');
};
const isPrim = x => x === null || typeof x !== 'object';
const isFlag = (k, v) => (v === 0 || v === 1) && /(^|[a-z])(Enable|Enabled)$/.test(k);

function schedEditor(ts, mask) {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], hasMask = !!mask;
  const re = /^([01]) (\d\d):(\d\d):(\d\d)-(\d\d):(\d\d):(\d\d)$/;
  const S = ts.map((day, di) => day.map((s, pi) => { const m = re.exec(s); return { orig: s, om: hasMask ? mask[di][pi] : null, on: !!m && m[1] === '1', from: m ? `${m[2]}:${m[3]}` : '00:00', to: m ? `${m[5]}:${m[6]}` : '00:00', types: hasMask ? (parseInt(mask[di][pi], 16) || 0) : 7, touched: false }; }));
  const box = h('div', { class: 'sched' });
  const poke = () => box.dispatchEvent(new Event('input', { bubbles: true }));
  const clear = p => Object.assign(p, { on: false, from: '00:00', to: '00:00', touched: true });
  const set24 = (p, types) => Object.assign(p, { on: true, from: '00:00', to: '24:00', types, touched: true });
  const TYPES = [[1, 'Regular'], [2, 'Motion'], [4, 'Alarm']];
  function render() {
    const presets = h('div', { class: 'spre' }, h('span', { class: 'mut' }, 'Quick set: '),
      h('button', { class: 'btn', type: 'button', onclick: () => { S.forEach(d => d.forEach((p, i) => i ? clear(p) : set24(p, 7))); render(); poke(); } }, 'Record 24/7'),
      hasMask ? h('button', { class: 'btn', type: 'button', onclick: () => { S.forEach(d => d.forEach((p, i) => i ? clear(p) : set24(p, 6))); render(); poke(); } }, 'Only on motion / alarm') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => { S.forEach(d => d.forEach(clear)); render(); poke(); } }, 'Clear all'));
    box.replaceChildren(presets, ...S.map((day, di) => {
      const act = day.filter(p => p.on), free = day.find(p => !p.on);
      const rows = act.map(p => h('div', { class: 'per' },
        h('input', { type: 'text', value: p.from, size: 5, maxlength: 5, 'aria-label': 'From', oninput: e => { p.from = e.target.value.trim(); p.touched = true; } }), h('span', { class: 'mut' }, '–'),
        h('input', { type: 'text', value: p.to, size: 5, maxlength: 5, 'aria-label': 'To', oninput: e => { p.to = e.target.value.trim(); p.touched = true; } }),
        hasMask ? TYPES.map(([bit, nm]) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!(p.types & bit), onchange: e => { p.types = e.target.checked ? p.types | bit : p.types & ~bit; p.touched = true; poke(); } }), nm)) : null,
        h('button', { class: 'btn x', type: 'button', title: 'Remove', onclick: () => { clear(p); render(); poke(); } }, '×')));
      return h('div', { class: 'srow' }, h('div', { class: 'sday' }, DAYS[di], h('button', { class: 'lnk', type: 'button', title: 'Copy this day to every day', onclick: () => { S.forEach((d2, j) => { if (j !== di) d2.forEach((p2, k) => { Object.assign(p2, day[k], { orig: p2.orig, om: p2.om, touched: true }); }); }); render(); poke(); } }, 'copy to all')),
        h('div', { class: 'speriods' }, rows.length ? rows : h('span', { class: 'mut' }, 'No recording'), free ? h('button', { class: 'btn', type: 'button', onclick: () => { set24(free, 7); render(); poke(); } }, '+ Add time') : null));
    }));
  }
  render();
  box._get = () => {
    const ok = t => /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(t);
    const T = [], M = [];
    S.forEach((day, di) => {
      T.push([]); M.push([]);
      day.forEach(p => {
        if (!p.touched) { T[di].push(p.orig); M[di].push(p.om); return; }
        if (p.on && (!ok(p.from) || !ok(p.to) || p.from >= p.to)) throw new Error(`${DAYS[di]}: use times like 08:00 – 18:30 (start before end)`);
        T[di].push(`${p.on ? 1 : 0} ${p.from}:00-${p.to}:00`); M[di].push('0x' + (p.types >>> 0).toString(16).toUpperCase().padStart(8, '0'));
      });
    });
    return { TimeSection: T, Mask: hasMask ? M : undefined };
  };
  return box;
}

function ctlFor(key, val, path) {
  const d = { path: JSON.stringify(path), t: typeof val };
  const lbl = LABELS[key] || humanize(key);
  let el, wide = false;
  if (typeof val === 'boolean') el = h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: val, dataset: d }), h('span', {}));
  else if (isFlag(key, val)) el = h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: val === 1, dataset: { ...d, t: 'flag' } }), h('span', {}));
  else if (typeof val === 'string' && OPTIONS[key]) {
    const opts = OPTIONS[key].includes(val) ? OPTIONS[key] : [val, ...OPTIONS[key]];
    el = h('select', { dataset: { ...d, kind: 'sel' } }, opts.map(o => h('option', { value: o, selected: o === val }, OPT_LABEL[o] || o)));
  } else if (hexIp(val) && isIpKey(key)) el = h('input', { type: 'text', value: toDotted(val), placeholder: '0.0.0.0', inputmode: 'decimal', dataset: { ...d, kind: 'ip' } });
  else if (typeof val === 'string' && /Pass(word)?$/i.test(key)) el = h('input', { type: 'password', value: val, autocomplete: 'new-password', dataset: d });
  else if (typeof val === 'number') el = h('input', { type: 'number', step: 'any', value: val, dataset: d });
  else el = h('input', { type: 'text', value: val == null ? '' : val, readonly: READONLY_KEYS.has(key), dataset: { ...d, null: val === null ? '1' : '' } });
  return { lbl, el, help: HELP[key], sw: el.classList && el.classList.contains('sw') };
}
const fieldEl = (key, val, path) => {
  const c = ctlFor(key, val, path);
  return h('div', { class: 'f' + (c.sw ? ' fsw' : ''), dataset: { k: key } }, h('label', {}, c.lbl), c.el, c.help ? h('div', { class: 'help' }, c.help) : null);
};
function primArrayEl(key, val, path) {
  return h('div', { class: 'f wide' }, h('label', {}, LABELS[key] || humanize(key)), h('input', { type: 'text', value: val.join(', '), dataset: { path: JSON.stringify(path), kind: 'arr', t: typeof val[0] } }), h('div', { class: 'help' }, 'Separate values with commas.'));
}
function jsonEl(key, val, path) {
  return h('details', { class: 'more' }, h('summary', {}, `${LABELS[key] || humanize(key)} · advanced data`),
    h('textarea', { spellcheck: false, rows: 6, value: JSON.stringify(val), dataset: { path: JSON.stringify(path), kind: 'json' } }));
}
// An object becomes cards: one for its plain fields, a sub-card for every nested object.
function renderObj(obj, path, title, depth = 0) {
  const grid = [], more = [], subs = [];
  const sched = obj.TimeSection && Array.isArray(obj.TimeSection) && obj.TimeSection.every(r => Array.isArray(r) && r.every(x => typeof x === 'string')) ? obj : null;
  for (const k of Object.keys(obj)) {
    const v = obj[k], p = [...path, k];
    if (sched && (k === 'TimeSection' || (k === 'Mask' && Array.isArray(v) && Array.isArray(v[0])))) continue;
    if (Array.isArray(v)) {
      if (v.length && v.every(isPrim) && v.length <= 8) grid.push(primArrayEl(k, v, p));
      else if (v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) v.forEach((x, i) => subs.push(...renderObj(x, [...p, i], `${LABELS[k] || humanize(k)} ${i + 1}`, depth + 1)));
      else more.push(jsonEl(k, v, p));
    } else if (v && typeof v === 'object') subs.push(...renderObj(v, p, LABELS[k] || humanize(k), depth + 1));
    else (MORE_KEYS.has(k) ? more : grid).push(fieldEl(k, v, p));
  }
  const rank = e => { const i = FIELD_ORDER.indexOf(e.dataset && e.dataset.k); return i < 0 ? 999 : i; };
  grid.sort((a, b) => rank(a) - rank(b));   // important fields first, the rest keep the NVR's order
  const out = [];
  if (grid.length || more.length || sched) {
    out.push(h('div', { class: 'scard' }, title ? h(depth ? 'h4' : 'h3', {}, title) : null, grid.length ? h('div', { class: 'fgrid' }, grid) : null,
      sched ? h('div', { class: 'schedwrap', dataset: { sched: JSON.stringify(path) } }, schedEditor(obj.TimeSection, Array.isArray(obj.Mask) && Array.isArray(obj.Mask[0]) ? obj.Mask : null)) : null,
      more.length ? h('details', { class: 'more' }, h('summary', {}, 'More options'), h('div', { class: 'fgrid' }, more.filter(m => m.tagName !== 'DETAILS')), more.filter(m => m.tagName === 'DETAILS')) : null));
  }
  return [...out, ...subs];
}
function buildForm(val) {
  if (isPrim(val)) return h('div', { class: 'scard' }, h('div', { class: 'fgrid' }, fieldEl('Value', val, [])));
  if (Array.isArray(val)) return h('div', {}, val.flatMap((v, i) => isPrim(v) ? [h('div', { class: 'scard' }, h('div', { class: 'fgrid' }, fieldEl(`Item ${i + 1}`, v, [i])))] : renderObj(v, [i], `Item ${i + 1}`)));
  return h('div', {}, renderObj(val, [], ''));
}
function collectForm(root, orig) {
  const out = JSON.parse(JSON.stringify(orig));
  const conv = (s, t) => t === 'number' ? Number(s) : t === 'boolean' ? s === 'true' : s;
  const put = (path, v) => { let o = out; for (let i = 0; i < path.length - 1; i++) o = o[path[i]]; o[path[path.length - 1]] = v; };
  for (const inp of root.querySelectorAll('[data-path]')) {
    const path = JSON.parse(inp.dataset.path), k = inp.dataset.kind;
    let v;
    if (k === 'arr') v = inp.value.split(',').map(s => s.trim()).filter(s => s !== '').map(s => conv(s, inp.dataset.t));
    else if (k === 'json') { try { v = JSON.parse(inp.value); } catch { throw new Error('Advanced data is not valid JSON'); } }
    else if (k === 'ip') v = fromDotted(inp.value);
    else if (inp.type === 'checkbox') v = inp.dataset.t === 'flag' ? (inp.checked ? 1 : 0) : inp.checked;
    else if (inp.dataset.t === 'number') v = inp.value === '' ? 0 : Number(inp.value);
    else v = inp.dataset.null && inp.value === '' ? null : inp.value;
    put(path, v);
  }
  for (const w of root.querySelectorAll('[data-sched]')) {
    const base = JSON.parse(w.dataset.sched), r = w.firstChild._get();
    let o = out; for (const p of base) o = o[p];
    o.TimeSection = r.TimeSection; if (r.Mask) o.Mask = r.Mask;
  }
  return out;
}
function settingsView() {
  let page = store.get('spage', 'General.General'), ch = 1, nCh = 4, curName = null, orig = null, base = '', q = '';
  if (!PAGES.some(([, it]) => it.some(x => x[1] === page))) page = 'General.General';
  const menu = h('div', { class: 'menu' }), body = h('div', { class: 'scroll sbody' }), title = h('strong', {}), desc = h('span', { class: 'mut sdesc' });
  const chSel = h('select', { hidden: true, onchange: e => { ch = +e.target.value; open(page); } });
  const status = h('span', { class: 'mut' }, ''), saveBtn = h('button', { class: 'btn pri', disabled: true, onclick: () => save() }, 'Save changes'), discard = h('button', { class: 'btn', disabled: true, onclick: () => open(page) }, 'Discard');
  const savebar = h('div', { class: 'savebar', hidden: true }, status, h('span', { class: 'grow' }), discard, saveBtn);
  const search = h('input', { type: 'search', placeholder: 'Search settings…', 'aria-label': 'Search settings', oninput: e => { q = e.target.value.trim().toLowerCase(); drawMenu(); } });
  const root = h('div', { class: 'view' }, h('div', { class: 'split' }, h('div', { class: 'side', style: 'width:250px' }, h('div', { class: 'sside' }, search), menu),
    h('div', { class: 'pane' }, h('div', { class: 'bar sbar' }, h('div', { class: 'stitle' }, title, desc), chSel), body, savebar)));
  const find = name => { for (const [, items] of PAGES) for (const it of items) if (it[1] === name) return it; };
  const groupOf = name => (PAGES.find(([, items]) => items.some(i => i[1] === name)) || [])[0];
  function drawMenu() {
    const btn = it => h('button', { class: it[1] === page ? 'on' : '', onclick: () => open(it[1]) }, it[0]);
    if (q) {
      const hits = PAGES.flatMap(([g, items]) => items.filter(it => (it[0] + ' ' + g + ' ' + (it[3] || '')).toLowerCase().includes(q)).map(it => [g, it]));
      menu.replaceChildren(...(hits.length ? hits.map(([g, it]) => h('button', { class: it[1] === page ? 'on' : '', onclick: () => open(it[1]) }, it[0], h('span', { class: 'mut gtag' }, g))) : [h('p', { class: 'mut', style: 'padding:8px 10px' }, 'No settings match.')]));
      return;
    }
    menu.replaceChildren(...PAGES.map(([g, items]) => h('details', { open: g === groupOf(page) || undefined, ontoggle: e => { if (e.target.open) menu.querySelectorAll('details').forEach(x => { if (x !== e.target) x.open = false; }); } }, h('summary', {}, g), items.map(btn))));
  }
  const resolve = (name, perCh) => perCh ? name.replace('#', ch - 1) : name;
  const cur = () => { try { return JSON.stringify(collectForm(body, orig)); } catch { return 'invalid'; } };
  function mark() {
    const dirty = !!orig && cur() !== base;
    savebar.hidden = !orig; saveBtn.disabled = !dirty; discard.disabled = !dirty; status.textContent = dirty ? 'You have unsaved changes' : 'No changes';
    status.className = dirty ? 'warn' : 'mut';
  }
  body.addEventListener('input', () => mark()); body.addEventListener('change', () => mark());
  async function open(name) {
    if (savebar.hidden === false && !saveBtn.disabled && name !== page && !confirm('Discard your unsaved changes?')) return;
    page = name; store.set('spage', name); orig = null; savebar.hidden = true; drawMenu();
    const it = find(name) || [name, name];
    title.textContent = it[0]; desc.textContent = it[3] || ''; chSel.hidden = !it[2]; body.replaceChildren(h('p', { class: 'mut' }, 'Loading…'));
    if (name === '*') return rawEditor();
    if (name === '@app') return appEditor();
    curName = resolve(name, it[2]);
    try {
      const r = await api('/api/cfg?name=' + encodeURIComponent(curName));
      if (r.ret !== 100 || r.value === undefined) return body.replaceChildren(h('p', { class: 'mut' }, `This page is not available on this NVR (Ret ${r.ret}).`));
      orig = r.value;
      const warn = /^NetWork\.(NetCommon|NetDHCP|NetDNS|NetPPPoE|Wifi|Net3G)/.test(curName) ? h('div', { class: 'note' }, 'Changing network settings can make the NVR unreachable at this address.') : null;
      body.replaceChildren(...[warn, buildForm(orig)].filter(Boolean));
      base = cur(); mark(); body.scrollTop = 0;
    } catch (e) { body.replaceChildren(h('p', { class: 'mut' }, 'Error: ' + e.message)); }
  }
  async function save() {
    let value; try { value = collectForm(body, orig); } catch (e) { return toast(e.message, 'bad'); }
    if (/^NetWork\./.test(curName) && !confirm('Network settings can lock you out of the NVR. Save anyway?')) return;
    saveBtn.disabled = true;
    try {
      const r = await api('/api/cfg', { name: curName, value });
      toast(r.ret === 100 ? 'Saved' : `The NVR did not accept this (Ret ${r.ret})`, r.ret === 100 ? 'ok' : 'bad');
      if (r.ret === 100) { orig = value; base = cur(); mark(); } else mark();
    } catch (e) { toast('Save failed: ' + e.message, 'bad'); mark(); }
  }
  async function appEditor() {
    const cur = (await api('/api/session')).name, br = await api('/api/branding');
    const nm = h('input', { type: 'text', value: cur, maxlength: 40, style: 'width:320px;max-width:100%' });
    const also = h('input', { type: 'checkbox' });
    const go = async () => {
      const name = nm.value.trim(); if (!name) return toast('Enter a name', 'bad');
      try {
        await api('/api/branding', { name }); setBrand(name);
        if (also.checked) {
          const r = await api('/api/cfg?name=General.General');
          if (r.ret === 100) { r.value.MachineName = name; const w = await api('/api/cfg', { name: 'General.General', value: r.value }); if (w.ret !== 100) return toast(`Saved here, but the NVR replied Ret ${w.ret}`, 'bad'); }
        }
        toast('Name saved', 'ok');
      } catch (e) { toast(e.message, 'bad'); }
    };
    body.replaceChildren(h('div', { class: 'scard' }, h('h3', {}, 'Display name'),
      h('p', { class: 'mut' }, 'Shown in the sidebar, the browser tab and on the sign-in page.'),
      h('p', {}, nm, ' ', h('button', { class: 'btn pri', onclick: go }, 'Save')),
      h('label', { class: 'chk mut' }, also, ' Also set it as the NVR\'s own device name')),
      h('div', { class: 'scard' }, h('h3', {}, 'NVR connection'),
        h('p', { class: 'mut', style: 'margin-top:0' }, 'The address of the NVR this app talks to. Change it if you move this app to another network or use another NVR.'),
        h('div', { class: 'kv' }, h('div', {}, 'NVR address'), h('div', {}, br.host || '—')),
        h('p', {}, h('a', { class: 'btn', href: '/setup.html', style: 'text-decoration:none;display:inline-block' }, 'Change NVR address…'))));
  }
  function rawEditor() {
    const nm = h('input', { type: 'text', value: 'General.General', style: 'width:260px;max-width:100%' }), ta = h('textarea', { style: 'width:100%;height:55vh;font-family:Consolas,monospace' });
    const ld = async () => { try { const r = await api('/api/cfg?name=' + encodeURIComponent(nm.value)); ta.value = r.value === undefined ? `// Ret ${r.ret} ${r.raw || ''}` : JSON.stringify(r.value, null, 2); } catch (e) { ta.value = '// ' + e.message; } };
    const sv = async () => { try { if (!confirm('Write this raw value to the NVR?')) return; const r = await api('/api/cfg', { name: nm.value, value: JSON.parse(ta.value) }); toast(`NVR replied Ret ${r.ret}`, r.ret === 100 ? 'ok' : 'bad'); } catch (e) { toast(e.message, 'bad'); } };
    body.replaceChildren(h('div', { class: 'note' }, 'Raw access to any NVR config key. Wrong values can break the device.'), h('p', {}, nm, ' ', h('button', { class: 'btn', onclick: ld }, 'Load'), ' ', h('button', { class: 'btn pri', onclick: sv }, 'Save')), ta);
  }
  api('/api/channels').then(c => { nCh = c.length; chSel.replaceChildren(...c.map(x => h('option', { value: x.id }, `${x.id} · ${x.name}`))); });
  open(page);
  return { el: root };
}

/* ---------- Cameras (digital channels, like the original console) ---------- */
const CH_STATUS = { Connected: ['Connected', 'ok'], NoConfig: ['Not configured', ''], Offline: ['Offline', 'bad'], NoConnect: ['Not connected', 'bad'], NoLogin: ['Wrong login', 'bad'], UnKnown: ['Unknown', ''] };
const emptyConn = () => ({ ConnType: 'SINGLE', Decoder: null, EnCheckTime: true, Enable: false, SingleConnId: '0x00000000', SynchResolution: false, TourIntv: 10 });
function camerasView() {
  let v3 = [], status = [], nCh = 4, host = '', editing = null;
  const body = h('div', { class: 'scroll' });
  const root = h('div', { class: 'view' }, h('div', { class: 'bar' }, h('strong', {}, 'Cameras'), h('span', { class: 'mut' }, 'IP cameras connected to the NVR channels'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => load() }, 'Refresh')), body);
  const decOf = i => v3[i] && v3[i].Decoder && v3[i].Decoder[0];
  let found = null, searching = false, subnet = '';

  async function load(keep) {
    try {
      const [c, s, ch, br] = await Promise.all([api('/api/cfg?name=NetWork.RemoteDeviceV3'), api('/api/cfg?name=NetWork.ChnStatus'), api('/api/channels'), api('/api/branding')]);
      v3 = c.value || []; status = (s.value || []).filter(x => x.ChnName); nCh = ch.length; host = br.host || '';
      if (!subnet) subnet = host.split('.').slice(0, 3).join('.');
      if (!keep) editing = null;
      render();
    } catch (e) { body.replaceChildren('Error: ' + e.message); }
  }
  async function write(next, okMsg) {
    try {
      const r = await api('/api/cfg', { name: 'NetWork.RemoteDeviceV3', value: next });
      if (r.ret !== 100) return toast(`NVR refused the change (Ret ${r.ret})`, 'bad');
      toast(okMsg, 'ok'); editing = null;
      await new Promise(r => setTimeout(r, 1500)); await load();
      setTimeout(load, 6000);   // the NVR needs a few seconds to connect and report the new status
    } catch (e) { toast(e.message, 'bad'); }
  }
  function openEdit(i, pre) {
    const d = decOf(i) || {};
    editing = { i, f: { enable: v3[i] && v3[i].Decoder ? v3[i].Enable !== false : true, name: d.ConfName || `Camera ${i + 1}`, ip: d.IPAddress || '', port: d.Port || 80, proto: d.Protocol || 'ONVIF', user: d.UserName || 'admin', pass: d.PassWord || '', stream: d.StreamType || 'MAIN', main: d.MainRtspUrl || '', sub: d.SubRtspUrl || '', ...pre } };
    render(); body.scrollTop = 0;
  }
  async function save() {
    const { i, f } = editing, el = k => $('#cf_' + k, body);
    for (const k of Object.keys(f)) f[k] = el(k) ? (el(k).type === 'checkbox' ? el(k).checked : el(k).value.trim()) : f[k];
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(f.ip) && !/^[\w.-]+$/.test(f.ip)) return toast('Enter a valid IP address', 'bad');
    if (!(+f.port >= 1 && +f.port <= 65535)) return toast('Port must be 1–65535', 'bad');
    const old = decOf(i);
    if (old && v3[i].Enable && !confirm(`Channel ${i + 1} is in use. Changing it reconnects the camera. Continue?`)) return;
    const dec = { Channel: 0, DevType: 'IPC', Interval: 10, MacAddr: '', SerialNo: '', TransModel: 0, ...old, ConfName: f.name.slice(0, 32), Enable: true, IPAddress: f.ip, Port: +f.port, Protocol: f.proto, UserName: f.user, PassWord: f.pass, StreamType: f.stream, MainRtspUrl: f.main, SubRtspUrl: f.sub };
    const next = JSON.parse(JSON.stringify(v3));
    const conn = next[i] && next[i].Decoder ? next[i] : emptyConn();
    Object.assign(conn, { ConnType: 'SINGLE', Decoder: [dec], Enable: f.enable, SingleConnId: '0x00000001' });
    next[i] = conn;
    write(next, `Channel ${i + 1} saved`);
  }
  async function remove(i) {
    if (!confirm(`Remove the camera from channel ${i + 1}?`)) return;
    const next = JSON.parse(JSON.stringify(v3)); next[i] = emptyConn();
    write(next, `Channel ${i + 1} cleared`);
  }
  async function search() {
    subnet = $('#subnet', body).value.trim(); searching = true; found = null; render();
    try { found = (await api('/api/discover?subnet=' + encodeURIComponent(subnet))).devices; } catch (e) { toast(e.message, 'bad'); found = []; }
    searching = false; render();
  }
  function useDevice(d, i) {
    const port = d.kind === 'ONVIF' ? +((/:(\d+)\//.exec(d.xaddr || '') || [])[1] || 80) : d.kind === 'Xiongmai' ? (d.port || 34567) : (d.ports.includes(554) ? 554 : (d.ports[0] || 80));
    openEdit(i, { ip: d.ip, port, proto: d.kind === 'ONVIF' ? 'ONVIF' : d.kind === 'Xiongmai' ? 'NETIP' : 'RTSP', name: d.name || d.model || d.ip, main: d.kind === 'RTSP' ? `rtsp://${d.ip}:554/` : '', sub: '' });
  }
  const fld = (label, el) => h('div', { class: 'row' }, h('label', {}, label), el);
  function form() {
    const { i, f } = editing, id = k => 'cf_' + k;
    const dl = h('datalist', { id: 'protos' }, ['ONVIF', 'NETIP', 'RTSP'].map(x => h('option', { value: x })));
    const pw = h('input', { id: id('pass'), type: 'password', value: f.pass, autocomplete: 'off' });
    return h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, `Channel ${i + 1} · ${(status[i] && status[i].ChnName) || ''}`), dl,
      fld('Enabled', h('input', { id: id('enable'), type: 'checkbox', checked: f.enable })),
      fld('Name', h('input', { id: id('name'), type: 'text', value: f.name, maxlength: 32 })),
      fld('Protocol', h('input', { id: id('proto'), type: 'text', value: f.proto, list: 'protos' })),
      fld('IP address / host', h('input', { id: id('ip'), type: 'text', value: f.ip })),
      fld('Port', h('input', { id: id('port'), type: 'number', value: f.port })),
      fld('Username', h('input', { id: id('user'), type: 'text', value: f.user, autocomplete: 'off' })),
      fld('Password', h('span', {}, pw, ' ', h('button', { class: 'btn', type: 'button', onclick: e => { pw.type = pw.type === 'password' ? 'text' : 'password'; e.target.textContent = pw.type === 'password' ? 'Show' : 'Hide'; } }, 'Show'))),
      fld('Stream', h('select', { id: id('stream'), style: 'max-width:420px' }, ['MAIN', 'SUB'].map(x => h('option', { value: x, selected: x === f.stream }, x === 'MAIN' ? 'Main stream' : 'Extra stream')))),
      /RTSP/i.test(f.proto) ? fld('Main RTSP URL', h('input', { id: id('main'), type: 'text', value: f.main, style: 'max-width:520px' })) : null,
      /RTSP/i.test(f.proto) ? fld('Sub RTSP URL', h('input', { id: id('sub'), type: 'text', value: f.sub, style: 'max-width:520px' })) : null,
      h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn pri', onclick: save }, 'Save'), ' ', h('button', { class: 'btn', onclick: () => { editing = null; render(); } }, 'Cancel')),
      h('p', { class: 'mut', style: 'font-size:12px' }, 'ONVIF suits most IP cameras (port 80 or 8000/8899). The NVR takes a few seconds to connect after saving.'));
  }
  function render() {
    const rows = [];
    for (let i = 0; i < nCh; i++) {
      const st = status[i] || {}, d = decOf(i), enabled = v3[i] && v3[i].Enable;
      const [label, cls] = CH_STATUS[st.Status] || [st.Status || '—', ''];
      rows.push(h('tr', {}, h('td', {}, `${i + 1}`), h('td', {}, st.ChnName || `D0${i + 1}`),
        h('td', {}, h('span', { class: 'pill ' + cls }, label)),
        h('td', {}, d ? h('div', {}, h('b', {}, d.ConfName || 'Camera'), h('div', { class: 'mut' }, `${d.IPAddress}:${d.Port} · ${d.Protocol}${enabled ? '' : ' · disabled'}`)) : h('span', { class: 'mut' }, 'No camera')),
        h('td', { class: 'mut' }, st.CurRes && st.CurRes !== 'Unknown' ? st.CurRes : '—'),
        h('td', { style: 'white-space:nowrap;text-align:right' }, h('button', { class: 'btn', onclick: () => openEdit(i) }, d ? 'Edit' : 'Add'), d ? [' ', h('button', { class: 'btn dng', onclick: () => remove(i) }, 'Remove')] : null)));
    }
    const used = new Set(v3.map(c => c && c.Decoder && c.Decoder[0] && c.Decoder[0].IPAddress).filter(Boolean));
    const freeCh = Array.from({ length: nCh }, (_, i) => i).filter(i => !decOf(i));
    const res = searching ? h('p', { class: 'mut' }, 'Searching… (about 10 seconds)') : found == null ? null :
      found.length ? h('table', {}, h('thead', {}, h('tr', {}, ['IP address', 'Type', 'Name / model', 'Open ports', '', ''].map(x => h('th', {}, x)))), h('tbody', {}, found.map(d => {
        const sel = h('select', {}, (freeCh.length ? freeCh : [...Array(nCh).keys()]).map(i => h('option', { value: i }, `Channel ${i + 1}`)));
        return h('tr', {}, h('td', {}, d.ip), h('td', {}, d.kind), h('td', {}, [d.name, d.model].filter(Boolean).join(' · ') || '—'), h('td', { class: 'mut' }, d.ports.join(', ') || '—'),
          h('td', {}, used.has(d.ip) ? h('span', { class: 'pill ok' }, 'already added') : null), h('td', { style: 'white-space:nowrap;text-align:right' }, sel, ' ', h('button', { class: 'btn', onclick: () => useDevice(d, +sel.value) }, 'Add')));
      }))) : h('p', { class: 'mut' }, 'No cameras found on that network.');
    body.replaceChildren(...[
      h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px' }, 'Channels'), h('table', {}, h('thead', {}, h('tr', {}, ['#', 'Channel', 'Status', 'Camera', 'Resolution', ''].map(x => h('th', {}, x)))), h('tbody', {}, rows))),
      editing ? form() : null,
      h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, 'Auto search'),
        h('p', { class: 'mut', style: 'margin:0 0 10px' }, 'Looks for ONVIF, Xiongmai and RTSP cameras on a network (first three numbers of the address, e.g. 192.168.30).'),
        h('p', {}, h('input', { id: 'subnet', type: 'text', value: subnet, style: 'width:150px' }), '.1–254 ', h('button', { class: 'btn pri', disabled: searching, onclick: search }, searching ? 'Searching…' : 'Search')), res)].filter(Boolean));
  }
  load();
  return { el: root };
}

/* ---------- Users & groups (accounts live inside the NVR) ---------- */
const AUTH_LABEL = {
  ShutDown: 'Shut down / reboot', ChannelTitle: 'Channel titles', RecordConfig: 'Record settings', Backup: 'Backup', StorageManager: 'Disk management',
  Account: 'Manage accounts', SysInfo: 'System info', QueryLog: 'View logs', DelLog: 'Clear logs', SysUpgrade: 'Firmware upgrade', AutoMaintain: 'Auto maintenance',
  TourConfig: 'Tour settings', TVadjustConfig: 'TV adjust', GeneralConfig: 'General settings', EncodeConfig: 'Encode settings', CommConfig: 'Serial / comm settings',
  NetConfig: 'Network settings', AlarmConfig: 'Alarm settings', VideoConfig: 'Video settings', PtzConfig: 'PTZ settings', PTZControl: 'PTZ control',
  DefaultConfig: 'Restore defaults', Talk_01: 'Two-way talk', DigitalManager: 'Cameras (digital channels)', ImExport: 'Import / export config',
};
function authLabel(a) {
  const m = /^(Monitor|Replay)_(\d+)$/.exec(a);
  return m ? `${m[1] === 'Monitor' ? 'Live view' : 'Playback'} · channel ${+m[2]}` : (AUTH_LABEL[a] || a);
}
function permPicker(all, start) {
  const boxes = new Map();
  const mk = a => { const cb = h('input', { type: 'checkbox' }); cb.checked = start.includes(a); boxes.set(a, cb); return h('label', { class: 'chk' }, cb, ' ', authLabel(a)); };
  const cam = all.filter(a => /^(Monitor|Replay)_/.test(a)), sys = all.filter(a => !/^(Monitor|Replay)_/.test(a));
  const all_ = v => boxes.forEach(cb => { cb.checked = v; });
  const el = h('div', {},
    h('p', { style: 'margin:0 0 6px' }, h('button', { class: 'btn', type: 'button', onclick: () => all_(true) }, 'All'), ' ', h('button', { class: 'btn', type: 'button', onclick: () => all_(false) }, 'None')),
    h('div', { class: 'mut', style: 'margin:6px 0 2px' }, 'Cameras'), h('div', { class: 'perm' }, cam.map(mk)),
    h('div', { class: 'mut', style: 'margin:10px 0 2px' }, 'System'), h('div', { class: 'perm' }, sys.map(mk)));
  return { el, get: () => [...boxes].filter(([, cb]) => cb.checked).map(([a]) => a), set: list => boxes.forEach((cb, a) => { cb.checked = list.includes(a); }) };
}
function usersView() {
  let D = null, ed = null;
  const body = h('div', { class: 'scroll' });
  const root = h('div', { class: 'view' }, h('div', { class: 'bar' }, h('strong', {}, 'Users'), h('span', { class: 'mut' }, 'Accounts stored in the NVR'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => load() }, 'Refresh')), body);
  const fld = (label, el) => h('div', { class: 'row' }, h('label', {}, label), el);
  async function load(keep) {
    try { D = await api('/api/users'); if (!keep) ed = null; render(); }
    catch (e) { body.replaceChildren('Error: ' + e.message); }
  }
  async function act(req, msg) {
    try { const r = await api('/api/users', req); toast(msg, 'ok'); return r; }
    catch (e) { toast(e.message, 'bad'); return null; }
  }
  const pwInputs = () => {
    const a = h('input', { type: 'password', autocomplete: 'new-password' }), b = h('input', { type: 'password', autocomplete: 'new-password' });
    const show = h('button', { class: 'btn', type: 'button', onclick: e => { const t = a.type === 'password' ? 'text' : 'password'; a.type = b.type = t; e.target.textContent = t === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    return { a, b, show, check() { if (a.value.length < 6 || a.value.length > 32) { toast('Password must be 6–32 characters', 'bad'); return null; } if (a.value !== b.value) { toast('The two passwords differ', 'bad'); return null; } return a.value; } };
  };
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => { ed = null; render(); } }, 'Cancel');

  function myPasswordForm() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), pw = pwInputs();
    return h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, 'Change my password'),
      fld('Current password', cur), fld('New password', pw.a), fld('Repeat new password', pw.b), fld('', pw.show),
      h('p', { class: 'mut', style: 'font-size:12px' }, 'You will be signed out and must sign in again with the new password.'),
      h('p', {}, h('button', { class: 'btn pri', onclick: async () => {
        const n = pw.check(); if (!n) return;
        if (!cur.value) return toast('Enter your current password', 'bad');
        const r = await act({ action: 'password', old: cur.value, new: n }, 'Password changed');
        if (r) setTimeout(() => { location.href = '/login.html'; }, 900);
      } }, 'Change password'), ' ', cancel));
  }
  function userForm() {
    const add = ed.mode === 'add', u = ed.u || {}, groups = D.groups;
    const name = h('input', { type: 'text', value: u.name || '', maxlength: 16, disabled: !add, autocomplete: 'off' });
    const grp = h('select', {}, groups.map(g => h('option', { value: g.name, selected: g.name === (u.group || 'user') }, g.name)));
    const memo = h('input', { type: 'text', value: u.memo || '', maxlength: 32 });
    const share = h('input', { type: 'checkbox', checked: u.sharable !== false });
    const g0 = groups.find(g => g.name === grp.value);
    const perms = permPicker(D.authorities, u.authority || (g0 ? g0.authority : []));
    grp.onchange = () => { if (add) { const g = groups.find(x => x.name === grp.value); if (g) perms.set(g.authority); } };
    const pw = add ? pwInputs() : null;
    return h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, add ? 'Add user' : `Edit user · ${u.name}`),
      fld('User name', name), pw ? fld('Password', pw.a) : null, pw ? fld('Repeat password', pw.b) : null, pw ? fld('', pw.show) : null,
      fld('Group', grp), fld('Memo', memo), fld('Several sign-ins at once', share),
      h('div', { style: 'margin:8px 0 4px' }, h('b', {}, 'Permissions'), h('span', { class: 'mut' }, add ? '  (filled from the group, change as needed)' : '')), perms.el,
      h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn pri', onclick: async () => {
        const req = { action: add ? 'add' : 'modify', name: name.value.trim(), group: grp.value, memo: memo.value.trim(), sharable: share.checked, authority: perms.get() };
        if (add) { const p = pw.check(); if (!p) return; req.password = p; }
        if (await act(req, add ? 'User added' : 'User saved')) load();
      } }, 'Save'), ' ', cancel));
  }
  function resetForm() {
    const pw = pwInputs();
    return h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, `Set new password · ${ed.u.name}`),
      fld('New password', pw.a), fld('Repeat new password', pw.b), fld('', pw.show),
      h('p', { class: 'mut', style: 'font-size:12px;max-width:560px' }, 'The NVR only lets a person change their own password. So this removes the account and creates it again with the same group and permissions. They are signed out.'),
      h('p', {}, h('button', { class: 'btn pri', onclick: async () => {
        const p = pw.check(); if (!p) return;
        if (!confirm(`Re-create "${ed.u.name}" with the new password?`)) return;
        if (await act({ action: 'reset', name: ed.u.name, password: p }, 'Password set')) load();
      } }, 'Set password'), ' ', cancel));
  }
  function groupForm() {
    const add = ed.mode === 'add', g = ed.g || {};
    const name = h('input', { type: 'text', value: g.name || '', maxlength: 16, disabled: !add, autocomplete: 'off' });
    const memo = h('input', { type: 'text', value: g.memo || '', maxlength: 32 });
    const perms = permPicker(D.authorities, g.authority || []);
    return h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, add ? 'Add group' : `Edit group · ${g.name}`),
      fld('Group name', name), fld('Memo', memo),
      h('div', { style: 'margin:8px 0 4px' }, h('b', {}, 'Permissions'), h('span', { class: 'mut' }, '  (new users in this group start with these)')), perms.el,
      h('p', { style: 'margin-top:14px' }, h('button', { class: 'btn pri', onclick: async () => {
        if (await act({ action: add ? 'gadd' : 'gmodify', name: name.value.trim(), memo: memo.value.trim(), authority: perms.get() }, 'Group saved')) load();
      } }, 'Save'), ' ', cancel));
  }
  const summary = a => a.length ? `${a.length} permissions` : 'none';
  function render() {
    const me = D.me, cards = [];
    cards.push(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 8px' }, 'My account'),
      h('div', { class: 'kv' }, h('div', {}, 'Signed in as'), h('div', {}, me.name), h('div', {}, 'Group'), h('div', {}, me.group || '—'), h('div', {}, 'May manage accounts'), h('div', {}, me.canManage ? 'Yes' : 'No')),
      me.canManage ? h('p', {}, h('button', { class: 'btn', onclick: () => { ed = { kind: 'me' }; render(); body.scrollTop = body.scrollHeight; } }, 'Change my password')) : null));
    if (ed && ed.kind === 'me') cards.push(myPasswordForm());
    if (me.canManage) {
      cards.push(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px' }, 'Users', ' ', h('button', { class: 'btn pri', style: 'margin-left:10px', onclick: () => { ed = { kind: 'user', mode: 'add' }; render(); body.scrollTop = body.scrollHeight; } }, 'Add user')),
        h('table', {}, h('thead', {}, h('tr', {}, ['User', 'Group', 'Memo', 'Permissions', ''].map(x => h('th', {}, x)))),
          h('tbody', {}, D.users.map(u => h('tr', {}, h('td', {}, h('b', {}, u.name), u.name === me.name ? h('span', { class: 'pill ok', style: 'margin-left:8px' }, 'you') : null), h('td', {}, u.group), h('td', { class: 'mut' }, u.memo || '—'), h('td', { class: 'mut' }, summary(u.authority)),
            h('td', { style: 'white-space:nowrap;text-align:right' },
              h('button', { class: 'btn', onclick: () => { ed = { kind: 'user', mode: 'edit', u }; render(); body.scrollTop = body.scrollHeight; } }, 'Edit'), ' ',
              u.name === me.name ? null : [h('button', { class: 'btn', onclick: () => { ed = { kind: 'reset', u }; render(); body.scrollTop = body.scrollHeight; } }, 'Password'), ' ',
                u.reserved ? null : h('button', { class: 'btn dng', onclick: async () => { if (confirm(`Delete user "${u.name}"?`) && await act({ action: 'delete', name: u.name }, 'User deleted')) load(); } }, 'Delete')])))))));
      if (ed && ed.kind === 'user') cards.push(userForm());
      if (ed && ed.kind === 'reset') cards.push(resetForm());
      cards.push(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px' }, 'Groups', ' ', h('button', { class: 'btn', style: 'margin-left:10px', onclick: () => { ed = { kind: 'group', mode: 'add' }; render(); body.scrollTop = body.scrollHeight; } }, 'Add group')),
        h('table', {}, h('thead', {}, h('tr', {}, ['Group', 'Memo', 'Users', 'Permissions', ''].map(x => h('th', {}, x)))),
          h('tbody', {}, D.groups.map(g => h('tr', {}, h('td', {}, h('b', {}, g.name)), h('td', { class: 'mut' }, g.memo || '—'), h('td', { class: 'mut' }, D.users.filter(u => u.group === g.name).length), h('td', { class: 'mut' }, summary(g.authority)),
            h('td', { style: 'white-space:nowrap;text-align:right' }, h('button', { class: 'btn', onclick: () => { ed = { kind: 'group', mode: 'edit', g }; render(); body.scrollTop = body.scrollHeight; } }, 'Edit'), ' ',
              g.name === 'admin' || g.name === 'user' ? null : h('button', { class: 'btn dng', onclick: async () => { if (confirm(`Delete group "${g.name}"?`) && await act({ action: 'gdelete', name: g.name }, 'Group deleted')) load(); } }, 'Delete'))))))));
      if (ed && ed.kind === 'group') cards.push(groupForm());
    } else {
      cards.push(h('p', { class: 'mut' }, 'Your account has no “Manage accounts” permission, so the NVR will not let it list or change accounts. Sign in as an administrator to manage users.'));
    }
    body.replaceChildren(...cards.filter(Boolean));
  }
  load();
  return { el: root };
}

/* ---------- Storage ---------- */
function storageView() {
  const body = h('div', { class: 'scroll' }), root = h('div', { class: 'view' }, h('div', { class: 'bar' }, h('strong', {}, 'Storage'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: load }, 'Refresh')), body);
  const gb = mb => (mb / 1024).toFixed(1) + ' GB';
  async function load() {
    body.replaceChildren('Loading…');
    try {
      const i = await api('/api/info'); body.replaceChildren();
      const ow = i.general && i.general.OverWrite;
      i.storage.forEach((disk, di) => disk.Partition.forEach((p, pi) => {
        const tot = parseInt(p.TotalSpace, 16), rem = parseInt(p.RemainSpace, 16);
        if (!tot) return;
        const used = tot - rem, none = p.NewStartTime.startsWith('0000');
        const cf = h('input', { type: 'text', placeholder: 'type FORMAT', style: 'width:130px' }), fb = h('button', { class: 'btn dng', disabled: true, onclick: async () => {
          try { const r = await api('/api/storage', { action: 'Clear', part: di, serial: pi, confirm: 'FORMAT' }); toast(`Format: Ret ${r.ret}`, r.ret === 100 ? 'ok' : 'bad'); load(); } catch (e) { toast(e.message, 'bad'); } } }, 'Format disk');
        cf.oninput = () => { fb.disabled = cf.value !== 'FORMAT'; };
        body.append(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 10px' }, `Disk ${di + 1} · partition ${pi + 1}${p.IsCurrent ? ' (recording)' : ''}`),
          h('div', { class: 'meter' }, h('i', { style: `width:${used / tot * 100}%` })),
          h('p', { class: 'mut' }, `${gb(used)} used of ${gb(tot)} · ${gb(rem)} free (${(rem / tot * 100).toFixed(0)}%)`),
          h('div', { class: 'kv' }, h('div', {}, 'Status'), h('div', {}, p.Status === 0 ? 'OK' : 'Code ' + p.Status), h('div', {}, 'Recordings from'), h('div', {}, none ? '—' : p.NewStartTime), h('div', {}, 'Recordings to'), h('div', {}, none ? '—' : p.NewEndTime), h('div', {}, 'Overwrite policy'), h('div', {}, ow || '?')),
          h('p', { style: 'margin-top:14px' }, h('span', { class: 'mut' }, 'Erase all recordings on this disk: '), cf, ' ', fb)));
      }));
      if (!body.children.length) body.append(h('p', { class: 'mut' }, 'No disk reported.'));
    } catch (e) { body.replaceChildren('Error: ' + e.message); }
  }
  load();
  return { el: root };
}

/* ---------- Backup, restore and firmware cards (System page) ---------- */
function cfgLabel(name) {
  if (name === 'NetWork.RemoteDeviceV3') return 'Cameras (channel setup)';
  const m = /\.\[(\d+)\]$/.exec(name), key = m ? name.replace(/\.\[\d+\]$/, '.[#]') : name;
  for (const [g, items] of PAGES) for (const it of items) if (it[1] === key) return `${g} › ${it[0]}${m ? ` · channel ${+m[1] + 1}` : ''}`;
  return name;
}
function backupCard(sys) {
  const out = h('div', {});
  const risky = n => /^NetWork\.(NetCommon|NetDHCP|NetDNS|NetPPPoE)$/.test(n);
  const pick = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); } });
  async function loadFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast('That file is not a backup', 'bad'); }
    if (!data || data.format !== 'nvr-viewer-backup' || !data.config) return toast('That file was not made by this app', 'bad');
    try { const pv = await api('/api/restore', { action: 'preview', config: data.config }); showPlan(data, pv.items); }
    catch (e) { toast(e.message, 'bad'); }
  }
  function showPlan(data, items) {
    const diff = items.filter(x => x.state === 'differs'), boxes = new Map();
    const other = data.device && data.device.serial && sys.SerialNo && data.device.serial !== sys.SerialNo;
    const head = h('p', { class: 'mut' }, `Backup made ${data.created ? new Date(data.created).toLocaleString('sv') : '?'}${data.device && data.device.firmware ? ' · firmware ' + data.device.firmware : ''}`);
    if (!diff.length) return out.replaceChildren(head, h('p', {}, 'Nothing to restore: the NVR already matches this file.'), h('p', {}, h('button', { class: 'btn', onclick: () => out.replaceChildren() }, 'Close')));
    const rows = diff.map(it => {
      const cb = h('input', { type: 'checkbox', checked: !risky(it.name) }); boxes.set(it.name, cb);
      return h('tr', {}, h('td', {}, cb), h('td', {}, cfgLabel(it.name), risky(it.name) ? h('span', { class: 'pill bad', style: 'margin-left:8px' }, 'network address') : null));
    });
    const apply = h('button', { class: 'btn pri', onclick: async () => {
      const names = [...boxes].filter(([, cb]) => cb.checked).map(([n]) => n);
      if (!names.length) return toast('Nothing selected', 'bad');
      if (names.some(risky) && !confirm('You selected network address settings. If they differ, the NVR may change address and this app will lose it. Continue?')) return;
      if (!confirm(`Write ${names.length} setting${names.length > 1 ? 's' : ''} to the NVR?`)) return;
      apply.disabled = true;
      try {
        const r = await api('/api/restore', { action: 'apply', config: data.config, names });
        if (r.failed.length) toast(`${r.done.length} restored, ${r.failed.length} refused: ${r.failed.map(f => cfgLabel(f.name) + ' (Ret ' + f.ret + ')').join(', ')}`, 'bad');
        else toast(`${r.done.length} setting${r.done.length === 1 ? '' : 's'} restored`, 'ok');
        out.replaceChildren();
      } catch (e) { toast(e.message, 'bad'); apply.disabled = false; }
    } }, 'Restore selected');
    out.replaceChildren(...[head, other ? h('div', { class: 'note' }, 'This backup came from a different NVR. Check the list carefully.') : null,
      h('p', {}, `${diff.length} setting${diff.length > 1 ? 's differ' : ' differs'} from what is on the NVR now (${items.length - diff.length} already match). Tick what to restore:`),
      h('table', {}, h('tbody', {}, rows)), h('p', {}, apply, ' ', h('button', { class: 'btn', onclick: () => out.replaceChildren() }, 'Cancel'))].filter(Boolean));
  }
  return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Backup & restore'),
    h('p', { class: 'mut', style: 'margin-top:0;max-width:640px' }, 'Saves settings (general, network, cameras, recording, alarms, image) to a file. User accounts are not included. The file contains camera and email passwords, so keep it private.'),
    h('p', {}, h('a', { class: 'btn pri', href: '/api/backup', download: '', style: 'text-decoration:none;display:inline-block' }, 'Download backup'), ' ', h('button', { class: 'btn', onclick: () => pick.click() }, 'Restore from file…'), pick), out);
}
function firmwareCard(sys) {
  return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Firmware'),
    h('div', { class: 'kv' }, h('div', {}, 'Installed version'), h('div', {}, String(sys.SoftWareVersion || '—')), h('div', {}, 'Build date'), h('div', {}, String(sys.BuildTime || '—')), h('div', {}, 'Hardware'), h('div', {}, String(sys.HardWare || '—'))),
    h('p', { class: 'mut', style: 'max-width:640px' }, 'Flashing firmware is not offered here. A wrong or interrupted file can leave the NVR unable to start, and it cannot be tested safely without the exact file for this model. Download a backup first and use the manufacturer’s tool or the NVR’s local menu (Maintain › Upgrade, USB stick) for updates.'));
}


function timeSyncBox() {
  const box = h('div', { class: 'tsync' });
  async function draw() {
    let c; try { c = await api('/api/timesync'); } catch (e) { return box.replaceChildren('Error: ' + e.message); }
    const st = c.state || {}, ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
    const save = async (ev) => { try { await api('/api/timesync', { enabled: on.checked, everyMin: +every.value, background: on.checked && bg.checked, replace: !!(ev && ev.target === bg) }); toast(on.checked ? 'Auto sync on' : 'Auto sync off', 'ok'); setTimeout(draw, 1500); } catch (e) { toast(e.message, 'bad'); } };
    const on = h('input', { type: 'checkbox', checked: !!c.enabled, onchange: save });
    const bg = h('input', { type: 'checkbox', checked: !!c.background, disabled: !c.enabled, onchange: save });
    const every = h('select', { onchange: save }, [[5, '5 minutes'], [15, '15 minutes'], [60, 'hour'], [360, '6 hours'], [1440, 'day']].map(([m, t]) => h('option', { value: m, selected: m === c.everyMin }, t)));
    const line = !c.enabled ? 'Off' : st.error ? 'Problem: ' + st.error : st.lastCheck ? `Checked ${ago(st.lastCheck)}, ${Math.abs(st.driftSec) <= 2 ? 'clock was right' : `was ${Math.abs(st.driftSec)} s ${st.driftSec > 0 ? 'behind' : 'ahead'}${st.lastSet ? ', corrected ' + ago(st.lastSet) : ''}`}` : 'Waiting for the first check…';
    box.replaceChildren(h('div', { class: 'f fsw', style: 'max-width:520px' }, h('label', {}, 'Always keep the NVR clock in sync with this computer'), h('label', { class: 'sw' }, on, h('span', {}))),
      h('p', { style: 'margin:10px 0 4px' }, 'Check every ', every), h('p', { class: st.error ? 'warn' : 'mut', style: 'margin:4px 0;font-size:12.5px' }, line),
      h('label', { style: 'display:flex;gap:8px;align-items:flex-start;max-width:560px;margin:8px 0' }, bg, h('span', {}, 'Keep syncing even when nobody is signed in to this app', h('br'), h('small', { class: 'mut' }, c.background ? `Using the login of ${c.background.user}.` : `Will use your login (${c.you}).`))),
      h('p', { class: 'mut', style: 'font-size:12px;max-width:560px' }, c.background
        ? `The login of "${c.background.user}" is saved in plain text in the file timesync-login.json in this app's folder, so the server can check the clock on its own (also after a restart). Anyone who can read that folder can read it. Untick the box to delete it. Tip: use an NVR account that only needs to set the time. If that account's password changes, sign in and save again.`
        : 'Without the box ticked, the check only runs while someone is signed in, and the app keeps no passwords. It only changes the clock if it is more than 2 seconds off.'));
  }
  draw();
  return box;
}
/* ---------- System ---------- */
function systemView() {
  const body = h('div', { class: 'scroll' }), root = h('div', { class: 'view' }, h('div', { class: 'bar' }, h('strong', {}, 'System'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: load }, 'Refresh')), body);
  async function load() {
    body.replaceChildren('Loading…');
    try {
      const i = await api('/api/info'), s = i.system, kv = [];
      const add = (k, v) => kv.push(h('div', {}, k), h('div', {}, String(v)));
      add('Device type', i.login && i.login['DeviceType '] || s.DeviceType); add('Hardware', s.HardWare); add('Serial number', s.SerialNo); add('Firmware', s.SoftWareVersion); add('Build time', s.BuildTime);
      add('Uptime', (() => { const m = parseInt(s.DeviceRunTime, 16); return `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h ${m % 60}m`; })());
      add('Digital channels', s.DigChannel); add('Analog channels', s.VideoInChannel); add('Alarm in / out', `${s.AlarmInChannel} / ${s.AlarmOutChannel}`); add('Audio in', s.AudioInChannel); add('Machine name', i.general && i.general.MachineName);
      const rb = h('button', { class: 'btn dng', disabled: true, onclick: async () => { try { const r = await api('/api/machine', { action: 'Reboot', confirm: 'REBOOT' }); toast(`Reboot: Ret ${r.ret}`, r.ret === 100 ? 'ok' : 'bad'); } catch (e) { toast(e.message, 'bad'); } } }, 'Reboot NVR');
      const rc = h('input', { type: 'text', placeholder: 'type REBOOT', style: 'width:130px', oninput: () => { rb.disabled = rc.value !== 'REBOOT'; } });
      const sync = h('button', { class: 'btn', onclick: async () => { const d = new Date(); const t = `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 8)}`; try { const r = await api('/api/time', { time: t }); toast(`Time set: Ret ${r.ret}`, r.ret === 100 ? 'ok' : 'bad'); load(); } catch (e) { toast(e.message, 'bad'); } } }, 'Set NVR time to this PC');
      body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'kv' }, kv)),
        h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Time'), h('div', { class: 'kv' }, h('div', {}, 'NVR time'), h('div', {}, i.time), h('div', {}, 'This PC'), h('div', {}, new Date().toLocaleString('sv'))), h('p', {}, sync), timeSyncBox()),
        backupCard(s), firmwareCard(s),
        h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Maintenance'), rc, ' ', rb));
    } catch (e) { body.replaceChildren('Error: ' + e.message); }
  }
  load();
  return { el: root };
}

/* ---------- shell ---------- */
const VIEWS = { live: liveView, cameras: camerasView, playback: playbackView, events: eventsView, settings: settingsView, storage: storageView, users: usersView, system: systemView };
let current = null, seq = 0;
async function show(tab) {
  const my = ++seq;
  if (current && current.destroy) current.destroy();
  current = null; $('#view').replaceChildren();
  [...$('#nav').children].forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#pageTitle').textContent = tab[0].toUpperCase() + tab.slice(1);
  store.set('tab', tab);
  const v = await VIEWS[tab]();
  if (my !== seq) { v.destroy && v.destroy(); return; }
  current = v; $('#view').append(v.el);
  if (v.el.querySelector('#liveGrid')) window.dispatchEvent(new Event('resize'));
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('sv'); }, 1000);
setInterval(() => api('/api/state').then(s => { $('#dot').className = 'dot ' + (s.ok ? 'ok' : 'bad'); $('#nvrState').textContent = s.ok ? 'NVR connected' : 'NVR offline'; }).catch(() => { $('#dot').className = 'dot bad'; }), 8000);
function setBrand(n) { $('#brandName').textContent = n; document.title = n; }
async function signOut() { try { await api('/api/logout', {}); } catch {} location.href = '/login.html'; }
$('#logout').onclick = signOut; $('#logout2').onclick = signOut;
api('/api/state').then(s => { $('#dot').className = 'dot ' + (s.ok ? 'ok' : 'bad'); }).catch(() => {});
api('/api/session').then(s => { if (s.user) { $('#userName').textContent = s.user; setBrand(s.name); } }).catch(() => {});
show(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : store.get('tab', 'live'));
