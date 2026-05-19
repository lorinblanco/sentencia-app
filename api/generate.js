// api/generate.js
// =============================================================================
// SENTENCIA - Proxy genérico para la API de Anthropic
// Versión 2.2 - Mayo 2026
//
// Recibe del cliente: { system, messages, max_tokens, model } y opcionalmente
// la API key vía header 'x-api-key'. Reenvía la request a Anthropic y devuelve
// la respuesta tal cual.
//
// El cliente (src/lib/claude.js) orquesta las 5 llamadas en secuencia:
//   1) extractBasicInfo  → JSON con datos del expediente
//   2) antecedentes      → relato cronológico del proceso
//   3) resolución        → pericia + incapacidad
//   4) ibm               → ingreso base + cierre Primera Cuestión
//   5) segunda           → cálculo + comparación BNA vs RIPTE + condena
//   6) sentencia         → dispositivo final
//
// Toda la lógica de prompts, cálculos y detección de variantes vive en
// src/lib/ (cliente). Este archivo NO importa nada de ahí — esa fue la causa
// del FUNCTION_INVOCATION_FAILED en la versión anterior.
// =============================================================================

export const config = { runtime: 'edge' }

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Content-Type': 'application/json',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: cors },
    )
  }

  try {
    const body = await req.json()
    const apiKey = req.headers.get('x-api-key') || process.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Missing API key (header x-api-key or env ANTHROPIC_API_KEY)' }),
        { status: 401, headers: cors },
      )
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: messages (array)' }),
        { status: 400, headers: cors },
      )
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
    return new Response(JSON.stringify(data), {
      status: r.status,
      headers: cors,
    })
  } catch (e) {
    console.error('Error en /api/generate:', e)
    return new Response(
      JSON.stringify({ error: e.message || 'Internal error' }),
      { status: 500, headers: cors },
    )
  }
}
