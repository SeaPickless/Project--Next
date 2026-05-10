// api/inventory.js — Vercel Serverless Proxy for Roblox Inventory API
// Returns REAL inventory items with thumbnails and RAP values.
// CORS-free: all requests are server-side.

export default async function handler(req, res) {
  // ── CORS preflight ────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-roblox-cookie');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { userId, action, query, assetTypeId, cursor } = req.query;
  const authHeader = req.headers['authorization'] || '';
  const rbxCookie  = req.headers['x-roblox-cookie'] || '';

  const rblxFetch = async (url, opts = {}) => {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(rbxCookie  ? { Cookie: `.ROBLOSECURITY=${rbxCookie}` } : {}),
      ...(opts.headers || {}),
    };
    return fetch(url, { ...opts, headers });
  };

  // ── asset type map ────────────────────────────────────────────────────────
  // assetTypeId values used by inventory.roblox.com/v2
  const ASSET_TYPE_GROUPS = {
    limiteds:     [8, 17, 18, 41, 42, 43, 44, 45, 46, 47, 48], // accessories + limited UGC
    accessories:  [8, 41, 42, 43, 44, 45, 46, 47, 48],
    gamepasses:   [13],
    badges:       [21],
    animations:   [24],
    bundles:      [32],
    clothing:     [11, 12],
    models:       [10],
    decals:       [13],
  };

  try {

    // ── GET /api/inventory?action=audit&userId=xxx ────────────────────────
    // Full inventory audit: limiteds + gamepasses + accessories
    if (action === 'audit' || !action) {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      // Fetch all asset type groups in parallel
      const groups = ['limiteds', 'gamepasses', 'accessories', 'animations', 'bundles', 'clothing'];
      const results = await Promise.allSettled(
        groups.map(async (group) => {
          const typeIds = ASSET_TYPE_GROUPS[group];
          const items   = [];
          for (const typeId of typeIds.slice(0, 3)) { // limit types per group
            try {
              const url = `https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=${typeId}&limit=100&sortOrder=Desc`;
              const r   = await rblxFetch(url);
              if (!r.ok) continue;
              const d = await r.json();
              items.push(...(d.data || []));
            } catch (_) { /* skip */ }
          }
          return { group, items };
        })
      );

      const allItems = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const item of r.value.items) {
            item._group = r.value.group;
            allItems.push(item);
          }
        }
      }

      // Deduplicate by assetId
      const seen    = new Set();
      const unique  = allItems.filter(i => {
        const key = i.assetId || i.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Batch-fetch thumbnails (max 100 per call)
      const assetIds = unique.map(i => i.assetId || i.id).filter(Boolean);
      const thumbMap = {};
      for (let i = 0; i < assetIds.length; i += 100) {
        const batch = assetIds.slice(i, i + 100);
        try {
          const tr = await fetch(
            `https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}&size=150x150&format=Png`
          );
          if (tr.ok) {
            const td = await tr.json();
            for (const t of td.data || []) {
              if (t.state === 'Completed') thumbMap[t.targetId] = t.imageUrl;
            }
          }
        } catch (_) { /* thumbnail fetch is best-effort */ }
      }

      // Fetch RAP for limited items
      const rapMap = {};
      const limitedIds = unique
        .filter(i => i._group === 'limiteds')
        .map(i => i.assetId || i.id)
        .filter(Boolean)
        .slice(0, 50);

      for (const id of limitedIds) {
        try {
          const r = await fetch(
            `https://economy.roblox.com/v1/assets/${id}/resellers?limit=10&cursor=`
          );
          if (r.ok) {
            const d = await r.json();
            const prices = (d.data || []).map(s => s.price).filter(Boolean);
            if (prices.length) rapMap[id] = Math.min(...prices); // lowest reseller price
          }
        } catch (_) { /* skip */ }
      }

      // Enrich items with thumbnails + RAP
      for (const item of unique) {
        const id       = item.assetId || item.id;
        item.thumbnail = thumbMap[id] || null;
        item.rap       = rapMap[id]   || null;
      }

      return res.status(200).json({ data: unique, total: unique.length });
    }

    // ── GET /api/inventory?action=search&query=xxx ────────────────────────
    // Search Roblox catalog (5 results with images + creator + price)
    if (action === 'search') {
      if (!query) return res.status(400).json({ error: 'Missing query' });

      const r = await rblxFetch(
        `https://catalog.roblox.com/v1/search/items/details?Category=1&Keyword=${encodeURIComponent(query)}&limit=10&sortType=Relevance`
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data = await r.json();
      const items = (data.data || []).slice(0, 5);

      // Batch-fetch thumbnails for results
      const ids = items.map(i => i.id).filter(Boolean);
      const thumbMap = {};
      if (ids.length) {
        try {
          const tr = await fetch(
            `https://thumbnails.roblox.com/v1/assets?assetIds=${ids.join(',')}&size=150x150&format=Png`
          );
          if (tr.ok) {
            const td = await tr.json();
            for (const t of td.data || []) {
              if (t.state === 'Completed') thumbMap[t.targetId] = t.imageUrl;
            }
          }
        } catch (_) { /* skip */ }
      }

      for (const item of items) {
        item.thumbnail = thumbMap[item.id] || null;
      }

      return res.status(200).json({ data: items });
    }

    // ── GET /api/inventory?action=rap&userId=xxx ──────────────────────────
    // Get limiteds with real RAP from economy API
    if (action === 'rap') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      // Fetch collectibles
      const r = await rblxFetch(
        `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Desc`
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data    = await r.json();
      const items   = data.data || [];
      const assetIds = items.map(i => i.assetId).filter(Boolean);

      // Batch fetch thumbnails
      const thumbMap = {};
      for (let i = 0; i < assetIds.length; i += 100) {
        const batch = assetIds.slice(i, i + 100);
        try {
          const tr = await fetch(
            `https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}&size=150x150&format=Png`
          );
          if (tr.ok) {
            const td = await tr.json();
            for (const t of td.data || []) {
              if (t.state === 'Completed') thumbMap[t.targetId] = t.imageUrl;
            }
          }
        } catch (_) { /* skip */ }
      }

      // Fetch RAP for each limited
      const rapMap = {};
      for (const id of assetIds.slice(0, 50)) {
        try {
          const r2 = await fetch(
            `https://economy.roblox.com/v1/assets/${id}/resellers?limit=10`
          );
          if (r2.ok) {
            const d = await r2.json();
            // recentAveragePrice field
            if (d.recentAveragePrice) {
              rapMap[id] = d.recentAveragePrice;
            } else {
              const prices = (d.data || []).map(s => s.price).filter(Boolean);
              if (prices.length) rapMap[id] = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
            }
          }
        } catch (_) { /* skip */ }
      }

      for (const item of items) {
        item.thumbnail = thumbMap[item.assetId] || null;
        item.rap       = rapMap[item.assetId]   || item.recentAveragePrice || 0;
      }

      const totalRap = items.reduce((sum, i) => sum + (i.rap || 0), 0);
      return res.status(200).json({ data: items, totalRap });
    }

    // ── GET /api/inventory?action=value-search&query=xxx ─────────────────
    // Search for item value using catalog + economy API
    if (action === 'value-search') {
      if (!query) return res.status(400).json({ error: 'Missing query' });

      // Search catalog for the item
      const searchR = await rblxFetch(
        `https://catalog.roblox.com/v1/search/items/details?Keyword=${encodeURIComponent(query)}&Category=1&limit=10`
      );
      if (!searchR.ok) {
        const txt = await searchR.text();
        return res.status(searchR.status).json({ error: txt });
      }
      const searchData = await searchR.json();
      const items      = (searchData.data || []).slice(0, 5);

      // Enrich each result with price + thumbnail
      const enriched = await Promise.allSettled(
        items.map(async (item) => {
          try {
            const [thumbRes, ecoRes] = await Promise.allSettled([
              fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${item.id}&size=150x150&format=Png`).then(r => r.json()),
              fetch(`https://economy.roblox.com/v1/assets/${item.id}/resellers?limit=10`).then(r => r.json()),
            ]);
            const thumbData = thumbRes.status === 'fulfilled' ? thumbRes.value : null;
            const ecoData   = ecoRes.status   === 'fulfilled' ? ecoRes.value   : null;
            item.thumbnail  = thumbData?.data?.[0]?.imageUrl || null;
            item.rap        = ecoData?.recentAveragePrice     || null;
            const prices    = (ecoData?.data || []).map(s => s.price).filter(Boolean);
            item.lowestPrice = prices.length ? Math.min(...prices) : null;
          } catch (_) { /* skip */ }
          return item;
        })
      );

      const finalItems = enriched
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      return res.status(200).json({ data: finalItems });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
