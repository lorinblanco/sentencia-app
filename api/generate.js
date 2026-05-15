export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key')

  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const apiKey = req.headers['x-api-key']
    if (!apiKey) return res.status(401).json({ error: 'API key requerida' })

    const { system, messages, max_tokens = 1000 } = req.body

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
body: JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens,
  system,
  messages
})
    })

    const data = await anthropicRes.json()
    return res.status(200).json(data)
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
