// api/proxy.js — ProjectNextProxy
// Centralized Roblox API gateway for Project Next
// Handles: friends, followers, inventory, thumbnails, presence,
//          friend actions (unfriend/block/unblock), XSRF auto-retry,
//          item value search (catalog + Rolimons), mutual friends,
//          connections finder (BFS), username resolution, devices/sessions

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const ROBLOSECURITY = process.env.ROBLOSECURITY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

let csrfToken = '';

// ── CORS HEADERS ────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-roblox-cookie');
}

// ── HTTP FETCH HELPER ───────────────────────────────────────────────────────
function httpFetch(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'ProjectNext/1.0',
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
    };
    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── ROBLOX AUTH HEADERS ─────────────────────────────────────────────────────
function rbxHeaders(extra = {}) {
  return {
    'Cookie': `.ROBLOSECURITY=${ROBLOSECURITY}`,
    'Content-Type': 'application/json',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...extra,
  };
}

// ── AUTHENTICATED REQUEST WITH AUTO XSRF RETRY ──────────────────────────────
async function rbxRequest(urlStr, options = {}) {
  const result = await httpFetch(urlStr, { ...options, headers: { ...rbxHeaders(), ...(options.headers || {}) } });
  // If 403 and token validation failed, refresh XSRF and retry once
  if (result.status === 403 && result.headers['x-csrf-token']) {
    csrfToken = result.headers['x-csrf-token'];
    return await httpFetch(urlStr, { ...options, headers: { ...rbxHeaders(), ...(options.headers || {}) } });
  }
  // Update XSRF token if provided
  if (result.headers['x-csrf-token']) csrfToken = result.headers['x-csrf-token'];
  return result;
}

// ── PARSE SAFE JSON ─────────────────────────────────────────────────────────
function parseJSON(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

// ── SEND JSON RESPONSE ──────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ════════════════════════════════════════════════════════════════════════════
//  ACTION HANDLERS
// ════════════════════════════════════════════════════════════════════════════

// GET friends list with presence enrichment
async function actionFriends(params) {
  const userId = params.get('userId');
  if (!userId) return { error: 'userId required' };

  const friendsRes = await rbxRequest(`https://friends.roblox.com/v1/users/${userId}/friends`);
  const friendsData = parseJSON(friendsRes.body) || {};
  const friends = friendsData.data || [];

  if (!friends.length) return { data: [] };

  // Fetch presence for all friends
  const userIds = friends.map(f => f.id || f.userId).filter(Boolean);
  let presenceMap = {};
  try {
    const presRes = await rbxRequest('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      body: JSON.stringify({ userIds }),
    });
    const presData = parseJSON(presRes.body) || {};
    (presData.userPresences || []).forEach(p => {
      presenceMap[p.userId] = p;
    });
  } catch (_) {}

  const enriched = friends.map(f => {
    const uid = f.id || f.userId;
    const presence = presenceMap[uid] || {};
    return {
      ...f,
      userPresenceType: presence.userPresenceType || 0,
      lastLocation: presence.lastLocation || '',
      gameId: presence.gameId || null,
      placeId: presence.placeId || null,
    };
  });

  return { data: enriched };
}

// GET followers list
async function actionFollowers(params) {
  const userId = params.get('userId');
  if (!userId) return { error: 'userId required' };
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${userId}/followers?limit=100&sortOrder=Desc`);
  return parseJSON(r.body) || { data: [] };
}

// GET following list
async function actionFollowing(params) {
  const userId = params.get('userId');
  if (!userId) return { error: 'userId required' };
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${userId}/followings?limit=100&sortOrder=Desc`);
  return parseJSON(r.body) || { data: [] };
}

// GET follower count
async function actionFollowersCount(params) {
  const userId = params.get('userId');
  if (!userId) return { error: 'userId required' };
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${userId}/followers/count`);
  return parseJSON(r.body) || { count: 0 };
}

// GET following count
async function actionFollowingCount(params) {
  const userId = params.get('userId');
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${userId}/followings/count`);
  return parseJSON(r.body) || { count: 0 };
}

// GET friends count
async function actionFriendsCount(params) {
  const userId = params.get('userId');
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${userId}/friends/count`);
  return parseJSON(r.body) || { count: 0 };
}

// GET friend requests (pending)
async function actionFriendRequests(params) {
  const r = await rbxRequest(`https://friends.roblox.com/v1/my/friends/requests?limit=100`);
  return parseJSON(r.body) || { data: [] };
}

