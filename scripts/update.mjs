// SDCA daily feed — runs on GitHub's servers (GitHub Actions), no PC needed.
// Reads the 9 checkonchain charts, computes each indicator's score exactly like the dashboard
// (osc: 1 − value/100; rank: 1 − expanding percentile rank), cross-checks the BTC price,
// and writes sdca_data.json + sdca_data.js (with an FNV-1a checksum) for the dashboard to read.
import fs from 'node:fs';

const IND = [
  ['mri','meanreversion_index/meanreversion_index','Index','osc'],
  ['rp','quantiles_realizedprice/quantiles_realizedprice','Quantile Oscillator','osc'],
  ['sth','quantiles_realizedprice_sth/quantiles_realizedprice_sth','Quantile Oscillator','osc'],
  ['d200','quantiles_200dma/quantiles_200dma','Quantile Oscillator','osc'],
  ['w200','quantiles_200wma/quantiles_200wma','Quantile Oscillator','osc'],
  ['pl','pricing_powerlaw_porkopolis/pricing_powerlaw_porkopolis','Power Law Oscillator','rank'],
  ['ism','ism_pmi_bitcoin/ism_pmi_bitcoin','Bitcoin vs Trend Index','rank'],
  ['plq','quantiles_powerlaw/quantiles_powerlaw','Quantile Oscillator','osc'],
  ['tmm','quantiles_pricetruemean/quantiles_pricetruemean','Quantile Oscillator','osc']];
const BASE = process.env.SDCA_BASE || 'https://charts-cdn.checkonchain.com/btconchain/pricing/';
const UA = {'User-Agent': 'Mozilla/5.0 (sdca-feed; daily read of public charts)'};

