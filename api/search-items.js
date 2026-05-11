// search-items.js — Roblox Item Value Search
// Uses Rolimons item data (updated periodically) + Roblox catalog API
// Data format from Rolimons items.json:
// Index 0: Name (String)
// Index 1: Acronym (String) e.g. "SSH" for Super Super Happy Face
// Index 2: RAP — Recent Average Price (Number)
// Index 3: Value — Current trading value (-1 if no special value, use RAP)
// Index 4: Default Value — assigned value, otherwise RAP (Number)
// Index 5: Demand — (-1: None, 0: Terrible, 1: Low, 2: Normal, 3: High, 4: Amazing)
// Index 6: Trend — (-1: None, 0: Lowering, 1: Unstable, 2: Stable, 3: Raising, 4: Fluctuating)
// Index 7: Projected Status — (-1: False, 1: True)

const https = require('https');

const DEMAND_LABELS = { '-1': 'None', '0': 'Terrible', '1': 'Low', '2': 'Normal', '3': 'High', '4': 'Amazing' };
const DEMAND_COLORS = { '-1': '#888', '0': '#e74c3c', '1': '#e67e22', '2': '#f1c40f', '3': '#2ecc71', '4': '#9b59b6' };
const TREND_LABELS  = { '-1': 'None', '0': 'Lowering', '1': 'Unstable', '2': 'Stable', '3': 'Raising', '4': 'Fluctuating' };
const TREND_ICONS   = { '-1': '—', '0': '📉', '1': '〰️', '2': '➡️', '3': '📈', '4': '🔀' };

// Simple in-memory cache for Rolimons data (1 hour TTL)
let _rolimonsCache = null;
let _rolimonsCacheTs = 0;
const ROLIMONS_TTL = 60 * 60 * 1000; // 1 hour

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function getRolimonsData() {
  if (_rolimonsCache && Date.now() - _rolimonsCacheTs < ROLIMONS_TTL) return _rolimonsCache;
  try {
    const r = await fetchUrl('https://www.rolimons.com/itemapi/itemdetails');
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      _rolimonsCache = d.items || {};
      _rolimonsCacheTs = Date.now();
      return _rolimonsCache;
    }
  } catch (_) {}
  return _rolimonsCache || {};
}

async function getCatalogItem(keyword, category = '2', subcategory = '') {
  try {
    const encoded = encodeURIComponent(keyword);
    let qs = `Category=${encodeURIComponent(category)}&Keyword=${encoded}&Limit=10&SortType=Relevance`;
    if (subcategory) qs += `&Subcategory=${encodeURIComponent(subcategory)}`;
    const r = await fetchUrl(`https://catalog.roblox.com/v1/search/items/details?${qs}`);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      return d.data || [];
    }
  } catch (_) {}
  return [];
}

async function getThumbnails(assetIds) {
  if (!assetIds.length) return {};
  try {
    const ids = assetIds.slice(0, 30).join(',');
    const r = await fetchUrl(`https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=110x110&format=Png`);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const map = {};
      (d.data || []).forEach(t => { if (t.state === 'Completed') map[t.targetId] = t.imageUrl; });
      return map;
    }
  } catch (_) {}
  return {};
}

function formatRobux(n) {
  if (!n || n < 0) return 'N/A';
  return 'R$ ' + Number(n).toLocaleString();
}