// POST unfriend
async function actionUnfriend(params) {
  const targetId = params.get('targetId');
  if (!targetId) return { error: 'targetId required' };
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${targetId}/unfriend`, { method: 'POST' });
  if (r.status === 200) return { success: true };
  return { error: parseJSON(r.body)?.errors?.[0]?.message || 'Unfriend failed' };
}

// POST block
async function actionBlock(params, userId) {
  const targetId = params.get('targetId');
  if (!targetId || !userId) return { error: 'targetId and userId required' };
  const r = await rbxRequest(`https://apis.roblox.com/user-blocking-api/v1/users/${userId}/block-user/${targetId}`, { method: 'POST' });
  if (r.status === 200) return { success: true };
  return { error: parseJSON(r.body)?.errors?.[0]?.message || 'Block failed' };
}

// POST unblock
async function actionUnblock(params, userId) {
  const targetId = params.get('targetId');
  if (!targetId || !userId) return { error: 'targetId and userId required' };
  const r = await rbxRequest(`https://apis.roblox.com/user-blocking-api/v1/users/${userId}/unblock-user/${targetId}`, { method: 'POST' });
  if (r.status === 200) return { success: true };
  return { error: parseJSON(r.body)?.errors?.[0]?.message || 'Unblock failed' };
}

// POST accept friend request
async function actionAcceptRequest(params) {
  const targetId = params.get('targetId');
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${targetId}/accept-friend-request`, { method: 'POST' });
  return r.status === 200 ? { success: true } : { error: 'Accept failed' };
}

// POST decline friend request
async function actionDeclineRequest(params) {
  const targetId = params.get('targetId');
  const r = await rbxRequest(`https://friends.roblox.com/v1/users/${targetId}/decline-friend-request`, { method: 'POST' });
  return r.status === 200 ? { success: true } : { error: 'Decline failed' };
}

// GET inventory
async function actionInventory(params) {
  const userId = params.get('userId');
  const assetTypes = params.get('assetTypes') || '8,41,42,43,44,45,46,47,48';
  const limit = params.get('limit') || '100';
  if (!userId) return { error: 'userId required' };
  const r = await rbxRequest(`https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=${assetTypes}&limit=${limit}&sortOrder=Desc`);
  return parseJSON(r.body) || { data: [] };
}

// GET inventory audit (limiteds with RAP)
async function actionAudit(params) {
  const userId = params.get('userId');
  if (!userId) return { error: 'userId required' };

  // Fetch collectibles/limiteds
  const r = await rbxRequest(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Desc`);
  const data = parseJSON(r.body) || {};
  const items = (data.data || []).map(i => ({
    ...i,
    _group: 'limiteds',
    rap: i.recentAveragePrice || 0,
    name: i.name || i.assetName,
  }));

  // Fetch gamepasses
  const gpR = await rbxRequest(`https://inventory.roblox.com/v2/users/${userId}/inventory?assetTypes=34&limit=100`);
  const gpData = parseJSON(gpR.body) || {};
  const gpItems = (gpData.data || []).map(i => ({ ...i, _group: 'gamepasses', rap: 0 }));

  return { data: [...items, ...gpItems] };
}

// GET RAP (limiteds with recent average price)
async function actionRap(params) {
  const userId = params.get('userId');
  if (!userId) return { error: 'userId required' };
  const r = await rbxRequest(`https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Desc`);
  const data = parseJSON(r.body) || {};
  const items = (data.data || []).map(i => ({ ...i, rap: i.recentAveragePrice || 0 }));
  const totalRap = items.reduce((s, i) => s + (i.rap || 0), 0);
  return { data: items, totalRap };
}

// GET thumbnails (avatar-headshot or assets)
async function actionThumbnails(params) {
  const type = params.get('type') || 'avatar-headshot';
  const size = params.get('size') || '100x100';

  if (type === 'avatar-headshot') {
    const userIds = params.get('userIds') || '';
    const r = await httpFetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds}&size=${size}&format=Png&isCircular=true`);
    return parseJSON(r.body) || { data: [] };
  }
  if (type === 'assets') {
    const assetIds = params.get('assetIds') || '';
    const r = await httpFetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${assetIds}&size=${size}&format=Png`);
    return parseJSON(r.body) || { data: [] };
  }
  if (type === 'avatar') {
    const userIds = params.get('userIds') || '';
    const r = await httpFetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userIds}&size=${size}&format=Png`);
    return parseJSON(r.body) || { data: [] };
  }
  return { error: 'Unknown thumbnail type' };
}

// GET presence for multiple users
async function actionPresence(params) {
  const userIds = (params.get('userIds') || '').split(',').map(Number).filter(Boolean);
  const r = await rbxRequest('https://presence.roblox.com/v1/presence/users', {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });
  return parseJSON(r.body) || { userPresences: [] };
}

// GET resolve username → userId
async function actionResolveUsername(params) {
  const username = params.get('username');
  if (!username) return { error: 'username required' };
  const r = await httpFetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  return parseJSON(r.body) || { data: [] };
}

// GET mutual friends between authed user and target
async function actionMutuals(params) {
  const userId = params.get('userId');      // current user
  const targetId = params.get('targetId');  // target user
  if (!userId || !targetId) return { error: 'userId and targetId required' };

  const [myFriendsR, targetFriendsR] = await Promise.all([
    rbxRequest(`https://friends.roblox.com/v1/users/${userId}/friends`),
    rbxRequest(`https://friends.roblox.com/v1/users/${targetId}/friends`),
  ]);
  const myFriends = (parseJSON(myFriendsR.body) || {}).data || [];
  const targetFriends = (parseJSON(targetFriendsR.body) || {}).data || [];
  const targetSet = new Set(targetFriends.map(f => f.id || f.userId));
  const mutuals = myFriends.filter(f => targetSet.has(f.id || f.userId));
  return { data: mutuals, count: mutuals.length };
}

