// ProjectNextProxy — Centralized Roblox API Gateway
// Uses each user's own OAuth Bearer token — no shared cookie needed.
// Every user authenticates via Roblox OAuth and their token is forwarded here.

const https = require('https');

// ── CONFIG ────────────────────────────────────────────
const ROBLOX_CLIENT_ID     = process.env.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || '';

// Per-token XSRF cache (keyed by token so each user gets their own)
const XCSRF_CACHE = {};
const IN_MEMORY_CACHE = {};
const CACHE_TTL = 30000; // 30s

function cache(key, val) {
  if (val !== undefined) { IN_MEMORY_CACHE[key] = { val, ts: Date.now() }; return val; }
  const e = IN_MEMORY_CACHE[key];
  return (e && Date.now() - e.ts < CACHE_TTL) ? e.val : null;
}

// ── CORE REQUEST FUNCTION ────────────────────────────
// bearerToken = the user's OAuth access_token sent from frontend
function robloxFetch(url, opts = {}, bearerToken = '') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const xcsrf = XCSRF_CACHE[bearerToken] || '';
    const headers = {
      'Authorization': bearerToken ? `Bearer ${bearerToken}` : undefined,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Content-Type': opts.body ? 'application/json' : undefined,
      ...(opts.headers || {}),
    };
    if (xcsrf) headers['x-csrf-token'] = xcsrf;
    // Remove undefined headers
    Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers,
    };

    const req = https.request(reqOpts, (res) => {
      // Capture new XSRF token — store per user token
      const newXcsrf = res.headers['x-csrf-token'];
      if (newXcsrf && bearerToken) XCSRF_CACHE[bearerToken] = newXcsrf;

      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        // Auto-retry once on 403 with new XSRF token
        if (res.statusCode === 403 && newXcsrf && !opts._retried) {
          return resolve(robloxFetch(url, { ...opts, _retried: true }, bearerToken));
        }
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function rbx(url, opts = {}, bearerToken = '') {
  const r = await robloxFetch(url, opts, bearerToken);
  try { return { ok: r.status >= 200 && r.status < 300, status: r.status, data: JSON.parse(r.body) }; }
  catch (_) { return { ok: false, status: r.status, data: {} }; }
}

// ── THUMBNAIL HELPER ─────────────────────────────────
async function fetchThumbs(userIds, type = 'avatar-headshot') {
  if (!userIds.length) return {};
  const ids = userIds.slice(0, 100).join(',');
  const url = type === 'asset'
    ? `https://thumbnails.roblox.com/v1/assets?assetIds=${ids}&size=110x110&format=Png`
    : `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids}&size=100x100&format=Png&isCircular=true`;
  const r = await rbx(url);
  const map = {};
  (r.data?.data || []).forEach(t => { if (t.state === 'Completed') map[t.targetId] = t.imageUrl; });
  return map;
}

// ── RESOLVE USERNAME ──────────────────────────────────
async function resolveUsername(username) {
  const r = await rbx('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', body: { usernames: [username], excludeBannedUsers: true }
  });
  return (r.data?.data || [])[0] || null;
}

// ── ACTIONS ───────────────────────────────────────────
const ACTIONS = {

  // FRIENDS
  async friends({ userId }) {
    if (!userId) throw new Error('userId required');
    const cached = cache('friends_' + userId);
    if (cached) return cached;
    const r = await rbx(`https://friends.roblox.com/v1/users/${userId}/friends`);
    if (!r.ok) throw new Error('Friends API error ' + r.status);
    const friends = r.data?.data || [];
    const ids = friends.map(f => f.id || f.userId).filter(Boolean);
    // Fetch presence
    let presenceMap = {};
    if (ids.length) {
      const pr = await rbx('https://presence.roblox.com/v1/presence/users', { method: 'POST', body: { userIds: ids } });
      (pr.data?.userPresences || []).forEach(p => { presenceMap[p.userId] = p; });
    }
    // Fetch thumbnails
    const thumbMap = await fetchThumbs(ids);
    const enriched = friends.map(f => {
      const uid = f.id || f.userId;
      const pres = presenceMap[uid] || {};
      return { ...f, userPresenceType: pres.userPresenceType || 0, lastLocation: pres.lastLocation || '', gameName: pres.lastLocation || '', thumbnailUrl: thumbMap[uid] || '' };
    });
    return cache('friends_' + userId, { data: enriched });
  },

  // FOLLOWERS
  async followers({ userId }, token) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://friends.roblox.com/v1/users/${userId}/followers?limit=100&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Followers API error ' + r.status);
    const users = r.data?.data || [];
    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = ids.length ? await fetchThumbs(ids) : {};
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  // FOLLOWING
  async following({ userId }, token) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://friends.roblox.com/v1/users/${userId}/followings?limit=100&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Following API error ' + r.status);
    const users = r.data?.data || [];
    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = ids.length ? await fetchThumbs(ids) : {};
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  // COUNT (followers/following/friends)
  async count({ userId }) {
    const [fol, fow, fri] = await Promise.allSettled([
      rbx(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
      rbx(`https://friends.roblox.com/v1/users/${userId}/followings/count`),
      rbx(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
    ]);
    return {
      followers: fol.status === 'fulfilled' ? (fol.value.data?.count || 0) : 0,
      following: fow.status === 'fulfilled' ? (fow.value.data?.count || 0) : 0,
      friends: fri.status === 'fulfilled' ? (fri.value.data?.count || 0) : 0,
    };
  },

  // PENDING FRIEND REQUESTS
  async pending({ userId }, token) {
    // Primary: OAuth-compatible endpoint via Open Cloud (requires Bearer token)
    // Fallback: legacy endpoint that may work with Bearer on some accounts
    let users = [];
    let ok = false;

    // Try the user-facing friends requests endpoint with Bearer auth
    if (token) {
      const r = await rbx(`https://friends.roblox.com/v1/my/friends/requests?limit=100&sortOrder=Desc`, {}, token);
      if (r.ok) {
        users = r.data?.data || [];
        ok = true;
      }
    }

    // Fallback: try without auth (public accounts only)
    if (!ok) {
      const r = await rbx(`https://friends.roblox.com/v1/my/friends/requests?limit=100&sortOrder=Desc`);
      if (r.ok) {
        users = r.data?.data || [];
        ok = true;
      }
    }

    if (!ok && !users.length) {
      // Return empty rather than throwing — display will show "no pending" but won't crash
      return { data: [], note: 'Pending requests require a valid Roblox OAuth token with user.social:read scope.' };
    }

    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = ids.length ? await fetchThumbs(ids) : {};
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  // FRIEND REQUEST ACTIONS
  async acceptRequest({ targetId }, token) {
    const r = await rbx(`https://friends.roblox.com/v1/users/${targetId}/accept-friend-request`, { method: 'POST' }, token);
    if (!r.ok) throw new Error(r.data?.errors?.[0]?.message || 'Accept failed');
    return { success: true };
  },

  async declineRequest({ targetId }, token) {
    const r = await rbx(`https://friends.roblox.com/v1/users/${targetId}/decline-friend-request`, { method: 'POST' }, token);
    if (!r.ok) throw new Error(r.data?.errors?.[0]?.message || 'Decline failed');
    return { success: true };
  },

  // PROFILE ADVANCED (user.advanced:read)
  async profileAdvanced({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx('https://users.roblox.com/v1/users/authenticated/country-region', {}, token);
    const p = await rbx('https://premiumfeatures.roblox.com/v1/users/validate-membership', {}, token);
    const v = await rbx('https://apis.roblox.com/user-verification/v1/verified-roles', {}, token);
    return {
      isPremium: p.data?.isPremium || p.ok,
      isVerified: (v.data?.roles || []).length > 0,
      countryCode: r.data?.countryRegionCode || null,
    };
  },

  // SOCIAL LINKS (user.social:read)
  async profileSocial({}, token) {
    if (!token) throw new Error('Authentication required');
    const uid = await rbx('https://apis.roblox.com/oauth/v1/userinfo', {}, token);
    const userId = uid.data?.sub;
    if (!userId) throw new Error('Could not resolve user ID');
    const r = await rbx(`https://users.roblox.com/v1/users/${userId}/social-links/list`, {}, token);
    return { socialLinks: r.data?.data || [] };
  },

  // BADGES (legacy-badge:manage)
  async badges({ universeId }, token) {
    if (!universeId) throw new Error('universeId required');
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Could not load badges: ' + r.status);
    const badges = r.data?.data || [];
    const ids = badges.map(b => b.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: badges.map(b => ({ ...b, thumbnailUrl: thumbMap[b.id] || b.displayIconImageId ? `https://www.roblox.com/asset-thumbnail/image?assetId=${b.displayIconImageId}&width=64&height=64&format=png` : '' })) };
  },

  // MY ASSETS (legacy-asset:manage)
  async myAssets({ assetType = 'Model' }, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://develop.roblox.com/v1/user/assets?assetType=${encodeURIComponent(assetType)}&limit=50&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Could not load assets: ' + r.status);
    const assets = r.data?.data || [];
    const ids = assets.map(a => a.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: assets.map(a => ({ ...a, thumbnailUrl: thumbMap[a.id] || '' })) };
  },

  // GAME PASSES (game-pass:read)
  async gamepasses({ universeId }, token) {
    if (!universeId) throw new Error('universeId required');
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://games.roblox.com/v1/games/${universeId}/game-passes?limit=100&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Could not load game passes: ' + r.status);
    return { data: r.data?.data || [] };
  },

  // DEV PRODUCTS (developer-product:read)
  async devProducts({ universeId }, token) {
    if (!universeId) throw new Error('universeId required');
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://apis.roblox.com/developer-products/v1/universes/${universeId}/developerproducts?pageSize=50`, {}, token);
    if (!r.ok) throw new Error('Could not load developer products: ' + r.status);
    return { data: r.data?.developerProducts || r.data?.data || [] };
  },

  // SEND EXPERIENCE NOTIFICATION (user.user-notification:write)
  async sendNotif({ universeId, targetUserId, message, launchData }, token) {
    if (!token) throw new Error('Authentication required');
    if (!universeId || !message) throw new Error('universeId and message required');
    const body = {
      universeId: Number(universeId),
      targetUserId: Number(targetUserId),
      payload: {
        messageId: `pn_${Date.now()}`,
        type: 'ExperienceInvitation',
        message,
        ...(launchData ? { launchData } : {}),
      }
    };
    const r = await rbx('https://apis.roblox.com/user-notification/v1/notifications', { method: 'POST', body }, token);
    if (!r.ok) throw new Error(r.data?.errors?.[0]?.message || 'Send failed: ' + r.status);
    return { success: true };
  },
  async notifPrefs({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx('https://apis.roblox.com/experience-notifications/v1/opt-in-status', {}, token);
    if (!r.ok) throw new Error('Could not load notification preferences');
    return { data: r.data?.data || [] };
  },

  // TOGGLE EXPERIENCE NOTIFICATION (legacy-universe.following:write)
  async setNotif({ universeId, enable }, token) {
    if (!token) throw new Error('Authentication required');
    if (!universeId) throw new Error('universeId required');
    const endpoint = enable
      ? `https://apis.roblox.com/experience-notifications/v1/opt-in?universeId=${universeId}`
      : `https://apis.roblox.com/experience-notifications/v1/opt-out?universeId=${universeId}`;
    const r = await rbx(endpoint, { method: 'POST' }, token);
    if (!r.ok) throw new Error(r.data?.errors?.[0]?.message || 'Failed to update notification');
    return { success: true };
  },

  // LIST RECENT EXPERIENCE NOTIFICATIONS
  async notifList({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx('https://notifications.roblox.com/v2/notifications?limit=25', {}, token);
    if (!r.ok) throw new Error('Could not load notifications');
    const items = r.data?.notifications || r.data?.data || [];
    return { data: items };
  },

  // PRESENCE
  async presence({ userIds }) {
    const ids = String(userIds).split(',').map(Number).filter(Boolean);
    if (!ids.length) throw new Error('userIds required');
    const r = await rbx('https://presence.roblox.com/v1/presence/users', { method: 'POST', body: { userIds: ids } });
    return { data: r.data?.userPresences || [] };
  },

  // THUMBNAIL proxy
  async thumbnail({ type, id, ids }) {
    const allIds = ids ? String(ids).split(',').map(Number).filter(Boolean) : id ? [Number(id)] : [];
    if (!allIds.length) throw new Error('id(s) required');
    const map = await fetchThumbs(allIds, type === 'asset' ? 'asset' : 'avatar-headshot');
    return { data: map };
  },

  // INVENTORY
  async inventory({ userId }) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=8,41,42,43,44,45,46,47,48&limit=25&sortOrder=Desc`);
    if (!r.ok) throw new Error('Inventory API error ' + r.status);
    const items = r.data?.data || [];
    const assetIds = items.map(i => i.assetId).filter(Boolean);
    const thumbMap = await fetchThumbs(assetIds, 'asset');
    return { data: items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.assetId] || '' })) };
  },

  // ACCOUNT VALUE / RAP
  async value({ userId }) {
    if (!userId) throw new Error('userId required');
    // Collectibles (limiteds with RAP)
    const r = await rbx(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Desc`);
    if (!r.ok) throw new Error('Value API error');
    const items = r.data?.data || [];
    let totalRap = 0;
    items.forEach(i => { totalRap += i.recentAveragePrice || 0; });
    const assetIds = items.map(i => i.assetId).filter(Boolean);
    const thumbMap = await fetchThumbs(assetIds, 'asset');
    return {
      data: items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.assetId] || '' })),
      totalRap,
    };
  },

  // CATALOG ITEM SEARCH
  async itemSearch({ q }) {
    if (!q) throw new Error('q required');
    const encoded = encodeURIComponent(q);
    let r = await rbx(`https://catalog.roblox.com/v1/search/items/details?Category=2&Keyword=${encoded}&Limit=10&SortType=Relevance`);
    let items = r.data?.data || [];
    if (!items.length) {
      r = await rbx(`https://catalog.roblox.com/v1/search/items/details?Keyword=${encoded}&Limit=10`);
      items = r.data?.data || [];
    }
    const ids = items.map(i => i.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.id] || '' })) };
  },

  // MUTUAL FRIENDS
  async mutuals({ userId, targetUsername }) {
    if (!targetUsername) throw new Error('targetUsername required');
    const [myFriendsR, targetUser] = await Promise.all([
      ACTIONS.friends({ userId }),
      resolveUsername(targetUsername),
    ]);
    if (!targetUser) throw new Error('User not found: ' + targetUsername);
    const targetFriendsR = await rbx(`https://friends.roblox.com/v1/users/${targetUser.id}/friends`);
    const targetIds = new Set((targetFriendsR.data?.data || []).map(f => f.id || f.userId));
    const myFriends = myFriendsR.data || [];
    const mutuals = myFriends.filter(f => targetIds.has(f.id || f.userId));
    return { data: mutuals, count: mutuals.length };
  },

  // CONNECTIONS BFS
  async connections({ userId, targetUsername, depth = 3 }) {
    const maxDepth = Math.min(Number(depth) || 3, 5);
    if (!targetUsername) throw new Error('targetUsername required');
    const targetUser = await resolveUsername(targetUsername);
    if (!targetUser) throw new Error('User not found');
    const targetId = targetUser.id;
    const myUsername = ''; // resolved by frontend
    // BFS
    const queue = [[userId]];
    const visited = new Set([String(userId)]);
    for (let hop = 1; hop <= maxDepth; hop++) {
      const nextQueue = [];
      for (const path of queue) {
        const lastId = path[path.length - 1];
        const cacheKey = 'bfs_' + lastId;
        let friends = cache(cacheKey);
        if (!friends) {
          const r = await rbx(`https://friends.roblox.com/v1/users/${lastId}/friends`);
          friends = r.data?.data || [];
          cache(cacheKey, friends);
        }
        for (const f of friends) {
          const fid = String(f.id || f.userId);
          if (fid === String(targetId)) {
            const fullPath = [...path, fid];
            const pathIds = fullPath.map(Number).filter(Boolean);
            const thumbMap = await fetchThumbs(pathIds);
            return {
              found: true,
              hops: hop,
              pathIds: fullPath,
              thumbMap,
              targetName: targetUser.name,
            };
          }
          if (!visited.has(fid)) {
            visited.add(fid);
            nextQueue.push([...path, fid]);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue.slice(0, 50)); // limit BFS width
      if (!queue.length) break;
    }
    return { found: false };
  },

  // GET DEVICES (Roblox session management)
  async getDevices() {
    // Roblox doesn't expose device list via public API, return browser session only
    // Real device list not available without undocumented endpoints
    return {
      data: [],
      note: 'Roblox does not expose device sessions via API. Manage sessions at roblox.com/my/account#security',
    };
  },

  // REVOKE DEVICE
  async revokeDevice({ deviceId }) {
    // Direct Roblox session revocation - open security page
    return { redirectUrl: 'https://www.roblox.com/my/account#!/security', note: 'Redirect to Roblox security' };
  },

  // USER INFO by userId
  async userInfo({ userId }) {
    const r = await rbx(`https://users.roblox.com/v1/users/${userId}`);
    if (!r.ok) throw new Error('User not found');
    const thumbMap = await fetchThumbs([userId]);
    return { ...r.data, thumbnailUrl: thumbMap[userId] || '' };
  },
};

// ── MAIN HANDLER ─────────────────────────────────────
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Parse action from query or body
  let params = { ...req.query };
  if (req.method === 'POST' && req.body) {
    Object.assign(params, typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }

  const action = params.action;
  if (!action) {
    res.status(400).json({ error: 'Missing action parameter' });
    return;
  }

  // Extract bearer token from Authorization header
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (params.token || '');

  const handler = ACTIONS[action];
  if (!handler) {
    res.status(404).json({ error: 'Unknown action: ' + action });
    return;
  }

  try {
    const result = await handler(params, bearerToken);
    res.status(200).json(result);
  } catch (err) {
    console.error('[proxy] action=' + action, err.message);
    res.status(500).json({ error: err.message });
  }
};