function buildItemResult(itemId, roliData, catalogItem, thumbUrl) {
  const [name, acronym, rap, value, defaultVal, demand, trend, projected] = roliData || [];
  const catalogName = catalogItem?.name || name || 'Unknown';
  const catalogPrice = catalogItem?.price;
  const lowestPrice = catalogItem?.lowestPrice;

  const displayValue = (value && value > 0) ? value : (defaultVal && defaultVal > 0 ? defaultVal : rap);
  const isLimited = catalogItem?.itemRestrictions?.some(r => r === 'Limited' || r === 'LimitedUnique')
    || (roliData && rap > 0);

  return {
    id: itemId,
    name: catalogName,
    acronym: acronym || null,
    rap: rap > 0 ? rap : null,
    value: value > 0 ? value : null,
    defaultValue: defaultVal > 0 ? defaultVal : null,
    displayValue: displayValue > 0 ? displayValue : null,
    catalogPrice: catalogPrice ?? lowestPrice ?? null,
    isLimited,
    isProjected: projected === 1,
    demand: demand !== undefined ? {
      value: demand,
      label: DEMAND_LABELS[String(demand)] || 'Unknown',
      color: DEMAND_COLORS[String(demand)] || '#888',
    } : null,
    trend: trend !== undefined ? {
      value: trend,
      label: TREND_LABELS[String(trend)] || 'Unknown',
      icon: TREND_ICONS[String(trend)] || '—',
    } : null,
    thumbnailUrl: thumbUrl || null,
    roliUrl: `https://www.rolimons.com/item/${itemId}`,
    robloxUrl: `https://www.roblox.com/catalog/${itemId}`,
    creator: catalogItem?.creatorName || null,
    assetType: catalogItem?.assetType || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const q = (req.query.q || '').trim();
  const id = req.query.id ? Number(req.query.id) : null;
  const category = req.query.category || '2';
  const subcategory = req.query.subcategory || '';

  if (!q && !id) {
    res.status(400).json({ error: 'Provide q (search term) or id (asset ID)' });
    return;
  }

  try {
    const rolimonsItems = await getRolimonsData();

    // ── SEARCH BY ASSET ID ────────────────────────────
    if (id) {
      const roliData = rolimonsItems[id];
      const catalogItems = await getCatalogItem(roliData ? roliData[0] : String(id), category, subcategory);
      const catalogItem = catalogItems.find(i => i.id === id) || catalogItems[0] || null;
      const thumbMap = await getThumbnails([id]);
      const result = buildItemResult(id, roliData, catalogItem, thumbMap[id]);
      res.status(200).json({ results: [result], source: 'rolimons+catalog' });
      return;
    }

    // ── SEARCH BY KEYWORD ─────────────────────────────
    const qLower = q.toLowerCase();

    // 1. Search Rolimons data by name or acronym
    const rolimonsMatches = [];
    for (const [itemId, data] of Object.entries(rolimonsItems)) {
      const [name, acronym] = data;
      if (
        (name && name.toLowerCase().includes(qLower)) ||
        (acronym && acronym.toLowerCase() === qLower)
      ) {
        rolimonsMatches.push({ id: Number(itemId), data });
        if (rolimonsMatches.length >= 10) break;
      }
    }

    // 2. Also search Roblox catalog
    const catalogItems = await getCatalogItem(q, category, subcategory);

    // 3. Merge — prefer Rolimons hits, fill in catalog data
    const seen = new Set();
    const merged = [];

    for (const { id: itemId, data: roliData } of rolimonsMatches) {
      const catalogItem = catalogItems.find(i => i.id === itemId) || null;
      seen.add(itemId);
      merged.push({ itemId, roliData, catalogItem });
    }

    // Add catalog-only results (no rolimons data, probably not limiteds)
    for (const ci of catalogItems) {
      if (!seen.has(ci.id)) {
        merged.push({ itemId: ci.id, roliData: null, catalogItem: ci });
        seen.add(ci.id);
      }
    }

    // Fetch thumbnails for all
    const allIds = merged.map(m => m.itemId).filter(Boolean);
    const thumbMap = await getThumbnails(allIds);

    const results = merged.slice(0, 12).map(({ itemId, roliData, catalogItem }) =>
      buildItemResult(itemId, roliData, catalogItem, thumbMap[itemId])
    );

    // Sort: limiteds with RAP first
    results.sort((a, b) => {
      if (a.isLimited && !b.isLimited) return -1;
      if (!a.isLimited && b.isLimited) return 1;
      return (b.rap || 0) - (a.rap || 0);
    });

    res.status(200).json({ results, total: results.length, source: 'rolimons+catalog' });

  } catch (err) {
    console.error('[search-items]', err.message);
    res.status(500).json({ error: err.message });
  }
};
