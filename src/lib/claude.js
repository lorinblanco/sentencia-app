// src/lib/claude.js
// =============================================================================
// SentencIA - Claude API client v7 (post-Muzychuk SCBA)
// =============================================================================
// Cambios respecto a v6:
//   - El system prompt y los prompts por sección vienen de sentenciaPrompts.js
//     (no más SYSTEM constante hardcoded, no más buildPrompt() acá).
//   - Pre-calcula en JS: intereses BNA (input manual), coeficiente RIPTE,
//     IBM actualizado, hipótesis A y B, total final, total en letras.
//   - Detecta automáticamente la variante del voto de Weiss.
//   - Sigue extrayendo el PDF localmente con PDF.js y enviando chunks
//     (sin cambios en buildChunks() ni extractAllText()).
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

// =============================================================================
// PDF.js loader (sin cambios respecto a v6)
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
// CHUNKING (sin cambios respecto a v6)
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

  // Header: primeros 25k chars
  const header = fullText.slice(0, Math.min(25000, Math.floor(len * 0.15)))

  // Pericia
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
    'practico el examen', 'practicó el examen'
  ])
  if (periIdx < 0) periIdx = find([
    'dictamino', 'dictaminó',
    'perito medico designado', 'el galeno determino',
    'segun el baremo', 'conforme el baremo',
    'incapacidad parcial y permanente del',
    't.o. por'
  ])
  const pericia = periIdx > 0
    ? slice(periIdx - 3000, 22000)
    : fullText.slice(Math.floor(len * 0.40), Math.floor(len * 0.40) + 22000)

  // AFIP/IBM
  let afipIdx = find([
    'vib (ripte)', 'v.i.b. (ripte)',
    'ripte del periodo', 'ripte del período',
    'salario actualizado', 'salarios actualizados',
    'valor ingreso base', 'ingreso base mensual',
    'remuneraciones informadas por afip',
    '202103', '202101', '202201', '202301', '202401', '202501'
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

  // Alegatos
  const alegIdx = find([
    'presenta alegato', 'presentó su alegato',
    'presento su alegato', 'ha quedado probado',
    'han quedado probados'
  ])
  const alegatos = alegIdx > 0
    ? slice(alegIdx - 2000, 20000)
    : fullText.slice(Math.floor(len * 0.76), Math.floor(len * 0.76) + 20000)

  const final_ = fullText.slice(Math.max(0, len - 12000))

  return { header, pericia, afip, alegatos, final: final_ }
}

// =============================================================================
// CALL CLAUDE (proxy al endpoint /api/generate existente)
// =============================================================================

async function callClaude(apiKey, userPrompt, maxTokens = 4000) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: maxTokens,
    }),
  })
  const txt = await res.text()
  let data
  try {
    data = JSON.parse(txt)
  } catch {
    throw new Error(`Respuesta inválida (${res.status}): ${txt.slice(0, 200)}`)
  }
  if (!res.ok) {
    throw new Error(data.error?.message || data.error || `Error HTTP ${res.status}`)
  }
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  if (!data.content?.[0]?.text) throw new Error('Respuesta vacía de la API')
  return data.content[0].text
}

// =============================================================================
// PRE-CÁLCULOS NUMÉRICOS (JavaScript, no Claude)
// =============================================================================

