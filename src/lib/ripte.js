/**
 * Fetches the latest RIPTE value from the Argentine government website.
 * Uses a CORS proxy since the government site doesn't allow cross-origin requests.
 * Falls back to the Supabase stored value if the fetch fails.
 */

const RIPTE_URL = 'https://www.argentina.gob.ar/trabajo/seguridadsocial/ripte'
const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
]

/**
 * Parse the RIPTE value and period from the government page HTML
 */
function parseRipteFromHtml(html) {
  // The page has a table with months and RIPTE values
  // Look for the most recent entry
  const rows = []

  // Try multiple patterns the government site might use
  const patterns = [
    // Pattern 1: table rows with month and value
    /<tr[^>]*>.*?<td[^>]*>((?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)[^<]*\d{4})<\/td>.*?<td[^>]*>([\d.,]+)<\/td>/gi,
    // Pattern 2: simpler numeric pattern
    /(\d{4}-\d{2})[^>]*>([\d.,]+)\s*(?:\(RIPTE\)|<\/td>)/gi,
  ]

  for (const pattern of patterns) {
    let match
    pattern.lastIndex = 0
    while ((match = pattern.exec(html)) !== null) {
      rows.push({ period: match[1].trim(), raw: match[2].trim() })
    }
    if (rows.length > 0) break
  }

  // Also try to find large numbers (RIPTE values are typically 100k+)
  if (rows.length === 0) {
    const numPattern = /(\d{1,3}(?:\.\d{3})+(?:,\d{2})?)/g
    let match
    const numbers = []
    while ((match = numPattern.exec(html)) !== null) {
      const num = parseFloat(match[1].replace(/\./g, '').replace(',', '.'))
      if (num > 50000 && num < 1000000) {
        numbers.push(num)
      }
    }
    if (numbers.length > 0) {
      // Return the largest number found (most recent RIPTE)
      return { value: Math.max(...numbers), period: getCurrentPeriod(), source: 'parsed' }
    }
  }

  if (rows.length === 0) return null

  // Get the last (most recent) entry
  const last = rows[rows.length - 1]
  const value = parseFloat(last.raw.replace(/\./g, '').replace(',', '.'))
  if (isNaN(value)) return null

  return { value, period: last.period, source: 'table' }
}

function getCurrentPeriod() {
  const d = new Date()
  d.setMonth(d.getMonth() - 2) // RIPTE is usually 2 months behind
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function fetchRipteFromWeb() {
  for (const proxy of CORS_PROXIES) {
    try {
      const url = proxy + encodeURIComponent(RIPTE_URL)
      const response = await fetch(url, {
        headers: { 'Accept': 'text/html' },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) continue

      const html = await response.text()
      const result = parseRipteFromHtml(html)
      if (result) return result
    } catch (e) {
      console.warn('CORS proxy failed:', proxy, e.message)
    }
  }
  return null
}

/**
 * Format a RIPTE value for display
 */
export function formatRipte(value) {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Format a period string for display
 * '2026-02' → 'Febrero 2026'
 */
export function formatPeriod(period) {
  if (!period) return ''
  const months = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  const [year, month] = period.split('-')
  return `${months[parseInt(month)]} ${year}`
}
