require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const E = process.env;
const PORT = E.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const F = n => path.join(DATA_DIR, n);
const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), 'utf8')); } catch { return d; } };
const wr = (n, d) => fs.writeFileSync(F(n), JSON.stringify(d, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.set('trust proxy', 1);
app.use(cors({ origin: E.CORS_ORIGIN && E.CORS_ORIGIN !== '*' ? E.CORS_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '2mb' }));

/* ---------- utilitaires ---------- */
const hits = new Map();
const limit = (key, max, ms) => (req, res, next) => {
  const k = key + req.ip, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'Trop de demandes, réessayez plus tard' });
  a.push(now); hits.set(k, a); next();
};
const admin = (req, res, next) =>
  E.ADMIN_KEY && req.headers['x-admin-key'] === E.ADMIN_KEY ? next() : res.status(401).json({ error: 'Non autorisé' });
const okEmail = e => /^\S+@\S+\.\S+$/.test(e || '');
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => { const m = String(v ?? '').match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; }; // "2.5 -- 4" -> 2.5 (prix le plus bas)
const baseUrl = req => (E.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

/* ---------- MARGE CACHEE (10 USD par produit) + DEVISES ---------- */
const PROFIT_USD = Number(E.PROFIT_USD || 10);
const CUR_BY_COUNTRY = {
  FR:'EUR',DE:'EUR',ES:'EUR',IT:'EUR',BE:'EUR',AT:'EUR',NL:'EUR',PT:'EUR',IE:'EUR',FI:'EUR',GR:'EUR',LU:'EUR',
  US:'USD',GB:'GBP',CA:'CAD',AU:'AUD',CH:'CHF',BR:'BRL',IN:'INR',ZA:'ZAR',MA:'MAD',DZ:'DZD',TN:'TND',EG:'EGP',
  NG:'NGN',GH:'GHS',KE:'KES',AE:'AED',JP:'JPY',MX:'MXN',
  CM:'XAF',GA:'XAF',CG:'XAF',TD:'XAF',CF:'XAF',GQ:'XAF',
  SN:'XOF',CI:'XOF',BJ:'XOF',BF:'XOF',ML:'XOF',NE:'XOF',TG:'XOF',GW:'XOF'
};
const NO_DEC = ['XAF','XOF','JPY','KRW','UGX','RWF'];
const curFor = c => CUR_BY_COUNTRY[String(c || '').toUpperCase()] || 'USD'; // dollar par défaut
const curOf = q => { const c = String((q && q.currency) || '').toUpperCase(); return RATES[c] ? c : curFor(q && q.country); }; // la devise demandée par le site gagne
let RATES = { USD:1, EUR:.92, GBP:.78, CAD:1.37, AUD:1.5, CHF:.88, BRL:5.5, INR:84, ZAR:18, MAD:10, DZD:135, TND:3.1, EGP:48,
  NGN:1500, GHS:15, KES:130, AED:3.67, JPY:150, MXN:18, XAF:603, XOF:603 }; // secours, remplacés par les taux du jour
let ratesAt = 0;
async function refreshRates() {
  if (Date.now() - ratesAt < 12 * 3600000) return;
  ratesAt = Date.now();
  try {
    const d = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
    if (d.rates) RATES = { ...RATES, ...d.rates };
  } catch (e) { console.error('taux:', e.message); }
}
const local = (usd, cur) => {
  const v = usd * (RATES[cur] || 1);
  return NO_DEC.includes(cur) ? Math.round(v / 5) * 5 : Math.round(v * 100) / 100;
};
const priceCache = new Map(); // id -> prix USD (marge incluse)
const withProfit = base => Math.round((base + PROFIT_USD) * 100) / 100;

/* ---------- CJ DROPSHIPPING ---------- */
const CJ = 'https://developers.cjdropshipping.com/api2.0/v1';
let cjTok = { t: '', exp: 0 };
async function cjToken(force) {
  if (E.CJ_ACCESS_TOKEN) return E.CJ_ACCESS_TOKEN;
  if (!force && cjTok.t && Date.now() < cjTok.exp) return cjTok.t;
  if (!E.CJ_API_KEY) throw new Error('CJ_API_KEY manquante');
  const r = await fetch(`${CJ}/authentication/getAccessToken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: E.CJ_API_KEY })
  });
  const d = await r.json();
  if (!d.data?.accessToken) throw new Error('CJ token refusé : ' + (d.message || r.status));
  cjTok = { t: d.data.accessToken, exp: Date.now() + 14 * 24 * 3600000 }; // valable 180 jours, on renouvelle avant
  await sleep(1100); // CJ : 1 requête par seconde maximum
  return cjTok.t;
}
// CJ limite le débit (environ 1 requête/seconde) : on fait la queue
let cjChain = Promise.resolve();
function cjGet(pathq) {
  const run = async () => {
    let d;
    for (let k = 0; k < 2; k++) {
      const t = await cjToken(k > 0);
      d = await (await fetch(CJ + pathq, { headers: { 'CJ-Access-Token': t } })).json();
      if (d.result !== false || !/token|auth/i.test(d.message || '')) break;
    }
    await sleep(1100);
    return d;
  };
  const p = cjChain.then(run, run);
  cjChain = p.catch(() => {});
  return p;
}
const cjUrl = id => `https://cjdropshipping.com/product/-p-${id}.html`;
const CAT_Q = { // mots-clés « tendance / stylé » envoyés à CJ
  Electronics: 'bluetooth earbuds', Fashion: 'stylish streetwear', Home: 'led light decor', Phones: 'stylish phone case',
  Computers: 'gaming rgb', Fitness: 'fitness band', Sports: 'sports outdoor', Watches: 'smart watch',
  Beauty: 'beauty tools', Automotive: 'car led accessories', Toys: 'fidget toys'
};
// Accueil = un mélange de toutes les catégories, avec le Bluetooth et les montres en tête
const HOME_MIX = [['Electronics', 'bluetooth earbuds'], ['Watches', 'smart watch'], ['Fashion', 'stylish streetwear'],
  ['Electronics', 'bluetooth speaker'], ['Home', 'led light decor'], ['Phones', 'stylish phone case'],
  ['Computers', 'gaming rgb'], ['Beauty', 'beauty tools'], ['Fitness', 'fitness band']];
const COOL = '&orderBy=1&sort=desc&endSellPrice=30'; // les plus listés par les vendeurs = les plus populaires, prix max 30 $


function mapCJ(list, cat) { // produits bruts (prix en USD, marge incluse)
  return (list || []).map((x, i) => {
    const base = num(x.nowPrice) || num(x.sellPrice), img = x.bigImage || x.productImage;
    if (!x.id || !img || base <= 0) return null;
    const usd = withProfit(base);
    priceCache.set(String(x.id), usd);
    return { id: String(x.id), name: x.nameEn || x.productNameEn || x.name || 'Produit', usd, image: String(img).split(',')[0],
      itemUrl: cjUrl(x.id), category: cat || '', pop: num(x.listedNum), pos: i };
  }).filter(Boolean);
}
const kwCache = new Map(); // mot-clé -> {at, items}
async function cjItems(q, cat, size = 40, extra = '') {
  const k = q + '|' + size + '|' + extra, hit = kwCache.get(k);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit.items.map(x => ({ ...x, category: cat || x.category }));
  const d = await cjGet(`/product/listV2?page=1&size=${size}${q ? '&keyWord=' + encodeURIComponent(q) : ''}${extra}`);
  if (d.result === false || !d.data) console.error('CJ listV2 refusé :', d.code, d.message);
  const list = (d.data?.content || []).flatMap(c => c.productList || []).concat(d.data?.list || []);
  const items = mapCJ(list, cat);
  if (items.length) kwCache.set(k, { at: Date.now(), items });
  return items;
}
// Accueil : prix bas (50 %) + popularité CJ (30 %) + pertinence (20 %)
function rank(items) {
  const n = items.length || 1, maxPop = Math.max(1, ...items.map(i => i.pop || 0));
  const pr = new Map([...items].sort((a, b) => a.usd - b.usd).map((it, i) => [it.id, i / n]));
  return items.map((it, i) => ({ it, s: pr.get(it.id) * .5 + (1 - (it.pop || 0) / maxPop) * .3 + (i / n) * .2 }))
    .sort((a, b) => a.s - b.s).map(o => o.it);
}
// Tendance : popularité (50 %), prix (30 %), pertinence (20 %)
function rankCool(items) {
  const n = items.length || 1, maxPop = Math.max(1, ...items.map(i => i.pop || 0));
  const pr = new Map([...items].sort((a, b) => a.usd - b.usd).map((it, i) => [it.id, i / n]));
  return items.map((it, i) => ({ it, s: (1 - (it.pop || 0) / maxPop) * .5 + pr.get(it.id) * .3 + (i / n) * .2 }))
    .sort((a, b) => a.s - b.s).map(o => o.it);
}
// 1 produit de chaque catégorie à tour de rôle : le mélange reste varié du haut en bas
function interleave(groups) {
  const out = [], seen = new Set();
  for (let i = 0; groups.some(g => i < g.length); i++)
    for (const g of groups) if (g[i] && !seen.has(g[i].id)) { seen.add(g[i].id); out.push(g[i]); }
  return out;
}
const present = (items, cur) => items.map(({ usd, pop, pos, px, ...r }) => ({ ...r, price: local(usd, cur), currency: cur, sold: 0, shipping: '' }));

/* ---------- RESOLUTION : on mesure vraiment la taille de chaque image ---------- */
const MIN_IMG = Number(E.MIN_IMG_PX || 800);
const imgCache = new Map();
function imgSize(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return Math.max(b.readUInt16BE(i + 5), b.readUInt16BE(i + 7));
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b[0] === 0x89 && b[1] === 0x50) return Math.max(b.readUInt32BE(16), b.readUInt32BE(20));
  return 0;
}
async function imgPx(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  let px = 0;
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-131071' }, signal: AbortSignal.timeout(4000) });
    if (r.ok) px = imgSize(Buffer.from(await r.arrayBuffer()));
  } catch (e) { /* injoignable */ }
  if (imgCache.size > 5000) imgCache.clear();
  imgCache.set(url, px);
  return px;
}
async function sharpOnly(list, max) { // images nettes d'abord, puis les moins floues
  const out = [];
  for (let i = 0; i < list.length; i += 12) {
    const chunk = list.slice(i, i + 12);
    const px = await Promise.all(chunk.map(x => imgPx(x.image)));
    chunk.forEach((x, k) => out.push({ ...x, px: px[k] }));
  }
  return out.filter(x => x.px >= MIN_IMG).concat(out.filter(x => x.px < MIN_IMG).sort((a, b) => b.px - a.px)).slice(0, max);
}

/* ---------- CATALOGUE ---------- */
const homeCache = new Map();
const building = new Map(); // un seul chargement à la fois par catégorie (CJ : 1 requête/seconde)
function homeItems(cat) {
  const ck = cat || 'All', hit = homeCache.get(ck);
  if (hit && Date.now() - hit.at < 600000) return Promise.resolve(hit.items);
  if (building.has(ck)) return building.get(ck);
  const p = buildHome(cat).finally(() => building.delete(ck));
  building.set(ck, p);
  return p;
}
async function buildHome(cat) {
  const one = cat && cat !== 'All', ck = cat || 'All';
  let items;
  if (one) {
    items = await cjItems(CAT_Q[cat] || cat, cat, 60, COOL);
    if (!items.length) items = await cjItems(CAT_Q[cat] || cat, cat, 60);
    items = rankCool(items);
  } else {
    const groups = [];
    for (const [c, q] of HOME_MIX) {
      try { const g = await cjItems(q, c, 24, COOL); if (g.length) groups.push(rankCool(g).slice(0, 10)); }
      catch (e) { if (/token|CJ_API_KEY/i.test(e.message)) throw e; console.error('accueil', q, e.message); }
    }
    items = interleave(groups);
  }
  if (!items.length) throw new Error('catalogue vide (voir « CJ listV2 refusé » plus haut dans les logs)');
  const out = await sharpOnly(items.slice(0, 90), 80);
  homeCache.set(ck, { at: Date.now(), items: out });
  return out;
}
const localCatalog = cur => rd('products.json', []).map(x => {
  const usd = withProfit(num(x.price));
  cur = cur || 'USD';
  priceCache.set(String(x.id), usd);
  return { ...x, id: String(x.id), usd, price: local(usd, cur), currency: cur };
});

app.get('/api/catalog/home', async (req, res) => {
  const cur = curOf(req.query);
  try {
    await refreshRates();
    res.json({ ok: true, currency: cur, items: present((await homeItems(req.query.cat)).slice(0, Math.min(Number(req.query.limit || 60), 80)), cur) });
  } catch (e) {
    console.error('catalog/home:', e.message);
    res.status(502).json({ error: 'Catalogue indisponible' });
  }
});
app.get('/api/catalog/search', async (req, res) => {
  const cur = curOf(req.query);
  try {
    await refreshRates();
    const q = String(req.query.q || '').slice(0, 100).trim();
    if (!q) return res.json({ ok: true, currency: cur, items: [] });
    const items = await sharpOnly(rank(await cjItems(q, '', 40)).slice(0, 60), 60);
    res.json({ ok: true, currency: cur, items: present(items, cur) });
  } catch (e) { console.error('search:', e.message); res.status(502).json({ error: 'Recherche indisponible' }); }
});

const pickName = v => {
  if (Array.isArray(v)) return v[0] || '';
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v)[0] || ''; } catch (e) { /* texte simple */ } }
  return v || '';
};
const imgList = v => {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v).filter(Boolean); } catch (e) { return []; } }
  return typeof v === 'string' && v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
};
async function cjDetail(id) {
  const d = await cjGet(`/product/query?pid=${encodeURIComponent(id)}`), p = d.data;
  if (!p || (!p.bigImage && !p.productImage && !p.productName && !p.productNameEn)) return null;
  const variants = (p.variants || []).map(v => num(v.variantSellPrice)).filter(x => x > 0);
  const base = num(p.nowPrice) || num(p.sellPrice) || (variants.length ? Math.min(...variants) : 0);
  const images = [...imgList(p.bigImage), ...imgList(p.productImage), ...imgList(p.productImageSet)];
  return {
    id: String(id), name: pickName(p.productNameEn ?? p.productName), base, images: [...new Set(images)],
    description: String(p.description || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500)
  };
}
app.get('/api/catalog/item', async (req, res) => {
  const id = String(req.query.itemId || req.query.id || ''), cur = curOf(req.query);
  try {
    await refreshRates();
    const loc = localCatalog(cur).find(x => x.id === id);
    if (loc) { const { usd, ...r } = loc; return res.json({ ok: true, ...r, img: r.image, item: r }); }
    const d = await cjDetail(id);
    if (!d) return res.status(404).json({ error: 'Produit introuvable' });
    const usd = priceCache.get(id) ?? (d.base > 0 ? withProfit(d.base) : null); // même prix que dans la liste
    if (usd == null) return res.status(404).json({ error: 'Prix indisponible' });
    priceCache.set(id, usd);
    const item = { id, name: d.name, price: local(usd, cur), currency: cur, image: d.images[0] || '', img: d.images[0] || '',
      images: d.images, description: d.description, itemUrl: cjUrl(id) };
    res.json({ ok: true, ...item, item });
  } catch (e) { console.error('item:', e.message); res.status(502).json({ error: 'Détail indisponible' }); }
});

