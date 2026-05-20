// src/lib/claude.js
// =============================================================================
// SentencIA - Claude API client v9 (streaming SSE)
// =============================================================================
// Cambios v8 → v9:
//   - callClaude() ahora acepta un callback opcional `onChunk`. Si se pasa,
//     hace streaming SSE: pide stream:true al proxy, parsea eventos
//     content_block_delta y va llamando al callback con cada pedazo de texto.
//   - generateSection() expone onChunk para que la UI pueda mostrar tokens
//     en tiempo real.
//   - extractBasicInfo() sigue NO usando streaming (necesita el JSON completo).
//   - Bajamos max_tokens de segunda/sentencia de 6000 a 4800 (margen de
//     seguridad sobre el timeout, aunque streaming ya lo neutraliza).
// =============================================================================

import {
  SYSTEM_PROMPT,
  buildExtractUserPrompt,
  buildAntecedentesUserPrompt,
  buildResolucionUserPrompt,
  buildIbmUserPrompt,
  buildSegundaUserPrompt,
  buildSentenciaUserPrompt,
  detectarVarianteWeiss,
} from './sentenciaPrompts'

import { numeroALetras, fmtMontoAR } from './numeroALetras'
import { parseCalculadorCALM, adaptToCalculos, esPlanillaCALM } from './parseCalculador'

// =============================================================================
// PDF.js loader (sin cambios)
// =============================================================================

async function loadPdfjs() {
  if (window.pdfjsLib) return
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
}

async function getPageText(pdf, n) {
  try {
    const page = await pdf.getPage(n)
    const c = await page.getTextContent()
    return c.items.map(i => i.str).join(' ')
  } catch (e) { return '' }
}

export async function extractAllText(file, onProgress) {
  await loadPdfjs()
  const ab = await file.arrayBuffer()
  const pdf = await window.pdfjsLib.getDocument({ data: ab }).promise
  const total = pdf.numPages
  const maxPages = Math.min(total, 600)
  let text = ''

  for (let i = 1; i <= maxPages; i++) {
    text += await getPageText(pdf, i) + '\n'
    if (onProgress && i % 30 === 0) {
      onProgress(Math.round(i / maxPages * 80))
    }
  }

  if (onProgress) onProgress(85)
  return { fullText: text, totalPages: total }
}

// =============================================================================
// CHUNKING (sin cambios)
// =============================================================================

export function buildChunks(fullText, extraTexts = []) {
  const fl = fullText.toLowerCase()
  const len = fullText.length

  function find(keywords) {
    let best = -1
    for (const kw of keywords) {
      const idx = fl.indexOf(kw)
      if (idx > 0 && (best < 0 || idx < best)) best = idx
    }
    return best
  }

  function slice(start, size) {
    if (start < 0) return ''
    return fullText.slice(Math.max(0, start), Math.min(len, start + size))
  }

  const header = fullText.slice(0, Math.min(25000, Math.floor(len * 0.15)))

  let periIdx = find([
    'flexion disminuida', 'flexión disminuida',
    'movimientos de flexion', 'movimientos de flexión',
    'portal artroscopico', 'portal artroscópico',
    'hipotrofia cuadricipital', 'hipotrofia',
    'bostezo articular', 'bostezo y cajon', 'bostezo y cajón',
    'cajon anterior', 'cajón anterior',
    'tinel positivo', 'tinel negativo',
    'phalen positivo', 'phalen negativo',
    'escala de beck', 'escala de hamilton',
    'hamilton:', 'beck:',
    'examen pericial', 'examen fisico pericial',
    'practico el examen', 'practicó el examen',
  ])
  if (periIdx < 0) periIdx = find([
    'dictamino', 'dictaminó',
    'perito medico designado', 'el galeno determino',
    'segun el baremo', 'conforme el baremo',
    'incapacidad parcial y permanente del',
    't.o. por',
  ])
  const pericia = periIdx > 0
    ? slice(periIdx - 3000, 22000)
    : fullText.slice(Math.floor(len * 0.40), Math.floor(len * 0.40) + 22000)

  let afipIdx = find([
    'vib (ripte)', 'v.i.b. (ripte)',
    'ripte del periodo', 'ripte del período',
    'salario actualizado', 'salarios actualizados',
    'valor ingreso base', 'ingreso base mensual',
    'remuneraciones informadas por afip',
    '202103', '202101', '202201', '202301', '202401', '202501',
  ])
  if (afipIdx < 0) afipIdx = find(['afip', 'ripte'])

  let afip = afipIdx > 0
    ? slice(afipIdx - 2000, 22000)
    : fullText.slice(Math.floor(len * 0.58), Math.floor(len * 0.58) + 22000)

  if (extraTexts.length > 0) {
    afip = 'REMUNERACIONES INFORMADAS POR AFIP (archivos adjuntos):\n\n' +
           extraTexts.join('\n\n---\n\n') +
           '\n\n=== TEXTO DEL EXPEDIENTE ===\n\n' + afip
  }

  const alegIdx = find([
    'presenta alegato', 'presentó su alegato',
    'presento su alegato', 'ha quedado probado',
    'han quedado probados',
  ])
  const alegatos = alegIdx > 0
    ? slice(alegIdx - 2000, 20000)
    : fullText.slice(Math.floor(len * 0.76), Math.floor(len * 0.76) + 20000)

  const final_ = fullText.slice(Math.max(0, len - 12000))

  return { header, pericia, afip, alegatos, final: final_ }
}

