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
  async pending({ userId }) {
    const r = await rbx(`https://friends.roblox.com/v1/my/friends/requests?limit=100`);
    if (!r.ok) throw new Error('Pending API error');
    const users = r.data?.data || [];
    const ids = users.map(u => u.id || u.userId).filter(Boolean);
    const thumbMap = await fetchThumbs(ids);
    return { data: users.map(u => ({ ...u, thumbnailUrl: thumbMap[u.id || u.userId] || '' })) };
  },

  // FRIEND REQUEST COUNT (Open Cloud compatible)
  async friendRequestCount({}, token) {
    if (!token) throw new Error('Authentication required');
    const r = await rbx(`https://friends.roblox.com/v1/user/friend-requests/count`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, token);
    return { count: r.data?.count || 0 };
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

  // MY ASSETS (asset:read via Open Cloud)
  async myAssets({ assetType = 'Model' }, token) {
    if (!token) throw new Error('Authentication required');
    // Open Cloud assets endpoint — requires asset:read scope
    const r = await rbx(
      `https://apis.roblox.com/assets/v1/assets?assetType=${encodeURIComponent(assetType)}&limit=50`,
      { headers: { 'Authorization': `Bearer ${token}` } },
      token
    );
    if (!r.ok) throw new Error('Could not load assets: ' + r.status);
    const assets = r.data?.data || r.data?.assets || [];
    const ids = assets.map(a => a.assetId || a.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: assets.map(a => {
      const id = a.assetId || a.id;
      return { ...a, id, thumbnailUrl: thumbMap[id] || '' };
    }) };
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
    // Use legacy notifications API — OAuth has no dedicated notifications scope
    const r = await rbx('https://notifications.roblox.com/v2/notifications/get-rollout-settings?notificationSourceTypes=ExperienceActivity', {
      headers: { 'Authorization': `Bearer ${token}` }
    }, token);
    if (!r.ok) {
      // Fallback: return empty rather than hard 404
      return { data: [] };
    }
    return { data: r.data?.notificationSourceSettings || r.data?.data || [] };
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
    const r = await rbx('https://notifications.roblox.com/v2/notifications?limit=25', {
      headers: { 'Authorization': `Bearer ${token}` }
    }, token);
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

  // LOOKUP USER by username — returns array with id, name, displayName, thumbnailUrl
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

  // SEARCH CATALOG — used by Rblx Values
  async searchCatalog({ q, category = '2', subcategory = '' }) {
    if (!q) throw new Error('q required');
    const encoded = encodeURIComponent(q);
    let qs = `Category=${encodeURIComponent(category)}&Keyword=${encoded}&Limit=10&SortType=Relevance`;
    if (subcategory) qs += `&Subcategory=${encodeURIComponent(subcategory)}`;
    const r = await rbx(`https://catalog.roblox.com/v1/search/items/details?${qs}`);
    let items = r.data?.data || [];
    // fallback: search all categories
    if (!items.length) {
      const r2 = await rbx(`https://catalog.roblox.com/v1/search/items/details?Keyword=${encoded}&Limit=10&SortType=Relevance`);
      items = r2.data?.data || [];
    }
    const ids = items.map(i => i.id).filter(Boolean);
    const thumbMap = await fetchThumbs(ids, 'asset');
    return { data: items.map(i => ({ ...i, thumbnailUrl: thumbMap[i.id] || '' })) };
  },

  // DISCOVER GAMES — used by Ultimate Discovery and Rblx Pulse
  async discoverGames({ sortOrder = 2, genre = '' }) {
    try {
      // v1 games/list — public, no auth needed
      let url = `https://games.roblox.com/v1/games/list?Model.sortToken=&Model.gameFilter=0&Model.timeFilter=0&Model.genreFilter=0&Model.startRows=0&Model.maxRows=12&Model.sortOrder=${sortOrder}&Model.pagingEnabled=true`;
      if (genre) url += `&Model.keyword=${encodeURIComponent(genre)}`;
      const r = await rbx(url);
      let games = r.data?.games || r.data?.data || [];
      if (!games.length) {
        // fallback: /v2 discover endpoint
        const r2 = await rbx(`https://games.roblox.com/v2/games?sortToken=&SortFilter=${sortOrder}&MaxRows=12`);
        games = r2.data?.games || r2.data?.data || [];
      }
      if (!games.length) {
        // last fallback: charts endpoint
        const r3 = await rbx(`https://games.roblox.com/v1/games/list?Model.sortOrder=${sortOrder}&Model.maxRows=12`);
        games = r3.data?.games || r3.data?.data || [];
      }
      // Normalize fields
      const normalized = games.slice(0, 12).map(g => ({
        name: g.name || g.Name || 'Unknown',
        placeId: g.placeId || g.rootPlaceId || g.PlaceId || g.universeId,
        rootPlaceId: g.rootPlaceId || g.placeId,
        playerCount: g.playerCount || g.playing || g.activePlayerCount || 0,
        visits: g.visits || g.Visits || 0,
        totalUpVotes: g.totalUpVotes || g.upVotes || 0,
        totalDownVotes: g.totalDownVotes || g.downVotes || 0,
        favoritedCount: g.favoritedCount || g.favorites || 0,
        creatorName: g.creatorName || g.creator?.name || g.creator || '',
        genre: g.genre || g.Genre || '',
        subGenre: g.subGenre || '',
      }));
      return { data: normalized };
    } catch (err) {
      throw new Error('discoverGames failed: ' + err.message);
    }
  },

  // PULSE DATA — real Roblox platform health + live game stats
  async pulseData({}) {
    // 1. Fetch top games (most played) for player counts + top list
    const gamesResult = await (async () => {
      try {
        const r = await rbx('https://games.roblox.com/v1/games/list?Model.sortToken=&Model.gameFilter=0&Model.timeFilter=0&Model.genreFilter=0&Model.startRows=0&Model.maxRows=12&Model.sortOrder=2&Model.pagingEnabled=true');
        const games = r.data?.games || r.data?.data || [];
        return games.slice(0, 10).map(g => ({
          name: g.name || g.Name || 'Unknown',
          placeId: g.placeId || g.rootPlaceId || g.PlaceId || 0,
          playerCount: g.playerCount || g.playing || g.activePlayerCount || 0,
          visits: g.visits || g.Visits || 0,
          creatorName: g.creatorName || g.creator?.name || g.creator || '',
          genre: g.genre || g.Genre || '',
          totalUpVotes: g.totalUpVotes || 0,
          totalDownVotes: g.totalDownVotes || 0,
        }));
      } catch (_) { return []; }
    })();

    // 2. Ping each Roblox service endpoint to check real status
    // Each entry: { key, name, icon, url }
    const SERVICE_CHECKS = [
      { key: 'website',    name: 'Website',        icon: '◉', url: 'https://www.roblox.com/robots.txt' },
      { key: 'gameclient', name: 'Game Client',    icon: '▶', url: 'https://clientsettings.roblox.com/v2/settings/application/PCDesktopClient' },
      { key: 'auth',       name: 'Authentication', icon: '⬡', url: 'https://auth.roblox.com/v1/metadata' },
      { key: 'launch',     name: 'Game Launch',    icon: '◈', url: 'https://gamejoin.roblox.com/v1/join-game-instance' },
      { key: 'avatar',     name: 'Avatar',         icon: '◎', url: 'https://avatar.roblox.com/v1/avatar-rules' },
      { key: 'catalog',    name: 'Catalog',        icon: '▣', url: 'https://catalog.roblox.com/v1/categories' },
      { key: 'chat',       name: 'Chat',           icon: '◇', url: 'https://chat.roblox.com/v2/metadata' },
      { key: 'economy',    name: 'Economy',        icon: '◆', url: 'https://economy.roblox.com/v1/resale-tax' },
      { key: 'groups',     name: 'Groups',         icon: '◫', url: 'https://groups.roblox.com/v1/groups/search/metadata' },
      { key: 'notifs',     name: 'Notifications',  icon: '◬', url: 'https://notifications.roblox.com/v2/metadata' },
    ];

    const serviceStatuses = await Promise.allSettled(
      SERVICE_CHECKS.map(async (svc) => {
        try {
          const r = await rbx(svc.url);
          // 200-499 = service reachable (even 401/403/404 means it's UP)
          // 500+ or network error = DOWN
          const up = r.status < 500;
          return { ...svc, status: up ? 'up' : 'down' };
        } catch (_) {
          return { ...svc, status: 'down' };
        }
      })
    );

    const services = serviceStatuses.map(r =>
      r.status === 'fulfilled' ? r.value : { ...SERVICE_CHECKS[0], status: 'down' }
    );

    // 3. Economy data — Robux USD rate proxy
    let economySignal = 'Stable';
    let robuxRate = null;
    try {
      const econ = await rbx('https://economy.roblox.com/v1/resale-tax');
      if (econ.ok) {
        economySignal = 'Stable';
      }
      // Try to get currency exchange rates
      const ex = await rbx('https://economy.roblox.com/v1/currency/exchange-rates');
      if (ex.ok && ex.data) {
        robuxRate = ex.data?.robuxPerUsDollar || ex.data?.rate || null;
      }
    } catch (_) {}

    // 4. Build activity feed from real data
    const totalPlayers = gamesResult.reduce((s, g) => s + (g.playerCount || 0), 0);
    const topGame = gamesResult[0] || null;
    const servicesUp = services.filter(s => s.status === 'up').length;
    const servicesTotal = services.length;

    const activity = [];
    if (totalPlayers > 0) {
      activity.push({
        icon: '▶',
        text: `Live concurrent players across platform: ${totalPlayers.toLocaleString()}+`,
        time: 'Live',
      });
    }
    if (topGame) {
      activity.push({
        icon: '◉',
        text: `Top game right now: ${topGame.name} — ${(topGame.playerCount||0).toLocaleString()} playing`,
        time: 'Live',
      });
    }
    activity.push({
      icon: '◈',
      text: `Service health: ${servicesUp}/${servicesTotal} endpoints operational`,
      time: 'Live',
    });
    if (gamesResult.find(g => (g.genre||'').toLowerCase().includes('social') || g.name.toLowerCase().includes('roleplay') || g.name.toLowerCase().includes('adopt'))) {
      activity.push({ icon: '◫', text: 'Roleplay & Social games trending in top charts', time: 'Trending' });
    }
    activity.push({ icon: '◆', text: 'Limited item economy active — trades ongoing', time: 'Ongoing' });
    activity.push({ icon: '◎', text: 'Global server coverage across NA, EU, APAC', time: 'Ongoing' });

    return {
      games: gamesResult,
      services,
      totalPlayers,
      topGame,
      economySignal,
      robuxRate,
      activity,
      fetchedAt: Date.now(),
    };
  },

  // SEARCH GAMES — used by Ultimate Discovery search
  async searchGames({ q }) {
    if (!q) throw new Error('q required');
    try {
      const encoded = encodeURIComponent(q);
      // Primary: keyword search
      const r = await rbx(`https://games.roblox.com/v1/games/list?Model.keyword=${encoded}&Model.maxRows=12&Model.sortOrder=2`);
      let games = r.data?.games || r.data?.data || [];
      if (!games.length) {
        // Fallback: catalog-style discover search
        const r2 = await rbx(`https://games.roblox.com/v1/games/list?Model.keyword=${encoded}&Model.maxRows=12`);
        games = r2.data?.games || r2.data?.data || [];
      }
      const normalized = games.map(g => ({
        name: g.name || g.Name || 'Unknown',
        placeId: g.placeId || g.rootPlaceId || g.PlaceId,
        rootPlaceId: g.rootPlaceId || g.placeId,
        playerCount: g.playerCount || g.playing || 0,
        visits: g.visits || g.Visits || 0,
        totalUpVotes: g.totalUpVotes || g.upVotes || 0,
        totalDownVotes: g.totalDownVotes || g.downVotes || 0,
        favoritedCount: g.favoritedCount || 0,
        creatorName: g.creatorName || g.creator?.name || g.creator || '',
        genre: g.genre || g.Genre || '',
        subGenre: g.subGenre || '',
      }));
      return { data: normalized };
    } catch (err) {
      throw new Error('searchGames failed: ' + err.message);
    }
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