/* ---------- PRODUITS SIMILAIRES ---------- */
const STOP = new Set(['the','and','for','with','new','neuf','pour','avec','les','des','pack','lot','set','pcs','style','high','quality','free','shipping']);
const keywords = name => String(name || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/)
  .filter(w => w.length > 2 && !STOP.has(w) && !/\d/.test(w)).slice(0, 3).join(' ');
app.get('/api/catalog/similar', async (req, res) => {
  const cur = curOf(req.query);
  try {
    await refreshRates();
    const q = keywords(req.query.name) || String(req.query.q || '').slice(0, 60), id = String(req.query.itemId || '');
    if (!q) return res.json({ ok: true, items: [] });
    const items = (await cjItems(q, String(req.query.category || ''), 30)).filter(i => i.id !== id);
    const max = Math.min(Number(req.query.limit || 8), 12);
    res.json({ ok: true, currency: cur, items: present(await sharpOnly(rank(items).slice(0, 24), max), cur) });
  } catch (e) { console.error('similar:', e.message); res.json({ ok: true, items: [] }); }
});

// Diagnostic : ouvrez /api/cj-status dans le navigateur pour voir si la clé CJ fonctionne (aucun secret affiché)
app.get('/api/cj-status', limit('cs', 8, 3600000), async (req, res) => {
  const out = { cleCJ: !!(E.CJ_API_KEY || E.CJ_ACCESS_TOKEN) };
  try {
    await cjToken(true); out.jeton = 'ok';
    const d = await cjGet('/product/listV2?page=1&size=3&keyWord=hoodie');
    out.liste = { code: d.code, result: d.result, message: d.message, produits: (d.data?.content || []).flatMap(c => c.productList || []).length };
  } catch (e) { out.erreur = String(e.message).slice(0, 200); }
  res.json(out);
});

