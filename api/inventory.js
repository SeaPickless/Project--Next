// api/inventory.js — Vercel Serverless Proxy for Roblox Inventory API
// Bypasses CORS by making the request server-side

const ASSET_TYPE_IDS = {
  GamePass: 13,
  Gear: 19,
  Animation: 24,
  Bundle: 32,
  ClassicShirt: 11,
  Model: 10,
};

export default async function handler(req, res) {
  const { userId, assetType } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' });
  }

  const authHeader = req.headers['authorization'] || '';

  try {
    // Try Open Cloud first (needs OAuth token)
    if (authHeader) {
      const ocUrl = `https://apis.roblox.com/cloud/v2/users/${userId}/inventory-items?filter=assetTypes%3D${assetType || 'GamePass'}&maxPageSize=25`;
      const ocRes = await fetch(ocUrl, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });

      if (ocRes.ok) {
        const data = await ocRes.json();
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(data);
      }
    }

    // Fallback: legacy inventory API (public, no auth needed)
    const assetTypeId = ASSET_TYPE_IDS[assetType] || 10;
    const legacyUrl = `https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=${assetTypeId}&limit=25&sortOrder=Asc`;
    const legacyRes = await fetch(legacyUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!legacyRes.ok) {
      const text = await legacyRes.text();
      return res.status(legacyRes.status).json({ error: text });
    }

    const data = await legacyRes.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