function parseMonto(s) {
  if (typeof s === 'number') return s
  if (!s) return null
  // "198.241,70" o "$198.241,70" → 198241.70
  const cleaned = s.toString().replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function round2(n) { return Math.round(n * 100) / 100 }

function calcIndemnizacion(ibm, edad, porcentaje) {
  return 53 * ibm * 65 / edad * (porcentaje / 100)
}

/**
 * Construye el objeto "calculos" que se pasa a los prompts.
 * Devuelve null si falta info crítica (lo cual indica caso de RECHAZO).
 */
export function buildCalculos(config, datos) {
  const ripteActual = parseMonto(config.ripte_actual)
  const ripteAccidente = parseMonto(config.ripte_accidente)
  const intereseseBNA = parseMonto(config.intereses_bna)
  const ibmBruto = parseMonto(config.ibm_bruto) || parseMonto(datos?.ibm_bruto_afip)
  const edad = config.edad_actor || datos?.actor?.edad_al_accidente
  const porcentaje = config.porcentaje_incapacidad
    || datos?.pericia_medica?.incapacidad_total_perito
    || datos?.pericia_medica?.incapacidad_fisica_porcentaje

  // Si falta cualquier dato crítico, no se puede calcular (rechazo)
  if (!ripteActual || !ripteAccidente || ibmBruto == null || !edad || !porcentaje) {
    return null
  }
  if (intereseseBNA == null) {
    // Faltan los intereses BNA: el usuario debe completarlos
    return null
  }

  const coefRipte = ripteActual / ripteAccidente
  const ibmConIntereses = ibmBruto + intereseseBNA
  const hipotesisA = calcIndemnizacion(ibmConIntereses, edad, porcentaje)
  const ibmRIPTE = ibmBruto * coefRipte
  const hipotesisB = calcIndemnizacion(ibmRIPTE, edad, porcentaje)

  const tipoEvento = (datos?.tipo_accion_detectado || datos?.tipo_accion || 'ACCIDENTE').toUpperCase()
  const esAccidente = !tipoEvento.includes('ENFERMEDAD')
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
   fmt: {
      ibmBruto: fmtMontoAR(ibmBruto),
      intereseseBNA: fmtMontoAR(intereseseBNA),
      ibmConIntereses: fmtMontoAR(ibmConIntereses),
      hipotesisA: fmtMontoAR(hipotesisA),
      ibmRIPTE: fmtMontoAR(ibmRIPTE),
      hipotesisB: fmtMontoAR(hipotesisB),
      adicional20: fmtMontoAR(adicional20),
      total: fmtMontoAR(total),
      // NUEVO v2.3: RIPTE formateado para evitar que el LLM lo reformatee mal
      ripteActual: fmtMontoAR(ripteActual),
      ripteAccidente: fmtMontoAR(ripteAccidente),
    },
  }
}

// =============================================================================
// EXTRACCIÓN DE DATOS BÁSICOS (paso 1)
// =============================================================================

export async function extractBasicInfo(apiKey, chunks) {
  const prompt = buildExtractUserPrompt(chunks)
  const text = await callClaude(apiKey, prompt, 2500)
  try {
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { _parseError: true, raw: text }
  }
}

// =============================================================================
// GENERACIÓN DE SECCIONES (pasos 2-5)
// =============================================================================

export async function generateSection(apiKey, sectionType, chunks, data, config, calculos = null) {
  let userPrompt
  switch (sectionType) {
    case 'antecedentes':
      userPrompt = buildAntecedentesUserPrompt(chunks, data, config)
      break
    case 'resolucion':
      userPrompt = buildResolucionUserPrompt(chunks, data, config)
      break
    case 'ibm':
      userPrompt = buildIbmUserPrompt(chunks, data, config, calculos)
      break
    case 'segunda':
      userPrompt = buildSegundaUserPrompt(chunks, data, config, calculos)
      break
    case 'sentencia':
      userPrompt = buildSentenciaUserPrompt(chunks, data, config, calculos)
      break
    default:
      throw new Error(`Sección desconocida: ${sectionType}`)
  }

  const maxTokens = sectionType === 'segunda' || sectionType === 'sentencia' ? 6000 : 4500
  return await callClaude(apiKey, userPrompt, maxTokens)
}

// Re-export para conveniencia
export { detectarVarianteWeiss } from './sentenciaPrompts'

// =============================================================================
// LECTURA DE ARCHIVOS EXTRA (sin cambios respecto a v6)
// =============================================================================

export async function extractExtraFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'pdf') {
    const result = await extractAllText(file)
    return `[Archivo: ${file.name}]\n${result.fullText.slice(0, 10000)}`
  }

  if (ext === 'xlsx' || ext === 'xls') {
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