// GET BFS connections finder
async function actionConnections(params) {
  const userId = params.get('userId');
  const targetUsername = params.get('targetUsername');
  const maxDepth = Math.min(parseInt(params.get('depth') || '3'), 5);
  if (!userId || !targetUsername) return { error: 'userId and targetUsername required' };

  // Cache to avoid refetching same user
  const friendsCache = {};
  async function getFriends(uid) {
    if (friendsCache[uid]) return friendsCache[uid];
    try {
      const r = await rbxRequest(`https://friends.roblox.com/v1/users/${uid}/friends`);
      const d = parseJSON(r.body) || {};
      friendsCache[uid] = d.data || [];
    } catch (_) { friendsCache[uid] = []; }
    return friendsCache[uid];
  }

  const target = targetUsername.toLowerCase();
  const visited = new Set([String(userId)]);
  // BFS queue: [{friends, path, pathData}]
  const myFriends = await getFriends(userId);
  const myUser = { name: params.get('myUsername') || 'You', id: userId };

  async function bfs(currentFriends, path, pathData, depth) {
    if (depth > maxDepth) return null;
    for (const f of currentFriends) {
      const fname = (f.name || f.displayName || '').toLowerCase();
      const fdname = (f.displayName || f.name || '').toLowerCase();
      if (fname === target || fdname === target) {
        return { found: true, hops: depth, path: [...path, f.displayName || f.name], pathData: [...pathData, { name: f.displayName || f.name, id: f.id || f.userId }] };
      }
    }
    if (depth < maxDepth) {
      for (const f of currentFriends.slice(0, 12)) {
        const fid = String(f.id || f.userId);
        if (visited.has(fid)) continue;
        visited.add(fid);
        const nextFriends = await getFriends(fid);
        const result = await bfs(nextFriends, [...path, f.displayName || f.name], [...pathData, { name: f.displayName || f.name, id: fid }], depth + 1);
        if (result) return result;
      }
    }
    return null;
  }

  const result = await bfs(myFriends, [myUser.name], [myUser], 1);
  if (result) return result;
  return { found: false, reason: `Not found within ${maxDepth} hops.` };
}

