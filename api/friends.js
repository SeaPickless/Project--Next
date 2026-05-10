// api/friends.js — Vercel Serverless Proxy for Roblox Friends API
// Bypasses CORS by making the request server-side

export default async function handler(req, res) {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' });
  }

  const authHeader = req.headers['authorization'] || '';

  try {
    const response = await fetch(
      `https://friends.roblox.com/v1/users/${userId}/friends`,
      {
        headers: {
          ...(authHeader ? { Authorization: authHeader } : {}),
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
