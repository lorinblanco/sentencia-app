export const config = { runtime: 'edge', maxDuration: 120 }

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  
  try {
    const apiKey = req.headers.get('X-Api-Key')
    if (!apiKey) return new Response(JSON.stringify({ error: 'API key requerida' }), { status: 401, headers: cors })
    
    const body = await req.json()
    const { system, messages, max_tokens = 1000 } = body
    
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens, system, messages })
    })
    
    const data = await anthropicRes.json()
    return new Response(JSON.stringify(data), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors })
  }
}
