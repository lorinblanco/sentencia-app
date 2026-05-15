export const config = { runtime: 'edge' }

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
  try {
    const res = await fetch('https://www.argentina.gob.ar/trabajo/seguridadsocial/ripte', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const html = await res.text()
    const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || []
    let ripteValue = null, ripteDate = null
    for (let i = rows.length - 1; i >= 0; i--) {
      const cells = rows[i].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []
      if (cells.length >= 2) {
        const dateCell = cells[0].replace(/<[^>]+>/g, '').trim()
        const valueCell = cells[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, '')
        if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(valueCell) && dateCell.length > 3) {
          ripteValue = valueCell; ripteDate = dateCell; break
        }
      }
    }
    if (!ripteValue) {
      const m = html.match(/(\d{1,3}(?:\.\d{3})+,\d{2})/)
      if (m) ripteValue = m[1]
    }
    return new Response(JSON.stringify({ ripte: ripteValue, fecha: ripteDate, ok: true }), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors })
  }
}