// =============================================================================
// PLANILLA CALM — detección y parsing
// =============================================================================

export async function tryParsePlanillaCALM(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext !== 'xlsx' && ext !== 'xlsm') return null
  try {
    return await parseCalculadorCALM(file)
  } catch (e) {
    console.log('[CALM] Archivo Excel no es planilla del CALM:', e.message)
    return null
  }
}

// =============================================================================
// DETECCIÓN DUAL: ¿es enfermedad profesional?
// =============================================================================

export function detectarEsEnfermedad(chunks, datos) {
  const tipoLLM = (
    datos?.tipo_accion_detectado || datos?.tipo_accion || ''
  ).toUpperCase()

  if (tipoLLM.includes('ENFERMEDAD')) return true
  if (tipoLLM.includes('ACCIDENTE')) return false

  const headerLower = (chunks?.header || '').toLowerCase()
  const indicadoresEnfermedad = [
    's/ enfermedad profesional',
    'materia: inicio demanda laboral por enfermedad profesional',
    'enfermedad profesional',
    'covid-19',
    'covid 19',
    'dnu 367/2020',
    'dnu 367/20',
    'decreto 367/2020',
    'presunción de enfermedad profesional',
  ]
  if (indicadoresEnfermedad.some(kw => headerLower.includes(kw))) return true

  return false
}

// =============================================================================
// CALL CLAUDE — con soporte de streaming SSE
// =============================================================================

/**
 * Llama al proxy /api/generate.
 *
 * @param {string} apiKey
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @param {(piece:string, soFar:string) => void} [onChunk]
 *   Si se pasa, activa streaming. Se invoca con cada pedazo de texto y el
 *   acumulado hasta el momento. Si no se pasa, espera la respuesta completa.
 * @returns {Promise<string>} texto completo
 */