// CJ n'a pas de recherche par photo : le site masque le bouton appareil photo
app.post('/api/visual-search', (req, res) => res.status(501).json({ error: 'Recherche par photo indisponible' }));

/* ---------- TRADUCTION (DeepL ou Google) ---------- */
const trCache = new Map();
async function translate(texts, target) {
  const tgt = String(target).toLowerCase();
  if (E.DEEPL_API_KEY) {
    const host = E.DEEPL_API_KEY.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const lang = { en: 'EN-US', pt: 'PT-PT', zh: 'ZH' }[tgt] || tgt.toUpperCase(), out = [];
    for (let i = 0; i < texts.length; i += 40) {
      const r = await fetch(`https://${host}/v2/translate`, {
        method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${E.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts.slice(i, i + 40), target_lang: lang, source_lang: 'FR', tag_handling: 'html' })
      });
      const d = await r.json();
      if (!d.translations) throw new Error('DeepL');
      out.push(...d.translations.map(x => x.text));
    }
    return out;
  }
  if (E.GOOGLE_TRANSLATE_API_KEY) {
    const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + E.GOOGLE_TRANSLATE_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: texts, target: tgt, source: 'fr', format: 'html' })
    });
    const d = await r.json();
    if (!d.data) throw new Error('Google');
    return d.data.translations.map(x => x.translatedText);
  }
  throw new Error('Aucune clé de traduction');
}
app.post('/api/translate', limit('tr', 30, 3600000), async (req, res) => {
  try {
    const texts = (req.body.texts || []).map(String).slice(0, 400), target = String(req.body.target || '').slice(0, 8);
    const key = target + crypto.createHash('md5').update(texts.join('|')).digest('hex');
    if (!trCache.has(key)) trCache.set(key, await translate(texts, target));
    res.json({ translations: trCache.get(key) });
  } catch (e) { res.status(503).json({ error: 'Traduction indisponible' }); }
});

