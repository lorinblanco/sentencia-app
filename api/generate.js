// api/generate.js
// =============================================================================
// PROXY GENÉRICO A ANTHROPIC — v3.0 con streaming
// =============================================================================
// Cambios v2.2.1 → v3.0:
//   - Soporta streaming SSE. Si el body trae `stream: true`, se pipea
//     directamente la respuesta de Anthropic al cliente sin esperar a que
//     termine. Esto resuelve el timeout de Vercel (60s) para secciones largas
//     (segunda, sentencia) sin necesidad de subir el maxDuration.
//   - Mantiene el modo no-streaming para extract (necesita JSON completo).
// =============================================================================

export const config = { maxDuration: 120 }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-4-5'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: { message: 'Method not allowed' } })
  }

  const apiKey = req.headers['x-api-key'] || req.headers['X-Api-Key']
  if (!apiKey) {
    return res.status(400).json({ error: { message: 'Missing X-Api-Key header' } })
  }

  // Vercel parsea req.body automáticamente para JSON
  const { system, messages, max_tokens, model, stream } = req.body || {}
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages[] is required' } })
  }

  const anthropicPayload = {
    model: model || DEFAULT_MODEL,
    system: system || undefined,
    messages,
    max_tokens: max_tokens || 4000,
    stream: stream === true,
  }

  // ===========================================================================
  // MODO NO-STREAMING — devuelve JSON completo (para extract)
  // ===========================================================================
  if (!stream) {
    try {
      const upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicPayload),
      })
      const text = await upstream.text()
      res.status(upstream.status)
      res.setHeader('Content-Type', 'application/json')
      return res.send(text)
    } catch (e) {
      return res.status(500).json({ error: { message: e.message || 'Upstream fetch failed' } })
    }
  }

  // ===========================================================================
  // MODO STREAMING — pipea SSE directo al cliente
  // ===========================================================================
  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(anthropicPayload),
    })

    // Si la API rechaza el request, devolvemos el error en JSON (no SSE)
    if (!upstream.ok) {
      const errText = await upstream.text()
      let errJson
      try { errJson = JSON.parse(errText) } catch { errJson = { error: { message: errText } } }
      return res.status(upstream.status).json(errJson)
    }

    // Headers SSE
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // evita buffering en proxies tipo nginx
    res.flushHeaders?.()

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()

    // Pipea chunks directamente. Anthropic ya emite eventos SSE bien formateados,
    // así que no necesitamos re-parsear: solo reenviamos bytes.
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(decoder.decode(value, { stream: true }))
    }

    res.end()
  } catch (e) {
    // Si todavía no mandamos headers, devolvemos JSON. Si ya empezamos a
    // streamear, escribimos un evento error SSE y cerramos.
    if (!res.headersSent) {
      return res.status(500).json({ error: { message: e.message || 'Stream failed' } })
    }
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`)
    } catch {}
    res.end()
  }
}