async function callClaude(apiKey, userPrompt, maxTokens = 4000, onChunk = null) {
  const useStream = typeof onChunk === 'function'

  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: maxTokens,
      stream: useStream,
    }),
  })

  // ===== MODO NO-STREAMING =====
  if (!useStream) {
    const txt = await res.text()
    let data
    try { data = JSON.parse(txt) }
    catch { throw new Error(`Respuesta inválida (${res.status}): ${txt.slice(0, 200)}`) }
    if (!res.ok) throw new Error(data.error?.message || data.error || `Error HTTP ${res.status}`)
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
    if (!data.content?.[0]?.text) throw new Error('Respuesta vacía de la API')
    return data.content[0].text
  }

  // ===== MODO STREAMING =====
  // El proxy puede devolver JSON de error si Anthropic rechaza el request
  // antes de empezar a streamear. Detectamos por Content-Type.
  const contentType = res.headers.get('content-type') || ''
  if (!res.ok || contentType.includes('application/json')) {
    const txt = await res.text()
    let data = null
    try { data = JSON.parse(txt) } catch {}
    throw new Error(
      data?.error?.message || data?.error || `Error HTTP ${res.status}: ${txt.slice(0, 200)}`
    )
  }

  if (!res.body) throw new Error('Streaming no soportado por el navegador')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  let streamError = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE: eventos separados por línea en blanco (\n\n)
    const events = buffer.split('\n\n')
    buffer = events.pop() // último puede estar incompleto, lo guardamos

    for (const ev of events) {
      if (!ev.trim()) continue
      let eventName = ''
      let dataLine = ''
      for (const line of ev.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLine = line.slice(5).trim()
      }
      if (!dataLine || dataLine === '[DONE]') continue

      let obj
      try { obj = JSON.parse(dataLine) }
      catch { continue }

      // Anthropic envía estos eventos:
      //   message_start, content_block_start, content_block_delta,
      //   content_block_stop, message_delta, message_stop, error
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
        const piece = obj.delta.text || ''
        if (piece) {
          fullText += piece
          onChunk(piece, fullText)
        }
      } else if (obj.type === 'error' || eventName === 'error') {
        streamError = obj.error?.message || obj.message || 'Stream error'
      }
    }
  }

  if (streamError) throw new Error(streamError)
  if (!fullText) throw new Error('Stream vacío de la API')
  return fullText
}

// =============================================================================
// PRE-CÁLCULOS NUMÉRICOS (con soporte de planilla CALM)
// =============================================================================

