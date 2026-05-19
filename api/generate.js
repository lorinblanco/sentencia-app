// api/generate.js
// =============================================================================
// SENTENCIA - Proxy genérico para la API de Anthropic
// Versión 2.2.1 - Mayo 2026
//
// Runtime: Node.js serverless. maxDuration declarado INLINE (no depende de
// vercel.json) — Vercel a veces ignora el vercel.json en deploys parciales.
// =============================================================================

export const config = {
  maxDuration: 60,
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Log para confirmar runtime al revisar Vercel logs
  console.log('[generate] runtime=node, maxDuration=60s')

  try {
    const body = req.body
    const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      return res.status(401).json({
        error: 'Missing API key (header x-api-key or env ANTHROPIC_API_KEY)',
      })
    }

    if (!body || !body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({
        error: 'Missing required field: messages (array)',
      })
    }

    const startedAt = Date.now()
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-5-20250929',
        max_tokens: body.max_tokens || 4000,
        system: body.system,
        messages: body.messages,
      }),
    })

    const elapsed = Date.now() - startedAt
    console.log(`[generate] Claude responded in ${elapsed}ms with status ${r.status}`)

    const data = await r.json()
    return res.status(r.status).json(data)
  } catch (e) {
    console.error('[generate] Error:', e)
    return res.status(500).json({ error: e.message || 'Internal error' })
  }
}