// GET item value search (catalog + Rolimons)
async function actionItemSearch(params) {
  const q = params.get('q') || '';
  if (!q) return { error: 'q required' };

  // Search Roblox catalog
  const r = await httpFetch(`https://catalog.roblox.com/v1/search/items/details?Category=2&Keyword=${encodeURIComponent(q)}&Limit=10&SortType=Relevance`);
  let items = (parseJSON(r.body) || {}).data || [];
  if (!items.length) {
    const r2 = await httpFetch(`https://catalog.roblox.com/v1/search/items/details?Keyword=${encodeURIComponent(q)}&Limit=10`);
    items = (parseJSON(r2.body) || {}).data || [];
  }

  // Try Rolimons for RAP data on limiteds
  let rolimonsData = {};
  try {
    const rr = await httpFetch('https://www.rolimons.com/itemapi/itemdetails');
    const rd = parseJSON(rr.body) || {};
    rolimonsData = rd.items || {};
  } catch (_) {}

  const enriched = items.map(i => {
    const rap = rolimonsData[i.id]?.[3] || null;
    return { ...i, rap };
  });

  return { data: enriched };
}

// GET device sessions (Roblox doesn't expose a public device API — returns current session info)
async function actionGetDevices(params) {
  // Roblox doesn't have a real device listing API on Open Cloud
  // We return what we can detect from the current session
  return {
    data: [
      { device: 'Current Session', status: 'active', current: true, note: 'Roblox does not expose a public device listing API. Manage sessions at roblox.com/my/account#!/security' }
    ]
  };
}

// POST revoke device / logout session
async function actionRevokeDevice(params) {
  // Roblox session revocation requires cookie-based logout
  // Redirect user to security page for manual revoke
  return { success: false, message: 'Roblox requires manual session revocation at roblox.com/my/account#!/security', url: 'https://www.roblox.com/my/account#!/security' };
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  setCors(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const params = parsedUrl.searchParams;
  const action = params.get('action') || '';
  const userId = params.get('userId') || '';

  // Read body for POST requests
  let bodyStr = '';
  if (req.method === 'POST') {
    await new Promise(resolve => {
      req.on('data', chunk => { bodyStr += chunk; });
      req.on('end', resolve);
    });
    // Merge body params into params
    try {
      const bodyData = JSON.parse(bodyStr);
      Object.entries(bodyData).forEach(([k, v]) => { if (!params.has(k)) params.set(k, String(v)); });
    } catch (_) {}
  }

  try {
    let result;

    switch (action) {
      // ── READ ACTIONS (GET) ─────────────────────────────
      case 'friends':           result = await actionFriends(params); break;
      case 'followers':         result = await actionFollowers(params); break;
      case 'following':         result = await actionFollowing(params); break;
      case 'followersCount':    result = await actionFollowersCount(params); break;
      case 'followingCount':    result = await actionFollowingCount(params); break;
      case 'friendsCount':      result = await actionFriendsCount(params); break;
      case 'friendRequests':    result = await actionFriendRequests(params); break;
      case 'inventory':         result = await actionInventory(params); break;
      case 'audit':             result = await actionAudit(params); break;
      case 'rap':               result = await actionRap(params); break;
      case 'thumbnails':        result = await actionThumbnails(params); break;
      case 'presence':          result = await actionPresence(params); break;
      case 'resolveUsername':   result = await actionResolveUsername(params); break;
      case 'mutuals':           result = await actionMutuals(params); break;
      case 'connections':       result = await actionConnections(params); break;
      case 'itemSearch':        result = await actionItemSearch(params); break;
      case 'getDevices':        result = await actionGetDevices(params); break;

      // ── WRITE ACTIONS (POST) ───────────────────────────
      case 'unfriend':          result = await actionUnfriend(params); break;
      case 'block':             result = await actionBlock(params, userId); break;
      case 'unblock':           result = await actionUnblock(params, userId); break;
      case 'acceptRequest':     result = await actionAcceptRequest(params); break;
      case 'declineRequest':    result = await actionDeclineRequest(params); break;
      case 'revokeDevice':      result = await actionRevokeDevice(params); break;
      case 'logoutSession':     result = await actionRevokeDevice(params); break;

      default:
        return sendJSON(res, 400, { error: `Unknown action: ${action}`, availableActions: ['friends','followers','following','followersCount','followingCount','friendsCount','friendRequests','inventory','audit','rap','thumbnails','presence','resolveUsername','mutuals','connections','itemSearch','getDevices','unfriend','block','unblock','acceptRequest','declineRequest','revokeDevice','logoutSession'] });
    }

    sendJSON(res, 200, result);
  } catch (err) {
    console.error('[proxy] error:', err);
    sendJSON(res, 500, { error: err.message || 'Internal proxy error' });
  }
};