/* ---------- EMAIL (Resend) + TELEGRAM ---------- */
async function sendMail(to, subject, text, html) {
  if (!E.RESEND_API_KEY) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${E.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: E.RESEND_FROM || 'MERCADO <onboarding@resend.dev>', to: [to], subject, text, ...(html ? { html } : {}) })
  });
  if (!r.ok) console.error('Resend:', r.status, await r.text());
  return r.ok;
}
async function telegram(text) {
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text: String(text).slice(0, 4000) })
    });
  } catch (e) { console.error('Telegram:', e.message); }
}

/* ---------- COMMANDES ---------- */
async function refreshPrice(id) {
  const loc = localCatalog().find(x => x.id === String(id));
  if (loc) return loc.usd;
  try {
    const d = await cjDetail(id);
    if (d && d.base > 0) { const p = withProfit(d.base); priceCache.set(String(id), p); return p; }
  } catch (e) { console.error('refreshPrice:', e.message); }
  return null;
}
async function serverTotal(items) { // total USD marge incluse : le prix vient du serveur, jamais du navigateur
  let t = 0;
  for (const i of items || []) {
    const id = String(i.id);
    let p = priceCache.get(id);
    if (p == null) p = await refreshPrice(id);
    if (p == null) return null;
    t += p * Math.max(1, Math.min(99, Number(i.qty) || 1));
  }
  return t > 0 ? t : null;
}
const FIELDS = ['name', 'email', 'phone', 'phone2', 'address', 'quarter', 'landmark', 'city', 'region', 'zip', 'country', 'notes'];
const cleanCustomer = c => Object.fromEntries(FIELDS.map(k => [k, String((c || {})[k] ?? '').trim().slice(0, 250)]));
const cleanId = v => String(v || '').replace(/[^\w-]/g, '').slice(0, 40) || `MC-${Date.now()}`;