const hash = js => { let h = 0x811c9dc5; for (let i = 0; i < js.length; i++) { h ^= js.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const decode = v => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && v.bdata != null) {
    const T = {f8: Float64Array, f4: Float32Array, i4: Int32Array, i2: Int16Array, i1: Int8Array, u4: Uint32Array, u2: Uint16Array, u1: Uint8Array}[v.dtype];
    if (!T) throw new Error('unknown dtype ' + v.dtype);
    const b = Buffer.from(v.bdata, 'base64'); const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return Array.from(new T(ab));
  }
  return [];
};
// pull the traces array out of a Plotly HTML export: Plotly.newPlot("id", [ …traces… ], {layout}, …)
const traces = html => {
  const p = html.indexOf('Plotly.newPlot('); if (p < 0) throw new Error('no chart in page');
  const a = html.indexOf('[', p); let depth = 0, inStr = false, esc = false, b = -1;
  for (let i = a; i < html.length; i++) { const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) { b = i; break; } } }
  if (b < 0) throw new Error('chart data cut off');
  return JSON.parse(html.slice(a, b + 1)).map(t => ({name: t.name, x: decode(t.x), y: decode(t.y)}));
};
const get = async (url, tries = 3) => {
  let err; for (let k = 0; k < tries; k++) {
    try { const r = await fetch(url, {headers: UA, signal: AbortSignal.timeout(60000)}); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
    catch (e) { err = e; await new Promise(r => setTimeout(r, 5000 * (k + 1))); } }
  throw err;
};

const latestClose = () => { const now = new Date(); const m = now.getUTCHours() * 60 + now.getUTCMinutes(); return new Date(m >= 23 * 60 + 15 ? now : now - 864e5).toISOString().slice(0, 10); };

// pages are downloaded once; build(cutoff) works out the scores using only days up to the cutoff
const PAGES = {};
async function read(cutoff) {
  const out = {v: 1, fetched: new Date().toISOString().slice(0, 16) + 'Z', ind: {}, errors: []};
  const ok = v => typeof v === 'number' && isFinite(v), last7 = {};
  for (const [id, path, trace, mode] of IND) {
    try {
      const T = PAGES[id] || (PAGES[id] = traces(await get(BASE + path + '_light.html?t=' + Date.now())));
      const t = T.find(q => q.name === trace); if (!t) throw new Error('trace missing');
      const pt = T.find(q => q.name === 'Price' || q.name === 'Bitcoin Price');
      const pmap = {}; if (pt) for (let i = 0; i < pt.x.length; i++) if (ok(pt.y[i])) pmap[String(pt.x[i]).slice(0, 10)] = pt.y[i];
      const D = [], V = []; for (let i = 0; i < t.x.length; i++) if (ok(t.y[i]) && String(t.x[i]).slice(0, 10) <= cutoff) { D.push(String(t.x[i]).slice(0, 10)); V.push(t.y[i]); }
      if (V.length < 500) throw new Error('short history');
      const score = new Array(V.length);
      if (mode === 'osc') for (let i = 0; i < V.length; i++) score[i] = 1 - V[i] / 100;
      else { const s = []; const lb = x => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < x) lo = m + 1; else hi = m; } return lo; };
        for (let i = 0; i < V.length; i++) { s.splice(lb(V[i]), 0, V[i]); score[i] = 1 - lb(V[i]) / s.length; } }
      const n = V.length;
      out.ind[id] = [D[n - 1], +V[n - 1].toFixed(4), +score[n - 1].toFixed(4), pmap[D[n - 1]] != null ? Math.round(pmap[D[n - 1]]) : null];
      for (let j = Math.max(0, n - 7); j < n; j++) (last7[D[j]] = last7[D[j]] || []).push(score[j]);
    } catch (e) { out.errors.push(id + ': ' + e.message); }
  }
  const dates = [...new Set(Object.values(out.ind).map(x => x[0]))].sort();
  out.asof = dates[0] || null;
  out.hist = Object.keys(last7).sort().filter(d => last7[d].length === 9).map(d => [d, +(last7[d].reduce((a, b) => a + b, 0) / 9).toFixed(4)]);
  // independent BTC close for the cross-check (GitHub runs in the US, where api.binance.com is blocked)
  out.binClose = null;
  const day = Date.parse(out.asof + 'T00:00:00Z');
  try { const k = JSON.parse(await get('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=' + day + '&limit=1', 2)); out.binClose = Math.round(+k[0][4]); out.closeSrc = 'Binance'; }
  catch (e) { try { const c = JSON.parse(await get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=' + new Date(day).toISOString() + '&end=' + new Date(day + 864e5 - 1000).toISOString(), 2)); out.binClose = Math.round(c[0][4]); out.closeSrc = 'Coinbase'; } catch (e2) {} }
  out.src = 'GitHub daily job';
  return out;
}

const prev = (() => { try { return JSON.parse(fs.readFileSync('sdca_data.json', 'utf8')).data; } catch (e) { return null; } })();
const want = latestClose();

const dayBefore = x => new Date(Date.parse(x + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
const priceOf = o => IND.map(r => o.ind[r[0]] && o.ind[r[0]][3]).find(x => x > 0);
let d = await read(want), pending = null;
// checkonchain posts each new day early in that day and only finalises it at its end-of-day update (usually ~23:13 UTC, sometimes hours later).
// Until then that day's price is far from the Binance close, so use the day before and try again on the next run.
const lateRange = async day => {   // BTC low/high over the last 3 hours of that UTC day (when checkonchain's end-of-day update normally runs)
  const t0 = Date.parse(day + 'T21:00:00Z');
  try { const k = JSON.parse(await get('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=' + t0 + '&limit=3', 2)); if (k.length) return [Math.min(...k.map(r => +r[3])), Math.max(...k.map(r => +r[2]))]; } catch (e) {}
  try { const c = JSON.parse(await get('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=' + new Date(t0).toISOString() + '&end=' + new Date(t0 + 3 * 3600e3).toISOString(), 2)); if (c.length) return [Math.min(...c.map(r => r[1])), Math.max(...c.map(r => r[2]))]; } catch (e) {}
  return null; };
{ const p0 = priceOf(d);
  if (d.asof && p0 && !d.errors.length) {
    const rg = await lateRange(d.asof);
    const final = rg ? (p0 >= rg[0] * 0.995 && p0 <= rg[1] * 1.005) : !(d.binClose && Math.abs(p0 / d.binClose - 1) > 0.015);
    if (!final) {
      pending = d.asof; console.log('checkonchain has not finalised ' + pending + ' yet (its price ' + p0 + ', BTC late-day range ' + (rg ? rg.map(Math.round).join('–') : 'n/a') + '); using the day before');
      d = await read(dayBefore(pending)); } } }
const ids = IND.map(r => r[0]);
const problems = [];
if (d.errors.length) problems.push('errors: ' + d.errors.join('; '));
if (ids.some(id => !d.ind[id])) problems.push('missing indicators');
if (new Set(ids.filter(id => d.ind[id]).map(id => d.ind[id][0])).size !== 1) problems.push('indicators from different days');
if (ids.some(id => d.ind[id] && !(d.ind[id][2] >= 0 && d.ind[id][2] <= 1))) problems.push('score outside 0–1');
const p = ids.map(id => d.ind[id] && d.ind[id][3]).find(x => x > 0);
if (p && d.binClose && Math.abs(p / d.binClose - 1) > 0.03) problems.push('checkonchain price ' + p + ' is >3% from ' + d.closeSrc + ' ' + d.binClose);
const bottom = ids.every(id => d.ind[id]) ? ids.reduce((a, id) => a + d.ind[id][2], 0) / 9 : null;
console.log(JSON.stringify({asof: d.asof, want, bottom: bottom && +bottom.toFixed(4), problems}));
if (problems.length) { console.error('NOT saved: ' + problems.join(' | ')); process.exit(1); }
if (prev && d.asof < prev.asof && !process.env.FORCE) { console.log('older than saved ' + prev.asof + '; keeping it'); process.exit(0); }
if (pending && prev && d.asof === prev.asof && !process.env.FORCE) { console.log('waiting for checkonchain to finalise ' + pending + '; ' + prev.asof + ' already saved'); process.exit(0); }
if (prev && d.asof === prev.asof && JSON.stringify(d.ind) === JSON.stringify(prev.ind) && JSON.stringify(d.hist) === JSON.stringify(prev.hist) && !process.env.FORCE) { console.log('no change for ' + d.asof); process.exit(0); }
if (d.asof < want) console.log('note: checkonchain has not published ' + want + ' yet; saving ' + d.asof);

if (pending) d.pending = pending;
const feed = {data: d, sum: hash(JSON.stringify(d))};
fs.writeFileSync('sdca_data.json', JSON.stringify(feed));
fs.writeFileSync('sdca_data.js', 'window.SDCA_FEED = ' + JSON.stringify(feed) + ';\n');
// keep a small history file (one line per close) for audit
const line = JSON.stringify({d: d.asof, bottom: +bottom.toFixed(4), ind: Object.fromEntries(ids.map(id => [id, d.ind[id][2]])), fetched: d.fetched}) + '\n';
const hp = 'history.jsonl'; const old = fs.existsSync(hp) ? fs.readFileSync(hp, 'utf8') : '';
fs.writeFileSync(hp, old.split('\n').filter(l => { try { return l && JSON.parse(l).d < d.asof; } catch (e) { return false; } }).map(l => l + '\n').join('') + line);
console.log('saved ' + d.asof + ' bottom ' + bottom.toFixed(4));
