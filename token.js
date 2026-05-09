// api/token.js — Vercel Serverless Function
// Proxies the Roblox OAuth token exchange to bypass CORS on static frontends.
// Deploy this to Vercel alongside your index.html.

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: corsHeaders(),
    });
  }

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const body = await req.text(); // URLEncoded body from frontend

    const robloxRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body, // forward as-is
    });

    const data = await robloxRes.json();

    if (!robloxRes.ok) {
      return new Response(JSON.stringify({ error: data.error || 'Token exchange failed', details: data }), {
        status: robloxRes.status,
        headers: corsHeaders(),
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: corsHeaders(),
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://project-next-pink.vercel.app',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
