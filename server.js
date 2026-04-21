const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;

const COL_URL   = 4;
const COL_TITLE = 5;
const COL_CATS  = 26;
const COL_TAGS  = 27;
const COL_IMGS  = 33;

const SHEET_ID  = '1lSoeoHXI_0FQga-64ekIDcVwRv56ykq8egcLNUSp8R4';
const SHEET_GID = '927689016';
const CSV_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;

let productsCache = [];
let lastFetched = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

function titleToSlug(title) {
  return title.toLowerCase()
    .replace(/\s*\|\s*/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function extractSlug(rawUrl, title) {
  const s = (rawUrl || '').trim();
  const m = s.match(/\/shop\/p\/([^/?#\s]+)/);
  if (m) return m[1];
  if (s && /^[a-z0-9]/.test(s) && !/\s/.test(s)) return s;
  return titleToSlug(title);
}

function extractArtist(title) {
  const parts = title.split('|');
  return parts.length > 1 ? parts[parts.length - 1].trim() : '';
}

function parseTags(catStr, tagStr, artist) {
  const combined = [catStr, tagStr].join(',');
  const tags = combined.split(/[,，;；|｜\/\\]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  if (artist) tags.push(artist.toLowerCase().replace(/\s+/g, ''));
  return [...new Set(tags)];
}

async function loadProducts() {
  const now = Date.now();
  if (productsCache.length > 0 && now - lastFetched < CACHE_TTL_MS) return productsCache;

  console.log('[cache] Fetching from Google Sheets…');
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}. Make sure the sheet is public.`);

  const csv = await res.text();
  const rows = parse(csv, { relax_column_count: true, skip_empty_lines: true });
  if (rows.length < 2) throw new Error('Spreadsheet appears to be empty.');

  const seen = new Set();
  const products = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < COL_TITLE + 1) continue;
    const title = (r[COL_TITLE] || '').trim();
    if (!title) continue;
    const rawUrl = (r[COL_URL] || '').trim();
    const slug = extractSlug(rawUrl, title);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const artist = extractArtist(title);
    const artTitle = title.includes('|') ? title.split('|').slice(0, -1).join('|').trim() : title.trim();
    const tags = parseTags(r[COL_CATS] || '', r[COL_TAGS] || '', artist);
    const image = (r[COL_IMGS] || '').trim().split(/\s+/)[0] || '';
    products.push({ title, artTitle, artist, slug, tags, image });
  }

  productsCache = products;
  lastFetched = now;
  console.log(`[cache] Loaded ${products.length} products.`);
  return products;
}

function recommend(products, currentSlug, limit = 4) {
  const current = products.find(p => p.slug === currentSlug);
  if (!current) return [];

  const scored = products
    .filter(p => p.slug !== currentSlug)
    .map(p => {
      let score = 0;
      for (const tag of current.tags) { if (p.tags.includes(tag)) score++; }
      if (current.artist && p.artist === current.artist) score += 2;
      return { p, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || Math.random() - 0.5);

  const result = scored.slice(0, limit).map(x => x.p);

  if (result.length < limit) {
    const slugsUsed = new Set([currentSlug, ...result.map(p => p.slug)]);
    const rest = products.filter(p => !slugsUsed.has(p.slug)).sort(() => Math.random() - 0.5).slice(0, limit - result.length);
    result.push(...rest);
  }

  return result.map(p => ({
    title: p.title, artTitle: p.artTitle, artist: p.artist,
    slug: p.slug, url: `https://www.lightoarts.com/shop/p/${p.slug}`, image: p.image,
  }));
}

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = /^https?:\/\/(www\.)?lightoarts\.com$/.test(origin) || /^http:\/\/localhost/.test(origin);
    cb(ok ? null : new Error('CORS'), ok);
  },
}));

app.get('/health', (_req, res) => res.json({ ok: true, products: productsCache.length }));

app.get('/recommendations', async (req, res) => {
  const { slug, limit = '4' } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing ?slug=' });
  try {
    const products = await loadProducts();
    res.json(recommend(products, slug.toLowerCase().trim(), Math.min(parseInt(limit, 10) || 4, 12)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/products', async (_req, res) => {
  try { res.json(await loadProducts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Lighto Arts recommendation API on port ${PORT}`));