function orderText(o, head) {
  const c = o.customer;
  return `${head} ${o.orderId}\n👤 ${c.name} | ${c.phone}${c.phone2 ? ' / ' + c.phone2 : ''} | ${c.email}\n` +
    `📍 ${c.address}${c.quarter ? ', ' + c.quarter : ''}${c.landmark ? ' (près de ' + c.landmark + ')' : ''}\n${c.city}, ${c.region} ${c.zip} ${c.country}\n` +
    (c.notes ? `📝 ${c.notes}\n` : '') +
    o.items.map(i => `• ${i.name} x${i.qty}\n  CJ pid: ${i.id}\n  ${i.itemUrl}`).join('\n') +
    `\n💰 Total $${o.total.toFixed(2)} (dont marge $${o.profitUsd.toFixed(2)})`;
}
app.post('/api/order', limit('od', 30, 3600000), async (req, res) => {
  try {
    const b = req.body || {}, pay = rd('payments.json', {})[cleanId(b.orderId)];
    await refreshRates();
    const items = (b.items || []).slice(0, 50).map(i => ({ id: String(i.id), name: String(i.name || '').slice(0, 200), qty: Math.max(1, Math.min(99, Number(i.qty) || 1)), itemUrl: cjUrl(i.id) }));
    const order = {
      orderId: cleanId(b.orderId), customer: cleanCustomer(b.customer), items,
      total: (await serverTotal(items)) ?? 0, profitUsd: PROFIT_USD * items.reduce((n, i) => n + i.qty, 0),
      status: pay?.paid ? 'paid' : 'pending', createdAt: new Date().toISOString()
    };
    const orders = rd('orders.json', []);
    if (!orders.some(o => o.orderId === order.orderId)) {
      orders.push(order); wr('orders.json', orders);
      telegram(orderText(order, order.status === 'paid' ? '✅ Commande PAYÉE' : '🛒 Nouvelle commande (en attente de paiement)'));
    }
    res.json({ ok: true, orderId: order.orderId });
  } catch (e) { console.error('order:', e); res.status(500).json({ error: 'Commande impossible' }); }
});