function parseMonto(s) {
  if (typeof s === 'number') return s
  if (!s) return null
  const cleaned = s.toString().replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function round2(n) { return Math.round(n * 100) / 100 }

function calcIndemnizacion(ibm, edad, porcentaje) {
  return 53 * ibm * 65 / edad * (porcentaje / 100)
}

export function buildCalculos(config, datos, calmParsed = null, esEnfermedad = null) {
  if (calmParsed && calmParsed.esValida) {
    const esEnf = esEnfermedad != null
      ? esEnfermedad
      : (datos?.tipo_accion_detectado || datos?.tipo_accion || '').toUpperCase().includes('ENFERMEDAD')

    return adaptToCalculos(calmParsed, !esEnf)
  }

  const ripteActual = parseMonto(config.ripte_actual)
  const ripteAccidente = parseMonto(config.ripte_accidente)
  const intereseseBNA = parseMonto(config.intereses_bna)
  const ibmBruto = parseMonto(config.ibm_bruto) || parseMonto(datos?.ibm_bruto_afip)
  const edad = config.edad_actor || datos?.actor?.edad_al_accidente
  const porcentaje = config.porcentaje_incapacidad
    || datos?.pericia_medica?.incapacidad_total_perito
    || datos?.pericia_medica?.incapacidad_fisica_porcentaje

  if (!ripteActual || !ripteAccidente || ibmBruto == null || !edad || !porcentaje) return null
  if (intereseseBNA == null) return null

  const coefRipte = ripteActual / ripteAccidente
  const ibmConIntereses = ibmBruto + intereseseBNA
  const hipotesisA = calcIndemnizacion(ibmConIntereses, edad, porcentaje)
  const ibmRIPTE = ibmBruto * coefRipte
  const hipotesisB = calcIndemnizacion(ibmRIPTE, edad, porcentaje)

  const esEnf = esEnfermedad != null
    ? esEnfermedad
    : (datos?.tipo_accion_detectado || datos?.tipo_accion || 'ACCIDENTE').toUpperCase().includes('ENFERMEDAD')
  const esAccidente = !esEnf
  const adicional20 = esAccidente ? hipotesisB * 0.20 : 0
  const total = hipotesisB + adicional20
  const totalEnLetras = numeroALetras(total, { conPesos: true })

  return {
    ibmBruto: round2(ibmBruto),
    intereseseBNA: round2(intereseseBNA),
    ibmConIntereses: round2(ibmConIntereses),
    hipotesisA: round2(hipotesisA),
    coefRipte: parseFloat(coefRipte.toFixed(3)),
    ripteActual,
    ripteAccidente,
    ibmRIPTE: round2(ibmRIPTE),
    hipotesisB: round2(hipotesisB),
    adicional20: round2(adicional20),
    total: round2(total),
    totalEnLetras,
    esAccidente,
    edad,
    porcentaje,
    fuente: 'calculo_manual',
    fmt: {
      ibmBruto: fmtMontoAR(ibmBruto),
      intereseseBNA: fmtMontoAR(intereseseBNA),
      ibmConIntereses: fmtMontoAR(ibmConIntereses),
      hipotesisA: fmtMontoAR(hipotesisA),
      ibmRIPTE: fmtMontoAR(ibmRIPTE),
      hipotesisB: fmtMontoAR(hipotesisB),
      adicional20: fmtMontoAR(adicional20),
      total: fmtMontoAR(total),
      ripteActual: fmtMontoAR(ripteActual),
      ripteAccidente: fmtMontoAR(ripteAccidente),
    },
  }
}

// =============================================================================
// EXTRACT (no usa streaming — necesitamos el JSON completo de una vez)
// =============================================================================

export async function extractBasicInfo(apiKey, chunks) {
  const prompt = buildExtractUserPrompt(chunks)
  const text = await callClaude(apiKey, prompt, 2500) // sin onChunk → no-streaming
  try {
    const clean = text.replace(/```json|```/g, '').trim()
    const json = JSON.parse(clean)
    console.log('🔍 JSON extraído:', json)
    return json
  } catch {
    console.error('🔍 Extract FAILED, raw:', text)
    return { _parseError: true, raw: text }
  }
}

// =============================================================================
// GENERATE SECTION — usa streaming si se pasa onChunk
// =============================================================================

/**
 * @param {Function} [onChunk]  callback (piece, soFar) para streaming
 */
export async function generateSection(
  apiKey, sectionType, chunks, data, config, calculos = null, onChunk = null
) {
  let userPrompt
  switch (sectionType) {
    case 'antecedentes': userPrompt = buildAntecedentesUserPrompt(chunks, data, config); break
    case 'resolucion':   userPrompt = buildResolucionUserPrompt(chunks, data, config); break
    case 'ibm':          userPrompt = buildIbmUserPrompt(chunks, data, config, calculos); break
    case 'segunda':      userPrompt = buildSegundaUserPrompt(chunks, data, config, calculos); break
    case 'sentencia':    userPrompt = buildSentenciaUserPrompt(chunks, data, config, calculos); break
    default: throw new Error(`Sección desconocida: ${sectionType}`)
  }
  // 4800 para las pesadas (sigue siendo ~3500 palabras), 4000 para el resto
  const maxTokens = sectionType === 'segunda' || sectionType === 'sentencia' ? 4800 : 4000
  return await callClaude(apiKey, userPrompt, maxTokens, onChunk)
}

// Re-exports para conveniencia
export { detectarVarianteWeiss } from './sentenciaPrompts'
export { parseCalculadorCALM, adaptToCalculos, esPlanillaCALM } from './parseCalculador'

// =============================================================================
// LECTURA DE ARCHIVOS EXTRA (sin cambios)
// =============================================================================

export async function extractExtraFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'pdf') {
    const result = await extractAllText(file)
    return `[Archivo: ${file.name}]\n${result.fullText.slice(0, 10000)}`
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
        s.onload = resolve
        s.onerror = reject
        document.head.appendChild(s)
      })
    }
    const ab = await file.arrayBuffer()
    const wb = window.XLSX.read(ab, { type: 'array' })
    let text = `[Archivo: ${file.name}]\n`
    wb.SheetNames.forEach(name => {
      const sheet = wb.Sheets[name]
      const csv = window.XLSX.utils.sheet_to_csv(sheet)
      text += `\n--- Hoja: ${name} ---\n${csv.slice(0, 8000)}\n`
    })
    return text
  }

  return ''
}
