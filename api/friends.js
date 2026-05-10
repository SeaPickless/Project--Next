// api/friends.js — Vercel Serverless Proxy for Roblox Friends API
// Handles: friends list, presence, pending requests, followers, unfriend, block, unblock

export default async function handler(req, res) {
  // ── CORS preflight ────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-roblox-cookie');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { userId, action, targetId, cursor } = req.query;
  const authHeader = req.headers['authorization'] || '';
  // Some actions need a .ROBLOSECURITY cookie forwarded from the client
  const rbxCookie  = req.headers['x-roblox-cookie'] || '';

  const rblxFetch = async (url, opts = {}) => {
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
      ...(rbxCookie  ? { Cookie: `.ROBLOSECURITY=${rbxCookie}` } : {}),
      ...(opts.headers || {}),
    };
    const r = await fetch(url, { ...opts, headers });
    return r;
  };

  try {
    // ── GET /api/friends?userId=xxx ───────────────────────────────────────
    if (!action || action === 'friends') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      const r = await rblxFetch(
        `https://friends.roblox.com/v1/users/${userId}/friends?limit=200`
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data = await r.json();
      const friends = data.data || [];

      // ── Enrich with presence data (who is online/in-game + game name) ──
      if (friends.length) {
        const ids = friends.map(f => f.id || f.userId).filter(Boolean);
        try {
          const presRes = await rblxFetch(
            'https://presence.roblox.com/v1/presence/users',
            {
              method: 'POST',
              body: JSON.stringify({ userIds: ids }),
            }
          );
          if (presRes.ok) {
            const presData = await presRes.json();
            const presMap  = {};
            for (const p of presData.userPresences || []) {
              presMap[p.userId] = p;
            }
            for (const f of friends) {
              const uid  = f.id || f.userId;
              const pres = presMap[uid];
              if (pres) {
                // userPresenceType: 0=offline,1=online,2=ingame,3=studio
                f.userPresenceType = pres.userPresenceType ?? 0;
                f.isOnline         = pres.userPresenceType > 0;
                f.lastLocation     = pres.lastLocation || '';
                f.gameId           = pres.gameId       || null;
                f.placeId          = pres.placeId      || null;
                f.rootPlaceId      = pres.rootPlaceId  || null;
                // game name comes from lastLocation when in-game
                f.gameName         = pres.userPresenceType === 2
                  ? (pres.lastLocation || 'In Game')
                  : null;
              }
            }
          }
        } catch (_) { /* presence enrichment is best-effort */ }
      }

      return res.status(200).json({ data: friends });
    }

    // ── GET /api/friends?action=pending ──────────────────────────────────
    if (action === 'pending') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const cursorParam = cursor ? `&cursor=${cursor}` : '';
      const r = await rblxFetch(
        `https://friends.roblox.com/v1/my/friends/requests?limit=100&sortOrder=Desc${cursorParam}`
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data = await r.json();
      return res.status(200).json(data);
    }

    // ── GET /api/friends?action=followers&userId=xxx ──────────────────────
    if (action === 'followers') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const cursorParam = cursor ? `&cursor=${cursor}` : '';
      const r = await rblxFetch(
        `https://friends.roblox.com/v1/users/${userId}/followers?limit=100&sortOrder=Desc${cursorParam}`
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data = await r.json();
      return res.status(200).json(data);
    }

    // ── GET /api/friends?action=followings&userId=xxx ─────────────────────
    if (action === 'followings') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const r = await rblxFetch(
        `https://friends.roblox.com/v1/users/${userId}/followings?limit=100&sortOrder=Desc`
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data = await r.json();
      return res.status(200).json(data);
    }

    // ── GET /api/friends?action=count&userId=xxx ──────────────────────────
    if (action === 'count') {
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      const [friendsR, followersR, followingsR] = await Promise.allSettled([
        rblxFetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(r => r.json()),
        rblxFetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`).then(r => r.json()),
        rblxFetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`).then(r => r.json()),
      ]);
      return res.status(200).json({
        friends:    friendsR.status   === 'fulfilled' ? (friendsR.value.count   ?? 0) : 0,
        followers:  followersR.status === 'fulfilled' ? (followersR.value.count ?? 0) : 0,
        followings: followingsR.status === 'fulfilled' ? (followingsR.value.count ?? 0) : 0,
      });
    }

    // ── POST /api/friends?action=unfriend&targetId=xxx ────────────────────
    if (action === 'unfriend') {
      if (!targetId) return res.status(400).json({ error: 'Missing targetId' });
      const r = await rblxFetch(
        `https://friends.roblox.com/v1/users/${targetId}/unfriend`,
        { method: 'POST', body: '{}' }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ success: true });
    }

    // ── POST /api/friends?action=block&targetId=xxx ───────────────────────
    if (action === 'block') {
      if (!targetId) return res.status(400).json({ error: 'Missing targetId' });
      const r = await rblxFetch(
        `https://apis.roblox.com/user-blocking-api/v1/users/${userId}/block-user/${targetId}`,
        { method: 'POST', body: '{}' }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ success: true });
    }

    // ── POST /api/friends?action=unblock&targetId=xxx ─────────────────────
    if (action === 'unblock') {
      if (!targetId) return res.status(400).json({ error: 'Missing targetId' });
      const r = await rblxFetch(
        `https://apis.roblox.com/user-blocking-api/v1/users/${userId}/unblock-user/${targetId}`,
        { method: 'POST', body: '{}' }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ success: true });
    }

    // ── POST /api/friends?action=presence ─────────────────────────────────
    // Body: { userIds: [number, ...] }
    if (action === 'presence') {
      const body = req.body || {};
      const ids  = Array.isArray(body.userIds) ? body.userIds : [];
      if (!ids.length) return res.status(400).json({ error: 'Missing userIds' });
      const r = await rblxFetch(
        'https://presence.roblox.com/v1/presence/users',
        { method: 'POST', body: JSON.stringify({ userIds: ids }) }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
