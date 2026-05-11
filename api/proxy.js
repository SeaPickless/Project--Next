// ProjectNextProxy — Centralized Roblox API Gateway v2
// Uses each user's own OAuth Bearer token — no shared cookie needed.
// FIX: playerCount now correctly maps to .playing field from games API
// FIX: discoverGames uses proper v2 endpoints with thumbnail enrichment
// FIX: browser-mimic headers to avoid 403 Forbidden

const https = require('https');

const ROBLOX_CLIENT_ID     = process.env.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || '';

const XCSRF_CACHE    = {};
const IN_MEMORY_CACHE = {};
const CACHE_TTL       = 30000; // 30s

function cache(key, val) {
  if (val !== undefined) { IN_MEMORY_CACHE[key] = { val, ts: Date.now() }; return val; }
  const e = IN_MEMORY_CACHE[key];
  return (e && Date.now() - e.ts < CACHE_TTL) ? e.val : null;
}

// ── CORE REQUEST ──────────────────────────────────────
function robloxFetch(url, opts = {}, bearerToken = '') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const xcsrf  = XCSRF_CACHE[bearerToken] || '';
    const headers = {
      // Mimic a real browser to avoid 403s
      'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept'          : 'application/json, text/plain, */*',
      'Accept-Language' : 'en-US,en;q=0.9',
      'Accept-Encoding' : 'gzip, deflate, br',
      'Referer'         : 'https://www.roblox.com/',
      'Origin'          : 'https://www.roblox.com',
      ...(bearerToken ? { 'Authorization': `Bearer ${bearerToken}` } : {}),
      ...(opts.body    ? { 'Content-Type': 'application/json' }     : {}),
      ...(xcsrf        ? { 'x-csrf-token': xcsrf }                  : {}),
      ...(opts.headers || {}),
    };

    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const reqOpts = {
      hostname : parsed.hostname,
      path     : parsed.pathname + parsed.search,
      method   : opts.method || 'GET',
      headers,
    };

    const req = https.request(reqOpts, (res) => {
      const newXcsrf = res.headers['x-csrf-token'];
      if (newXcsrf && bearerToken) XCSRF_CACHE[bearerToken] = newXcsrf;

      // Handle gzip/deflate
      let raw = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'deflate' || enc === 'br') {
        const zlib = require('zlib');
        const decomp = enc === 'br' ? zlib.createBrotliDecompress()
                     : enc === 'deflate' ? zlib.createInflate()
                     : zlib.createGunzip();
        res.pipe(decomp);
        raw = decomp;
      }

      let data = '';
      raw.on('data', d => data += d);
      raw.on('end', () => {
        if (res.statusCode === 403 && newXcsrf && !opts._retried) {
          return resolve(robloxFetch(url, { ...opts, _retried: true }, bearerToken));
        }
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
      raw.on('error', reject);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function rbx(url, opts = {}, bearerToken = '') {
  try {
    const r = await robloxFetch(url, opts, bearerToken);
    try { return { ok: r.status >= 200 && r.status < 300, status: r.status, data: JSON.parse(r.body) }; }
    catch (_) { return { ok: false, status: r.status, data: {} }; }
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err.message };
  }
}

// ── THUMBNAIL HELPER ─────────────────────────────────
async function fetchThumbs(ids, type = 'avatar-headshot') {
  if (!ids || !ids.length) return {};
  const validIds = ids.filter(Boolean).slice(0, 100);
  if (!validIds.length) return {};
  const idStr = validIds.join(',');
  const url = type === 'asset'
    ? `https://thumbnails.roblox.com/v1/assets?assetIds=${idStr}&size=420x420&format=Png`
    : type === 'game'
    ? `https://thumbnails.roblox.com/v1/games/icons?universeIds=${idStr}&returnPolicy=PlaceHolder&size=512x512&format=Png`
    : `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${idStr}&size=100x100&format=Png&isCircular=true`;
  const r = await rbx(url);
  const map = {};
  (r.data?.data || []).forEach(t => {
    if (t.state === 'Completed') map[t.targetId] = t.imageUrl;
  });
  return map;
}

// ── GAME THUMB (place → universe → thumbnail) ─────────
async function fetchGameThumbnailsByPlaceIds(placeIds) {
  if (!placeIds || !placeIds.length) return {};
  // Step 1: resolve placeId → universeId
  const univ = await rbx(`https://apis.roblox.com/universes/v1/places?placeIds=${placeIds.slice(0,20).join(',')}`);
  const placeToUniverse = {};
  (univ.data?.data || []).forEach(p => { if (p.placeId && p.universeId) placeToUniverse[p.placeId] = p.universeId; });
  const universeIds = Object.values(placeToUniverse).filter(Boolean);
  if (!universeIds.length) return {};
  // Step 2: fetch thumbnails by universeId
  const thumbsRaw = await rbx(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png`);
  const universeThumbMap = {};
  (thumbsRaw.data?.data || []).forEach(t => { if (t.state === 'Completed') universeThumbMap[t.targetId] = t.imageUrl; });
  // Step 3: map back placeId → thumbnailUrl
  const placeThumbMap = {};
  for (const [placeId, universeId] of Object.entries(placeToUniverse)) {
    if (universeThumbMap[universeId]) placeThumbMap[placeId] = universeThumbMap[universeId];
  }
  return placeThumbMap;
}

// ── RESOLVE USERNAME ──────────────────────────────────
async function resolveUsername(username) {
  const r = await rbx('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', body: { usernames: [username], excludeBannedUsers: true }
  });
  return (r.data?.data || [])[0] || null;
}

// Normalize a raw game object from any Roblox games API endpoint
// Handles both v1/games/list shape and v2/games shape
function normalizeGame(g) {
  // v2/games wraps data differently — placeId lives at rootPlaceId
  const placeId = g.rootPlaceId || g.placeId || g.PlaceId || g.gameId || 0;
  const universeId = g.id || g.universeId || 0;
  return {
    name           : g.name || g.Name || 'Unknown',
    placeId,
    rootPlaceId    : placeId,
    universeId,
    // .playing is the correct live-player field (v2); v1 uses .playerCount
    playerCount    : g.playing || g.playerCount || g.activePlayerCount || 0,
    visits         : g.visits || g.Visits || 0,
    totalUpVotes   : g.totalUpVotes || g.upVotes || 0,
    totalDownVotes : g.totalDownVotes || g.downVotes || 0,
    favoritedCount : g.favoritedCount || g.favorites || 0,
    creatorName    : g.creatorName || g.creator?.name || (typeof g.creator === 'string' ? g.creator : '') || '',
    genre          : g.genre || g.Genre || g.subGenre || '',
    thumbnailUrl   : g.thumbnailUrl || '',
  };
}

// ── UNIVERSE IDs → thumbnails ─────────────────────────────
async function fetchUniverseThumbnails(universeIds) {
  if (!universeIds || !universeIds.length) return {};
  const ids = [...new Set(universeIds.filter(Boolean))].slice(0, 50).join(',');
  const r = await rbx(
    `https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids}&returnPolicy=PlaceHolder&size=512x512&format=Png`
  );
  const map = {};
  (r.data?.data || []).forEach(t => { if (t.state === 'Completed') map[t.targetId] = t.imageUrl; });
  return map;
}

// ── PLACE IDs → universeIds (batch) ──────────────────────
async function placeIdsToUniverseIds(placeIds) {
  if (!placeIds || !placeIds.length) return {};
  const ids = [...new Set(placeIds.filter(Boolean))].slice(0, 50).join(',');
  // Try both known endpoints
  let data = [];
  const r1 = await rbx(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${ids}`);
  if (r1.ok && Array.isArray(r1.data)) data = r1.data;
  if (!data.length) {
    const r2 = await rbx(`https://apis.roblox.com/universes/v1/places?placeIds=${ids}`);
    data = r2.data?.data || [];
  }
  const map = {};
  data.forEach(p => {
    const pid = p.placeId || p.PlaceId;
    const uid = p.universeId || p.UniverseId;
    if (pid && uid) map[pid] = uid;
  });
  return map;
}

// ── ENRICH games with thumbnails ──────────────────────────
async function enrichWithThumbnails(games) {
  // games already have universeId from v2 endpoint; collect both
  const universeIds = games.map(g => g.universeId).filter(Boolean);
  const placeIds    = games.map(g => g.placeId).filter(Boolean);

  let thumbMap = {};

  // Try universeId-based lookup first (most reliable)
  if (universeIds.length) {
    thumbMap = await fetchUniverseThumbnails(universeIds).catch(() => ({}));
  }

  // For games that still have no thumb, try resolving placeId → universeId
  const missing = games.filter(g => !thumbMap[g.universeId] && g.placeId);
  if (missing.length) {
    const placeMap = await placeIdsToUniverseIds(missing.map(g => g.placeId)).catch(() => ({}));
    const extraUniverseIds = Object.values(placeMap).filter(Boolean);
    if (extraUniverseIds.length) {
      const extraThumbs = await fetchUniverseThumbnails(extraUniverseIds).catch(() => ({}));
      Object.assign(thumbMap, extraThumbs);
      // Back-fill placeId → thumbnail via the placeMap
      missing.forEach(g => {
        const uid = placeMap[g.placeId];
        if (uid && extraThumbs[uid]) thumbMap[g.universeId || g.placeId] = extraThumbs[uid];
      });
    }
  }

  return games.map(g => ({
    ...g,
    thumbnailUrl: thumbMap[g.universeId] || thumbMap[g.placeId] || g.thumbnailUrl || '',
  }));
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
    let presenceMap = {};
    if (ids.length) {
      const pr = await rbx('https://presence.roblox.com/v1/presence/users', { method: 'POST', body: { userIds: ids } });
      (pr.data?.userPresences || []).forEach(p => { presenceMap[p.userId] = p; });
    }
    const thumbMap = await fetchThumbs(ids);
    const enriched = friends.map(f => {
      const uid = f.id || f.userId;
      const pres = presenceMap[uid] || {};
      return { ...f, userPresenceType: pres.userPresenceType || 0, lastLocation: pres.lastLocation || '', gameName: pres.lastLocation || '', thumbnailUrl: thumbMap[uid] || '' };
    });
    return cache('friends_' + userId, { data: enriched });
  },

  // FOLLOWERS
  async followers({ userId }) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://friends.roblox.com/v1/users/${userId}/followers?limit=100&sortOrder=Desc`);
    if (!r.ok) throw new Error('Followers API error');
    const users = r.data?.data || [];
    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = await fetchThumbs(ids);
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  // FOLLOWING
  async following({ userId }) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://friends.roblox.com/v1/users/${userId}/followings?limit=100&sortOrder=Desc`);
    if (!r.ok) throw new Error('Following API error');
    const users = r.data?.data || [];
    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = await fetchThumbs(ids);
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  // COUNT
  async count({ userId }) {
    const [fol, fow, fri] = await Promise.allSettled([
      rbx(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
      rbx(`https://friends.roblox.com/v1/users/${userId}/followings/count`),
      rbx(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
    ]);
    return {
      followers : fol.status === 'fulfilled' ? (fol.value.data?.count || 0) : 0,
      following : fow.status === 'fulfilled' ? (fow.value.data?.count || 0) : 0,
      friends   : fri.status === 'fulfilled' ? (fri.value.data?.count || 0) : 0,
    };
  },

  async pending({ userId }) {
    const r = await rbx(`https://friends.roblox.com/v1/my/friends/requests?limit=100`);
    if (!r.ok) throw new Error('Pending API error');
    const users = r.data?.data || [];
    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = await fetchThumbs(ids);
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  async friendRequestCount({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://friends.roblox.com/v1/user/friend-requests/count`, {}, token);
    return { count: r.data?.count || 0 };
  },

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

  // PROFILE ADVANCED
  async profileAdvanced({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx('https://users.roblox.com/v1/users/authenticated/country-region', {}, token);
    const p = await rbx('https://premiumfeatures.roblox.com/v1/users/validate-membership', {}, token);
    const v = await rbx('https://apis.roblox.com/user-verification/v1/verified-roles', {}, token);
    return {
      isPremium  : p.data?.isPremium || p.ok,
      isVerified : (v.data?.roles || []).length > 0,
      countryCode: r.data?.countryRegionCode || null,
    };
  },

  async profileSocial({}, token) {
    if (!token) throw new Error('Authentication required');
    const uid = await rbx('https://apis.roblox.com/oauth/v1/userinfo', {}, token);
    const userId = uid.data?.sub;
    if (!userId) throw new Error('Could not resolve user ID');
    const r = await rbx(`https://users.roblox.com/v1/users/${userId}/social-links/list`, {}, token);
    return { socialLinks: r.data?.data || [] };
  },

  async badges({ universeId }, token) {
    if (!universeId) throw new Error('universeId required');
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://badges.roblox.com/v1/universes/${universeId}/badges?limit=100&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Could not load badges: ' + r.status);
    const badges = r.data?.data || [];
    const ids = badges.map(b => b.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: badges.map(b => ({ ...b, thumbnailUrl: thumbMap[b.id] || (b.displayIconImageId ? `https://www.roblox.com/asset-thumbnail/image?assetId=${b.displayIconImageId}&width=64&height=64&format=png` : '') })) };
  },

  async myAssets({ assetType = 'Model' }, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://apis.roblox.com/assets/v1/assets?assetType=${encodeURIComponent(assetType)}&limit=50`, {}, token);
    if (!r.ok) throw new Error('Could not load assets: ' + r.status);
    const assets = r.data?.data || r.data?.assets || [];
    const ids = assets.map(a => a.assetId || a.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: assets.map(a => { const id = a.assetId || a.id; return { ...a, id, thumbnailUrl: thumbMap[id] || '' }; }) };
  },

  async gamepasses({ universeId }, token) {
    if (!universeId) throw new Error('universeId required');
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://games.roblox.com/v1/games/${universeId}/game-passes?limit=100&sortOrder=Desc`, {}, token);
    if (!r.ok) throw new Error('Could not load game passes: ' + r.status);
    return { data: r.data?.data || [] };
  },

  async devProducts({ universeId }, token) {
    if (!universeId) throw new Error('universeId required');
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://apis.roblox.com/developer-products/v1/universes/${universeId}/developerproducts?pageSize=50`, {}, token);
    if (!r.ok) throw new Error('Could not load developer products: ' + r.status);
    return { data: r.data?.developerProducts || r.data?.data || [] };
  },

  async sendNotif({ universeId, targetUserId, message, launchData }, token) {
    if (!token) throw new Error('Authentication required');
    if (!universeId || !message) throw new Error('universeId and message required');
    const body = {
      universeId  : Number(universeId),
      targetUserId: Number(targetUserId),
      payload     : { messageId: `pn_${Date.now()}`, type: 'ExperienceInvitation', message, ...(launchData ? { launchData } : {}) }
    };
    const r = await rbx('https://apis.roblox.com/user-notification/v1/notifications', { method: 'POST', body }, token);
    if (!r.ok) throw new Error(r.data?.errors?.[0]?.message || 'Send failed: ' + r.status);
    return { success: true };
  },

  async notifPrefs({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx('https://notifications.roblox.com/v2/notifications/get-rollout-settings?notificationSourceTypes=ExperienceActivity', {}, token);
    if (!r.ok) return { data: [] };
    return { data: r.data?.notificationSourceSettings || r.data?.data || [] };
  },

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

  async notifList({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx('https://notifications.roblox.com/v2/notifications?limit=25', {}, token);
    if (!r.ok) throw new Error('Could not load notifications');
    return { data: r.data?.notifications || r.data?.data || [] };
  },

  async presence({ userIds }) {
    const ids = String(userIds).split(',').map(Number).filter(Boolean);
    if (!ids.length) throw new Error('userIds required');
    const r = await rbx('https://presence.roblox.com/v1/presence/users', { method: 'POST', body: { userIds: ids } });
    return { data: r.data?.userPresences || [] };
  },

  async thumbnail({ type, id, ids }) {
    const allIds = ids ? String(ids).split(',').map(Number).filter(Boolean) : id ? [Number(id)] : [];
    if (!allIds.length) throw new Error('id(s) required');
    const map = await fetchThumbs(allIds, type === 'asset' ? 'asset' : 'avatar-headshot');
    return { data: map };
  },

  async inventory({ userId }) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=8,41,42,43,44,45,46,47,48&limit=25&sortOrder=Desc`);
    if (!r.ok) throw new Error('Inventory API error ' + r.status);
    const items = r.data?.data || [];
    const assetIds = items.map(i => i.assetId).filter(Boolean);
    const thumbMap = await fetchThumbs(assetIds, 'asset');
    return { data: items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.assetId] || '' })) };
  },

  async value({ userId }) {
    if (!userId) throw new Error('userId required');
    const r = await rbx(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Desc`);
    if (!r.ok) throw new Error('Value API error');
    const items = r.data?.data || [];
    let totalRap = 0;
    items.forEach(i => { totalRap += i.recentAveragePrice || 0; });
    const assetIds = items.map(i => i.assetId).filter(Boolean);
    const thumbMap = await fetchThumbs(assetIds, 'asset');
    return {
      data    : items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.assetId] || '' })),
      totalRap,
    };
  },

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

  async connections({ userId, targetUsername, depth = 3 }) {
    const maxDepth = Math.min(Number(depth) || 3, 5);
    if (!targetUsername) throw new Error('targetUsername required');
    const targetUser = await resolveUsername(targetUsername);
    if (!targetUser) throw new Error('User not found');
    const targetId = targetUser.id;
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
            return { found: true, hops: hop, pathIds: fullPath, thumbMap, targetName: targetUser.name };
          }
          if (!visited.has(fid)) { visited.add(fid); nextQueue.push([...path, fid]); }
        }
      }
      queue.length = 0; queue.push(...nextQueue.slice(0, 50));
      if (!queue.length) break;
    }
    return { found: false };
  },

  async getDevices() {
    return { data: [], note: 'Roblox does not expose device sessions via API. Manage sessions at roblox.com/my/account#security' };
  },

  async revokeDevice({ deviceId }) {
    return { redirectUrl: 'https://www.roblox.com/my/account#!/security', note: 'Redirect to Roblox security' };
  },

  async userInfo({ userId }) {
    const r = await rbx(`https://users.roblox.com/v1/users/${userId}`);
    if (!r.ok) throw new Error('User not found');
    const thumbMap = await fetchThumbs([userId]);
    return { ...r.data, thumbnailUrl: thumbMap[userId] || '' };
  },

  async lookupUser({ username }) {
    if (!username) throw new Error('username required');
    const r = await rbx('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', body: { usernames: [username], excludeBannedUsers: false }
    });
    const users = r.data?.data || [];
    if (!users.length) throw new Error('User not found: ' + username);
    const ids = users.map(u => u.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids);
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id] || '' })) };
  },

  async searchCatalog({ q, category = '2', subcategory = '' }) {
    if (!q) throw new Error('q required');
    const encoded = encodeURIComponent(q);
    let qs = `Category=${encodeURIComponent(category)}&Keyword=${encoded}&Limit=10&SortType=Relevance`;
    if (subcategory) qs += `&Subcategory=${encodeURIComponent(subcategory)}`;
    const r = await rbx(`https://catalog.roblox.com/v1/search/items/details?${qs}`);
    let items = r.data?.data || [];
    if (!items.length) {
      const r2 = await rbx(`https://catalog.roblox.com/v1/search/items/details?Keyword=${encoded}&Limit=10&SortType=Relevance`);
      items = r2.data?.data || [];
    }
    const ids = items.map(i => i.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.id] || '' })) };
  },

  // ── DISCOVER GAMES ────────────────────────────────────
  // FIX #1+2: Use working game list endpoints + correctly map .playing field
  async discoverGames({ sortOrder = 2, genre = '' }) {
    try {
      // Try multiple endpoints until we get results
      let games = [];

      // Primary: v1 games/list (most reliable, no auth needed)
      const r1 = await rbx(`https://games.roblox.com/v1/games/list?Model.sortToken=&Model.gameFilter=0&Model.timeFilter=0&Model.genreFilter=0&Model.startRows=0&Model.maxRows=12&Model.sortOrder=${sortOrder}&Model.pagingEnabled=true${genre ? '&Model.keyword=' + encodeURIComponent(genre) : ''}`);
      games = r1.data?.games || r1.data?.data || [];

      // Fallback 1: v1 without extra params
      if (!games.length) {
        const r2 = await rbx(`https://games.roblox.com/v1/games/list?Model.sortOrder=${sortOrder}&Model.maxRows=12`);
        games = r2.data?.games || r2.data?.data || [];
      }

      // Fallback 2: charts endpoint
      if (!games.length) {
        const r3 = await rbx(`https://games.roblox.com/v2/games?sortToken=&SortFilter=${sortOrder}&MaxRows=12`);
        games = r3.data?.games || r3.data?.data || [];
      }

      const normalized = games.slice(0, 12).map(normalizeGame);

      // Enrich with thumbnails using placeId -> universeId -> thumb
      const placeIds = normalized.map(g => g.placeId).filter(Boolean);
      const thumbMap = await fetchGameThumbnailsByPlaceIds(placeIds).catch(() => ({}));
      normalized.forEach(g => { if (thumbMap[g.placeId]) g.thumbnailUrl = thumbMap[g.placeId]; });

      return { data: normalized };
    } catch (err) {
      throw new Error('discoverGames failed: ' + err.message);
    }
  },

  // ── SEARCH GAMES ──────────────────────────────────────
  async searchGames({ q }) {
    if (!q) throw new Error('q required');
    try {
      const encoded = encodeURIComponent(q);
      const r = await rbx(`https://games.roblox.com/v1/games/list?Model.keyword=${encoded}&Model.maxRows=12&Model.sortOrder=2`);
      let games = r.data?.games || r.data?.data || [];
      if (!games.length) {
        const r2 = await rbx(`https://games.roblox.com/v1/games/list?Model.keyword=${encoded}&Model.maxRows=12`);
        games = r2.data?.games || r2.data?.data || [];
      }
      const normalized = games.map(normalizeGame);
      const placeIds = normalized.map(g => g.placeId).filter(Boolean);
      const thumbMap = await fetchGameThumbnailsByPlaceIds(placeIds).catch(() => ({}));
      normalized.forEach(g => { if (thumbMap[g.placeId]) g.thumbnailUrl = thumbMap[g.placeId]; });
      return { data: normalized };
    } catch (err) {
      throw new Error('searchGames failed: ' + err.message);
    }
  },

  // ── PULSE DATA ────────────────────────────────────────
  // FIX #2: playerCount now reads .playing from the API
  async pulseData({}) {
    const gamesResult = await (async () => {
      try {
        const r = await rbx('https://games.roblox.com/v1/games/list?Model.sortToken=&Model.gameFilter=0&Model.timeFilter=0&Model.genreFilter=0&Model.startRows=0&Model.maxRows=12&Model.sortOrder=2&Model.pagingEnabled=true');
        const games = r.data?.games || r.data?.data || [];
        const normalized = games.slice(0, 10).map(normalizeGame);
        const placeIds = normalized.map(g => g.placeId).filter(Boolean);
        const thumbMap = await fetchGameThumbnailsByPlaceIds(placeIds).catch(() => ({}));
        normalized.forEach(g => { if (thumbMap[g.placeId]) g.thumbnailUrl = thumbMap[g.placeId]; });
        return normalized;
      } catch (_) { return []; }
    })();

    const SERVICE_CHECKS = [
      { key: 'website',    name: 'Website',        icon: '🌐', url: 'https://www.roblox.com/robots.txt' },
      { key: 'gameclient', name: 'Game Client',    icon: '🎮', url: 'https://clientsettings.roblox.com/v2/settings/application/PCDesktopClient' },
      { key: 'auth',       name: 'Authentication', icon: '🔐', url: 'https://auth.roblox.com/v1/metadata' },
      { key: 'launch',     name: 'Game Launch',    icon: '🚀', url: 'https://gamejoin.roblox.com/v1/join-game-instance' },
      { key: 'avatar',     name: 'Avatar',         icon: '👤', url: 'https://avatar.roblox.com/v1/avatar-rules' },
      { key: 'catalog',    name: 'Catalog',        icon: '🛍️', url: 'https://catalog.roblox.com/v1/categories' },
      { key: 'chat',       name: 'Chat',           icon: '💬', url: 'https://chat.roblox.com/v2/metadata' },
      { key: 'economy',    name: 'Economy',        icon: '💰', url: 'https://economy.roblox.com/v1/resale-tax' },
      { key: 'groups',     name: 'Groups',         icon: '👥', url: 'https://groups.roblox.com/v1/groups/search/metadata' },
      { key: 'notifs',     name: 'Notifications',  icon: '🔔', url: 'https://notifications.roblox.com/v2/metadata' },
    ];

    const serviceStatuses = await Promise.allSettled(
      SERVICE_CHECKS.map(async (svc) => {
        try {
          const r = await rbx(svc.url);
          return { ...svc, status: r.status < 500 ? 'up' : 'down' };
        } catch (_) { return { ...svc, status: 'down' }; }
      })
    );
    const services = serviceStatuses.map((r, i) => r.status === 'fulfilled' ? r.value : { ...SERVICE_CHECKS[i], status: 'down' });

    let economySignal = 'Stable', robuxRate = null;
    try {
      const econ = await rbx('https://economy.roblox.com/v1/resale-tax');
      if (econ.ok) economySignal = 'Stable';
      const ex = await rbx('https://economy.roblox.com/v1/currency/exchange-rates');
      if (ex.ok && ex.data) robuxRate = ex.data?.robuxPerUsDollar || ex.data?.rate || null;
    } catch (_) {}

    const totalPlayers = gamesResult.reduce((s, g) => s + (g.playerCount || 0), 0);
    const topGame = gamesResult[0] || null;
    const servicesUp = services.filter(s => s.status === 'up').length;

    const activity = [];
    if (totalPlayers > 0) activity.push({ icon: '▶', text: `Live concurrent players across platform: ${totalPlayers.toLocaleString()}+`, time: 'Live' });
    if (topGame) activity.push({ icon: '🏆', text: `Top game: ${topGame.name} — ${(topGame.playerCount || 0).toLocaleString()} playing`, time: 'Live' });
    activity.push({ icon: '🛡️', text: `Service health: ${servicesUp}/${services.length} endpoints operational`, time: 'Live' });
    activity.push({ icon: '💎', text: 'Limited item economy active — trades ongoing', time: 'Ongoing' });
    activity.push({ icon: '🌍', text: 'Global server coverage across NA, EU, APAC', time: 'Ongoing' });

    return { games: gamesResult, services, totalPlayers, topGame, economySignal, robuxRate, activity, fetchedAt: Date.now() };
  },
};

// ── MAIN HANDLER ──────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  let params = { ...req.query };
  if (req.method === 'POST' && req.body) {
    Object.assign(params, typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }

  const action = params.action;
  if (!action) { res.status(400).json({ error: 'Missing action parameter' }); return; }

  const authHeader  = req.headers['authorization'] || req.headers['Authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (params.token || '');

  const handler = ACTIONS[action];
  if (!handler) { res.status(404).json({ error: 'Unknown action: ' + action }); return; }

  try {
    const result = await handler(params, bearerToken);
    res.status(200).json(result);
  } catch (err) {
    console.error('[proxy] action=' + action, err.message);
    res.status(500).json({ error: err.message });
  }
};
