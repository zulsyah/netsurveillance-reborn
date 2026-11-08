// Minimal H.264 -> MP4 muxer (single video track, no B-frames, moov before mdat).
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, ver, flags, ...kids) => box(type, Buffer.from([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...kids);

// split Annex-B access unit into NAL units (without start codes)
function splitNals(d) {
  const out = []; let i = 0, start = -1;
  while (i + 2 < d.length) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      if (start >= 0) { let e = i; while (e > start && d[e - 1] === 0) e--; out.push(d.subarray(start, e)); }
      start = i + 3; i += 3;
    } else i++;
  }
  if (start >= 0 && start < d.length) out.push(d.subarray(start));
  return out;
}
function unescape(nal) {
  const o = []; let z = 0;
  for (let i = 0; i < nal.length; i++) {
    if (z >= 2 && nal[i] === 3) { z = 0; continue; }
    o.push(nal[i]); z = nal[i] === 0 ? z + 1 : 0;
  }
  return Buffer.from(o);
}
function spsSize(nal) {
  const d = unescape(nal.subarray(1)); let pos = 0;
  const bit = () => { const v = (d[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
  const bits = n => { let v = 0; while (n--) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (!bit() && z < 32) z++; return z ? (2 ** z - 1) + bits(z) : 0; };
  const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
  const profile = bits(8); bits(16); ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue(); if (chroma === 3) bit(); ue(); ue(); bit();
    if (bit()) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (bit()) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) { next = (last + se() + 256) % 256; } last = next || last; } }
  }
  ue();
  const poc = ue();
  if (poc === 0) ue(); else if (poc === 1) { bit(); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
  ue(); bit();
  const w = ue() + 1, hm = ue() + 1, frameMbsOnly = bit();
  if (!frameMbsOnly) bit();
  bit();
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (bit()) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
  const cux = chroma === 0 ? 1 : 2, cuy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return { width: w * 16 - (cl + cr) * (chroma === 0 ? 1 : cux), height: hm * 16 * (2 - frameMbsOnly) - (ct + cb) * (chroma === 0 ? (2 - frameMbsOnly) : cuy) };
}

// frames: [{key:boolean, data:Buffer(Annex-B AU)}], fps: number -> Buffer(mp4)
function muxH264(frames, fps = 25) {
  let sps = null, pps = null;
  const samples = [], sync = [];
  for (const f of frames) {
    const parts = []; let isKey = f.key;
    for (const n of splitNals(f.data)) {
      const t = n[0] & 31;
      if (t === 7) { if (!sps) sps = Buffer.from(n); continue; }
      if (t === 8) { if (!pps) pps = Buffer.from(n); continue; }
      if (t === 9) continue;
      if (t === 5) isKey = true;
      parts.push(u32(n.length), n);
    }
    if (!parts.length) continue;
    if (isKey) sync.push(samples.length + 1);
    samples.push(Buffer.concat(parts));
  }
  if (!sps || !pps || !samples.length) throw new Error('no video data');
  const { width, height } = spsSize(sps);
  const TS = 90000, delta = Math.round(TS / (fps || 25)), n = samples.length, dur = n * delta;
  const mdatSize = samples.reduce((a, s) => a + s.length, 0);
  const matrix = Buffer.concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));
  const avcC = box('avcC', Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps);
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), avcC);
  const stsd = full('stsd', 0, 0, u32(1), avc1);
  const stts = full('stts', 0, 0, u32(1), u32(n), u32(delta));
  const stss = full('stss', 0, 0, u32(sync.length), ...sync.map(u32));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
  const stsz = full('stsz', 0, 0, u32(0), u32(n), ...samples.map(s => u32(s.length)));
  const build = off => {
    const stco = full('stco', 0, 0, u32(1), u32(off));
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', full('vmhd', 0, 1, Buffer.alloc(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(dur), u16(0x55c4), u16(0)), full('hdlr', 0, 0, u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0')), minf);
    const trak = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(Math.round(dur / TS * 1000)), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width << 16), u32(height << 16)), mdia);
    return box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(dur / TS * 1000)), u32(0x10000), u16(0x100), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2)), trak);
  };
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'));
  const moovLen = build(0).length;
  const moov = build(ftyp.length + moovLen + 8);
  return Buffer.concat([ftyp, moov, u32(8 + mdatSize), Buffer.from('mdat'), ...samples]);
}
module.exports = { muxH264, spsSize };