/* ---------- CAMPAY (Mobile Money MTN / Orange + carte) ---------- */
const CP_HOST = String(E.CAMPAY_ENV || 'DEMO').toUpperCase() === 'PROD' ? 'https://campay.net' : 'https://demo.campay.net';
let cpTok = { t: '', exp: 0 };
async function cpToken() {
  if (E.CAMPAY_TOKEN) return E.CAMPAY_TOKEN; // jeton permanent (rubrique APP KEYS de CamPay)
  if (cpTok.t && Date.now() < cpTok.exp) return cpTok.t;
  if (!E.CAMPAY_USERNAME || !E.CAMPAY_PASSWORD) throw new Error('CAMPAY_TOKEN (ou CAMPAY_USERNAME + CAMPAY_PASSWORD) manquant');
  const r = await fetch(CP_HOST + '/api/token/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E.CAMPAY_USERNAME, password: E.CAMPAY_PASSWORD })
  });
  const d = await r.json();
  if (!d.token) throw new Error('CamPay a refusé les identifiants');
  cpTok = { t: d.token, exp: Date.now() + (Number(d.expires_in) || 3000) * 1000 - 60000 };
  return cpTok.t;
}
const toPay = usd => Math.round(usd * (RATES.XAF || 603)); // CamPay : XAF, nombre entier obligatoire
const cmPhone = p => { const d = String(p || '').replace(/\D/g, ''); return /^237\d{9}$/.test(d) ? d : /^[62]\d{8}$/.test(d) ? '237' + d : ''; };

app.post('/api/payment/campay', limit('cp', 20, 3600000), async (req, res) => {
  try {
    const o = req.body || {}, c = cleanCustomer(o.customer), orderId = cleanId(o.orderId);
    if (!okEmail(c.email)) return res.status(400).json({ error: 'Email obligatoire' });
    if (!c.name || !c.phone || !c.address || !c.city) return res.status(400).json({ error: 'Nom, téléphone, adresse et ville obligatoires' });
    await refreshRates();
    const usd = await serverTotal(o.items);
    if (!usd) return res.status(400).json({ error: 'Panier invalide : rechargez la page' });
    const amount = toPay(usd), base = baseUrl(req), [first, ...rest] = c.name.split(/\s+/);
    const from = cmPhone(c.phone);
    const r = await fetch(CP_HOST + '/api/get_payment_link/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Token ${await cpToken()}` },
      body: JSON.stringify({
        amount: String(amount), currency: 'XAF', description: `Commande MERCADO ${orderId}`, external_reference: orderId,
        first_name: first, last_name: rest.join(' ') || first, email: c.email, ...(from ? { from } : {}),
        redirect_url: `${base}/?paid=${encodeURIComponent(orderId)}#confirm`, failure_redirect_url: `${base}/#payment`,
        payment_options: 'MOMO,CARD'
      })
    });
    const d = await r.json();
    if (!r.ok || !d.link) { console.error('CamPay:', r.status, d); return res.status(502).json({ error: d.message || d.detail || 'CamPay a refusé la demande' }); }
    const pays = rd('payments.json', {});
    pays[orderId] = { reference: d.reference || '', amount, usd, at: Date.now(), paid: false };
    wr('payments.json', pays);
    res.json({ ok: true, payment_url: d.link, orderId, amount, currency: 'XAF' });
  } catch (e) { console.error('campay:', e.message); res.status(500).json({ error: 'Paiement indisponible : ' + e.message }); }
});

