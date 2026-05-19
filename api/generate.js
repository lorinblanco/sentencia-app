// api/generate.js
// =============================================================================
// SENTENCIA - Proxy genérico para la API de Anthropic
// Versión 2.2 - Mayo 2026
//
// Recibe del cliente: { system, messages, max_tokens, model } y opcionalmente
// la API key vía header 'x-api-key'. Reenvía la request a Anthropic y devuelve
// la respuesta tal cual.
//
// Runtime: Node.js serverless (NO edge) — permite maxDuration de hasta 60s
// en plan Hobby (configurado en vercel.json). Edge functions limitan a 25s
// la respuesta inicial, lo cual era insuficiente para las llamadas grandes
// (segunda cuestión, sentencia dispositivo).
// =============================================================================

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

    const data = await r.json()
    return res.status(r.status).json(data)
  } catch (e) {
    console.error('Error en /api/generate:', e)
    return res.status(500).json({ error: e.message || 'Internal error' })
  }
}
