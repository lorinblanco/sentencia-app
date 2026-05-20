// src/lib/claude.js
// =============================================================================
// SentencIA - Claude API client v8 (post-Muzychuk SCBA + Planilla CALM)
// =============================================================================
// Cambios v7 → v8:
//   - Integración con parseCalculador.js: si el usuario sube la planilla del
//     CALM como archivo extra, se parsea directamente (sin LLM) y se usan
//     esos valores como fuente de verdad para todos los cálculos.
//   - Nueva función detectarEsEnfermedad() que combina extract LLM + keywords
//     en chunks.header para detectar enfermedad profesional aunque el LLM
//     falle (caso JARA).
//   - buildCalculos() ahora acepta un tercer parámetro opcional `calmParsed`
//     y delega en adaptToCalculos() cuando está disponible.
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

/**
 * Intenta detectar y parsear un archivo como planilla del CALM.
 * Devuelve el resultado del parser, o null si el archivo no es una planilla CALM.
 *
 * @param {File} file
 * @returns {Promise<object|null>}
 */
export async function tryParsePlanillaCALM(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext !== 'xlsx' && ext !== 'xlsm') return null

  try {
    const parsed = await parseCalculadorCALM(file)
    // Si esPlanillaCALM falla, parseCalculadorCALM throwea — acá ya validamos
    return parsed
  } catch (e) {
    console.log('[CALM] Archivo Excel no es planilla del CALM:', e.message)
    return null
  }
}

// =============================================================================
// DETECCIÓN DUAL: ¿es enfermedad profesional?
// =============================================================================

/**
 * Detecta si el caso es enfermedad profesional combinando:
 *   1) Lo que extrajo el LLM en `tipo_accion_detectado`
 *   2) Keywords específicas en el chunk header del expediente
 *
 * Default: accidente (false).
 *
 * @param {object} chunks  Resultado de buildChunks()
 * @param {object} datos   JSON del extract LLM
 * @returns {boolean} true si es enfermedad profesional
 */
export function detectarEsEnfermedad(chunks, datos) {
  // Fuente 1: extract LLM
  const tipoLLM = (
    datos?.tipo_accion_detectado || datos?.tipo_accion || ''
  ).toUpperCase()

  if (tipoLLM.includes('ENFERMEDAD')) return true
  if (tipoLLM.includes('ACCIDENTE')) return false

  // Fuente 2: keywords en el chunk header (fallback robusto)
  const headerLower = (chunks?.header || '').toLowerCase()
  const indicadoresEnfermedad = [
    's/ enfermedad profesional',
    'materia: inicio demanda laboral por enfermedad profesional',
    'enfermedad profesional - acción especial',
    'enfermedad profesional - accion especial',
    'inicio demanda laboral por enfermedad profesional',
    'enfermedad profesional ley',
    'covid-19',
    'covid 19',
    'enfermedad-accidente',
    'dnu 367/2020',
  ]
  for (const indicador of indicadoresEnfermedad) {
    if (headerLower.includes(indicador)) return true
  }

  // Default: accidente
  return false
}

// =============================================================================
// CALL CLAUDE (sin cambios)
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
  try { data = JSON.parse(txt) }
  catch { throw new Error(`Respuesta inválida (${res.status}): ${txt.slice(0, 200)}`) }
  if (!res.ok) throw new Error(data.error?.message || data.error || `Error HTTP ${res.status}`)
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  if (!data.content?.[0]?.text) throw new Error('Respuesta vacía de la API')
  return data.content[0].text
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

/**
 * Construye el objeto "calculos" que se pasa a los prompts.
 *
 * Si recibe `calmParsed` con esValida=true, delega en adaptToCalculos()
 * (los números vienen 100% de la planilla del CALM, sin recalcular).
 *
 * En caso contrario, hace el cálculo manual original (multiplicación con
 * coeficiente único — el método legacy).
 *
 * Devuelve null si faltan datos críticos (caso RECHAZO).
 *
 * @param {object} config        Config del wizard (form de Paso 2)
 * @param {object} datos         JSON del extract LLM
 * @param {object} [calmParsed]  Resultado de parseCalculadorCALM (opcional)
 * @param {boolean} [esEnfermedad] Si se conoce el tipo, pasarlo
 */
export function buildCalculos(config, datos, calmParsed = null, esEnfermedad = null) {
  // === CASO PREFERIDO: hay planilla CALM válida ===
  if (calmParsed && calmParsed.esValida) {
    // Si no nos pasaron explícitamente el tipo, lo detectamos desde datos
    const esEnf = esEnfermedad != null
      ? esEnfermedad
      : (datos?.tipo_accion_detectado || datos?.tipo_accion || '').toUpperCase().includes('ENFERMEDAD')

    return adaptToCalculos(calmParsed, !esEnf)
  }

  // === CASO LEGACY: cálculo manual desde el config ===
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

  // Usar esEnfermedad explícito si vino; si no, inferir de datos
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
// EXTRACT (sin cambios estructurales — solo se mantiene el log para debug)
// =============================================================================

export async function extractBasicInfo(apiKey, chunks) {
  const prompt = buildExtractUserPrompt(chunks)
  const text = await callClaude(apiKey, prompt, 2500)
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
// GENERATE SECTION (sin cambios)
// =============================================================================

export async function generateSection(apiKey, sectionType, chunks, data, config, calculos = null) {
  let userPrompt
  switch (sectionType) {
    case 'antecedentes': userPrompt = buildAntecedentesUserPrompt(chunks, data, config); break
    case 'resolucion':   userPrompt = buildResolucionUserPrompt(chunks, data, config); break
    case 'ibm':          userPrompt = buildIbmUserPrompt(chunks, data, config, calculos); break
    case 'segunda':      userPrompt = buildSegundaUserPrompt(chunks, data, config, calculos); break
    case 'sentencia':    userPrompt = buildSentenciaUserPrompt(chunks, data, config, calculos); break
    default: throw new Error(`Sección desconocida: ${sectionType}`)
  }
  const maxTokens = sectionType === 'segunda' || sectionType === 'sentencia' ? 6000 : 4500
  return await callClaude(apiKey, userPrompt, maxTokens)
}

// Re-exports para conveniencia
export { detectarVarianteWeiss } from './sentenciaPrompts'
export { parseCalculadorCALM, adaptToCalculos, esPlanillaCALM } from './parseCalculador'

// =============================================================================
// LECTURA DE ARCHIVOS EXTRA
// =============================================================================
// IMPORTANTE: si el archivo es una planilla CALM, NO se debe procesar acá
// (el chunk afip no la necesita como texto plano). La detección se hace en
// NewSentence.jsx via tryParsePlanillaCALM() antes de invocar esta función.
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