// On ne croit jamais le webhook ni le navigateur : on interroge CamPay avec la référence enregistrée par le serveur
async function settle(orderId) {
  const pays = rd('payments.json', {}), p = pays[orderId];
  if (!p) return false;
  if (p.paid) return true;
  if (!p.reference) return false;
  const t = await (await fetch(`${CP_HOST}/api/transaction/${encodeURIComponent(p.reference)}/`, { headers: { Authorization: `Token ${await cpToken()}` } })).json();
  if (t.status !== 'SUCCESSFUL' || Number(t.amount) < p.amount * 0.99 || (t.external_reference && t.external_reference !== orderId)) return false;
  p.paid = true; p.paidAt = new Date().toISOString(); wr('payments.json', pays);
  const orders = rd('orders.json', []), o = orders.find(x => x.orderId === orderId);
  if (o && o.status !== 'paid') {
    o.status = 'paid'; o.paidAt = p.paidAt; wr('orders.json', orders);
    telegram(orderText(o, '✅ PAYÉ ' + p.amount + ' XAF —'));
    if (okEmail(o.customer.email)) sendMail(o.customer.email, `Commande ${orderId} confirmée`, `Merci pour votre commande MERCADO ${orderId}. Paiement reçu, nous préparons votre livraison.`);
  }
  return true;
}
const webhook = async (req, res) => {
  try { const id = cleanId((req.query && req.query.external_reference) || (req.body && req.body.external_reference)); await settle(id); } catch (e) { console.error('webhook:', e.message); }
  res.sendStatus(200);
};
app.get('/api/payment/campay/webhook', webhook);
app.post('/api/payment/campay/webhook', webhook);

app.get('/api/order/status', limit('os', 90, 3600000), async (req, res) => { // alimente l'inbox du site
  try {
    const id = cleanId(req.query.orderId);
    let o = rd('orders.json', []).find(x => x.orderId === id);
    if (o && o.status === 'pending') { await settle(id).catch(() => {}); o = rd('orders.json', []).find(x => x.orderId === id); }
    res.json({ ok: true, status: o ? o.status : 'unknown' });
  } catch (e) { res.json({ ok: true, status: 'unknown' }); }
});

/* ---------- AVIS (format exact attendu par le site) ---------- */
app.get('/api/reviews', (req, res) => {
  const pid = String(req.query.productId || '');
  res.json({ ok: true, reviews: rd('reviews.json', []).filter(r => r.productId === pid).slice(-50).reverse().map(({ productId, ...r }) => r) });
});
app.post('/api/reviews', limit('rv', 10, 3600000), (req, res) => {
  const b = req.body || {}, pid = String(b.productId || '').slice(0, 100), text = String(b.text || '').trim().slice(0, 1000);
  if (!pid || !text) return res.status(400).json({ error: 'Avis incomplet' });
  const name = String(b.name || 'Client').slice(0, 40), all = rd('reviews.json', []);
  all.push({ productId: pid, name, initial: name[0]?.toUpperCase() || 'C', stars: Math.max(1, Math.min(5, Number(b.stars) || 5)),
    date: new Date().toLocaleDateString('fr-FR'), text, variant: String(b.variant || '').slice(0, 60) });
  wr('reviews.json', all.slice(-3000));
  res.json({ ok: true });
});

/* ---------- PRODUIT CONSULTE -> RAPPEL EMAIL ---------- */
app.post('/api/track-view', limit('tv', 120, 3600000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), p = req.body.product || {};
  if (!okEmail(email) || !p.id) return res.json({ ok: true });
  const v = rd('views.json', []);
  if (!v.some(x => x.email === email && x.product.id === p.id))
    v.push({ email, at: Date.now(), reminded: false, product: { id: p.id, name: String(p.name || '').slice(0, 150), price: p.price, img: p.img } });
  wr('views.json', v.slice(-5000));
  res.json({ ok: true });
});
async function runReminders() {
  const delay = Number(E.REMINDER_DELAY_HOURS || 24) * 3600000, base = E.PUBLIC_BASE_URL || '';
  const v = rd('views.json', []), orders = rd('orders.json', []);
  let sent = 0;
  for (const x of v) {
    if (x.reminded || Date.now() - x.at < delay) continue;
    x.reminded = true;
    if (orders.some(o => (o.customer?.email || '').toLowerCase() === x.email && new Date(o.createdAt) > x.at)) continue;
    const p = x.product;
    const html = `<div style="font-family:Arial;max-width:420px"><h2>Vous avez consulté ce produit</h2>${p.img ? `<img src="${esc(p.img)}" width="300" alt="">` : ''}<p>${esc(p.name)}</p><a href="${esc(base)}" style="background:#FF6B00;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Revoir le produit</a></div>`;
    if (await sendMail(x.email, 'Vous avez récemment consulté ce produit', `${p.name} : ${base}`, html)) sent++;
  }
  wr('views.json', v);
  return sent;
}
setInterval(() => runReminders().catch(e => console.error('reminders:', e.message)), 30 * 60000);
app.post('/api/admin/run-reminders', admin, async (req, res) => res.json({ ok: true, sent: await runReminders() }));

/* ---------- ALERTES "PRODUIT DISPONIBLE" ---------- */
app.post('/api/notify/subscribe', limit('ns', 10, 3600000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), q = String(req.body.query || '').slice(0, 100).trim();
  if (!okEmail(email) || !q) return res.status(400).json({ error: 'Email ou recherche invalide' });
  const s = rd('subs.json', []);
  if (!s.some(x => x.email === email && x.query === q)) { s.push({ email, query: q, at: Date.now() }); wr('subs.json', s.slice(-5000)); }
  telegram(`🔔 Alerte demandée : "${q}" (${email})`);
  res.json({ ok: true });
});
app.post('/api/admin/notify-broadcast', admin, async (req, res) => {
  const subs = rd('subs.json', []), keep = [], seen = new Map();
  let sent = 0;
  for (const s of subs) {
    if (!seen.has(s.query)) { try { seen.set(s.query, (await cjItems(s.query, '', 5))[0] || null); } catch (e) { seen.set(s.query, null); } }
    const hit = seen.get(s.query);
    if (hit && await sendMail(s.email, `"${s.query}" est disponible sur MERCADO`, `Bonne nouvelle : ${hit.name} est disponible. ${E.PUBLIC_BASE_URL || ''}`)) sent++;
    else keep.push(s);
  }
  wr('subs.json', keep);
  res.json({ ok: true, sent });
});
app.get('/api/admin/orders', admin, (req, res) => res.json({ ok: true, orders: rd('orders.json', []).slice(-200).reverse() }));

/* ---------- IA ---------- */
app.post('/api/ai', limit('ai', 40, 3600000), async (req, res) => {
  if (!E.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'IA non configurée' });
  try {
    const b = req.body || {};
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 600,
        system: "Tu es MERCADO AI, l'assistant d'une boutique en ligne. Paiement : Mobile Money (MTN, Orange) ou carte via CamPay. Réponds brièvement, dans la langue du client. Produit ouvert : " + JSON.stringify(b.product || null).slice(0, 800),
        messages: (b.history || []).slice(-10).filter(m => m && m.content).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) }))
      })
    });
    const answer = (await r.json()).content?.[0]?.text;
    answer ? res.json({ answer }) : res.status(502).json({ error: 'Pas de réponse' });
  } catch (e) { res.status(502).json({ error: 'IA indisponible' }); }
});
app.post('/api/ai-log', limit('al', 60, 3600000), (req, res) => {
  const q = String(req.body.question || '').slice(0, 300);
  if (q) telegram(`💬 Question MERCADO AI : ${q}${req.body.product?.name ? `\n(produit : ${req.body.product.name})` : ''}`);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(),
  config: { cj: !!(E.CJ_API_KEY || E.CJ_ACCESS_TOKEN), campay: !!(E.CAMPAY_TOKEN || E.CAMPAY_USERNAME), campayEnv: CP_HOST.includes('demo') ? 'DEMO' : 'PROD', telegram: !!E.TELEGRAM_BOT_TOKEN, resend: !!E.RESEND_API_KEY } }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Erreur interne' }); });

if (E.MERCADO_TEST) module.exports = { interleave, rankCool, HOME_MIX, cjItems, homeItems, num, mapCJ, cjDetail, rank, present, keywords, settle, cleanCustomer, cmPhone, toPay, serverTotal, imgSize };
else app.listen(PORT, '0.0.0.0', () => {
  console.log(`MERCADO port ${PORT} | marge ${PROFIT_USD} USD | CamPay ${CP_HOST.includes('demo') ? 'DEMO' : 'PROD'}`);
  setTimeout(() => homeItems('All').catch(e => console.error('préchargement:', e.message)), 4000); // accueil prêt avant la 1re visite
  setInterval(() => { homeCache.delete('All'); homeItems('All').catch(() => {}); }, 9 * 60000);
});
