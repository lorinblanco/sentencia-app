// src/lib/claude.js
// =============================================================================
// SentencIA - Claude API client v10
// =============================================================================
// Cambios v9 → v10:
//   1. detectarTipoAccion() reemplaza detectarEsEnfermedad(). Devuelve uno de
//      tres valores: 'ACCIDENTE' | 'ENFERMEDAD' | 'REVISION_CM'.
//      detectarEsEnfermedad() se mantiene como wrapper deprecated por compat.
//   2. validarTextoSentencia() escanea el texto generado en busca de frases
//      de fabricación ("si bien no surge...", "se desprende que...", etc.) y
//      devuelve la lista de hallazgos para mostrar al juez antes del DOCX.
//   3. generateSection() corre el validador automáticamente y adjunta los
//      hallazgos al callback opcional onValidation.
//   4. buildCalculos() recibe el tipoAccion (string) en lugar del flag
//      booleano esEnfermedad.
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
// PDF.js loader
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
// CHUNKING — chunk de pericia ampliado a 28k para capturar el dictamen completo
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
    'dictamen pericial - presenta',
    'perito médico presenta',
    'dictamen pericial',
    'i- proemio', 'i.- proemio',
    'antecedentes de interés médico',
    'examen médico-pericial', 'examen medico pericial',
    'valoracion del daño corporal', 'valoración del daño corporal',
    'flexion disminuida', 'flexión disminuida',
    'movimientos de flexion', 'movimientos de flexión',
    'portal artroscopico', 'portal artroscópico',
    'hipotrofia cuadricipital', 'hipotrofia',
    'bostezo articular', 'bostezo y cajon', 'bostezo y cajón',
    'cajon anterior', 'cajón anterior',
    'tinel positivo', 'tinel negativo',
    'phalen positivo', 'phalen negativo',
    'escala de beck', 'escala de hamilton',
    'examen pericial',
    'practico el examen', 'practicó el examen',
    'baremación', 'baremacion',
    'incapacidad parcial y permanente del',
    't.o. por',
  ])
  if (periIdx < 0) periIdx = find([
    'dictamino', 'dictaminó',
    'perito medico designado', 'el galeno determino',
    'segun el baremo', 'conforme el baremo',
  ])
  const pericia = periIdx > 0
    ? slice(periIdx - 3000, 28000)
    : fullText.slice(Math.floor(len * 0.40), Math.floor(len * 0.40) + 28000)

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
// PLANILLA CALM
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
// DETECCIÓN DE TIPO DE ACCIÓN (3 valores)
// =============================================================================

/**
 * Devuelve 'ACCIDENTE' | 'ENFERMEDAD' | 'REVISION_CM' analizando keywords
 * del header + el JSON del extract.
 */
export function detectarTipoAccion(chunks, datos) {
  const tag = (datos?.tipoAccion || '').toUpperCase()
  if (tag === 'ACCIDENTE' || tag === 'ENFERMEDAD' || tag === 'REVISION_CM') {
    return tag
  }

  const headerLower = (chunks?.header || '').toLowerCase()
  const tipoLLM = (datos?.tipo_accion_detectado || datos?.tipo_accion || '').toLowerCase()

  // Prioridad: REVISIÓN CM Ley 15.057 (mirar primero — puede convivir con
  // keywords de accidente o enfermedad)
  const indicadoresRevision = [
    'acción de revisión',
    'accion de revision',
    'revisión de resolución de comisión médica',
    'revision de resolucion de comision medica',
    'revisión res. comisión médica',
    'revision res. comision medica',
    'ley 15.057',
    'ley 15057',
    'art. 2 inc. j',
    'art 2 inc j',
    'inc. j ley 15.057',
    'disposición de alcance particular',
    'disposicion de alcance particular',
  ]
  if (
    indicadoresRevision.some(kw => headerLower.includes(kw)) ||
    tipoLLM.includes('revisi')
  ) {
    return 'REVISION_CM'
  }

  // ENFERMEDAD
  if (tipoLLM.includes('enfermedad')) return 'ENFERMEDAD'
  const indicadoresEnf = [
    's/ enfermedad profesional',
    'inicio demanda laboral por enfermedad profesional',
    'covid-19', 'covid 19',
    'dnu 367/2020', 'dnu 367/20',
    'decreto 367/2020',
    'presunción de enfermedad profesional',
  ]
  if (indicadoresEnf.some(kw => headerLower.includes(kw))) return 'ENFERMEDAD'

  return 'ACCIDENTE'
}

/**
 * Wrapper deprecated: devuelve true si tipo es ENFERMEDAD.
 * Mantenido por compatibilidad.
 */
export function detectarEsEnfermedad(chunks, datos) {
  return detectarTipoAccion(chunks, datos) === 'ENFERMEDAD'
}

// =============================================================================
// VALIDADOR DE ALUCINACIONES
// =============================================================================

const PATRONES_FABRICACION = [
  {
    code: 'JSON_LEAK',
    re: /\bjson\s+extra[ií]do\b/i,
    msg: 'El LLM menciona el "JSON extraído" — confiesa que está mirando datos crudos. Revisar pasaje.',
  },
  {
    code: 'SI_BIEN_NO_SURGE',
    re: /\bsi\s+bien\s+(no|del?)\s+[^.]{0,80}(no\s+surge|no\s+consta|no\s+figura)/i,
    msg: 'Frase clásica de fabricación: "Si bien no surge / no consta / no figura...". El LLM admite que falta el dato y sigue adelante. Reemplazar por marcador [FALTA: ...].',
  },
  {
    code: 'DESPRENDE_QUE',
    re: /(de\s+las?\s+constancias?[^.]{0,40}se\s+desprende\s+que|se\s+desprende\s+que\s+el\s+perito)/i,
    msg: 'Frase de fabricación: "se desprende que...". Suele preceder un dato inventado.',
  },
  {
    code: 'PUEDE_INFERIRSE',
    re: /\b(puede\s+inferirse|cabe\s+colegir|se\s+entiende\s+que|presumiblemente)\b/i,
    msg: 'Frase de inferencia que el LLM no debería usar en una sentencia.',
  },
  {
    code: 'HABRIA_DICTAMINADO',
    re: /\b(habr[ií]a\s+dictamin|habr[ií]a\s+manifestado|seg[uú]n\s+las\s+constancias)\b/i,
    msg: 'Condicional sospechoso. Verificar que el perito efectivamente lo dictaminó.',
  },
  {
    code: 'FALTA_MARKER',
    re: /\[FALTA:\s*[^\]]+\]/g,
    msg: 'Marcador [FALTA: ...] pendiente. Completar manualmente con el dato real antes de firmar.',
    isInfo: true,
  },
  {
    code: 'PERITO_PSI_GENERICO',
    re: /\bel\s+perito\s+(psicol[oó]gico|psiqui[aá]trico)\s+que\s+intervino\b/i,
    msg: 'Mención a "perito psicológico/psiquiátrico que intervino" — verificar que ese perito REALMENTE existe (no solo un legista que evaluó lo psíquico).',
  },
  {
    code: 'COMPLETAR',
    re: /\[COMPLETAR\]/g,
    msg: 'Placeholder "[COMPLETAR]" obsoleto — debería ser [FALTA: descripción específica].',
  },
]

/**
 * Escanea un texto buscando frases de fabricación.
 * @returns {Array<{code, msg, pasaje, isInfo}>}
 */
export function validarTextoSentencia(texto) {
  if (!texto) return []
  const hallazgos = []
  for (const p of PATRONES_FABRICACION) {
    const flags = p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g'
    const re = new RegExp(p.re.source, flags)
    let m
    while ((m = re.exec(texto)) !== null) {
      const start = Math.max(0, m.index - 60)
      const end = Math.min(texto.length, m.index + m[0].length + 60)
      const pasaje = texto.slice(start, end).replace(/\s+/g, ' ')
      hallazgos.push({
        code: p.code,
        msg: p.msg,
        pasaje: (start > 0 ? '…' : '') + pasaje + (end < texto.length ? '…' : ''),
        isInfo: !!p.isInfo,
      })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hallazgos
}

// =============================================================================
// CALL CLAUDE — streaming SSE
// =============================================================================

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

  // streaming
  const contentType = res.headers.get('content-type') || ''
  if (!res.ok || contentType.includes('application/json')) {
    const txt = await res.text()
    let data = null
    try { data = JSON.parse(txt) } catch {}
    throw new Error(data?.error?.message || data?.error || `Error HTTP ${res.status}: ${txt.slice(0, 200)}`)
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
    const events = buffer.split('\n\n')
    buffer = events.pop()

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
      try { obj = JSON.parse(dataLine) } catch { continue }

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
// PRE-CÁLCULOS con tipoAccion (3 valores)
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
 * Construye los cálculos para la sentencia.
 *
 * @param {string} tipoAccion         'ACCIDENTE' | 'ENFERMEDAD' | 'REVISION_CM'
 * @param {boolean} accidenteEnRevision  solo si tipoAccion=REVISION_CM:
 *                                    true si el hecho denunciado es accidente.
 */
export function buildCalculos(
  config, datos, calmParsed = null, tipoAccion = 'ACCIDENTE', accidenteEnRevision = true
) {
  // Compat hacia atrás (4to arg boolean = esEnfermedad)
  if (tipoAccion === true) tipoAccion = 'ENFERMEDAD'
  else if (tipoAccion === false) tipoAccion = 'ACCIDENTE'

  let esAccidente
  if (tipoAccion === 'ACCIDENTE') esAccidente = true
  else if (tipoAccion === 'ENFERMEDAD') esAccidente = false
  else esAccidente = accidenteEnRevision

  // RUTA 1: planilla CALM
  if (calmParsed && calmParsed.esValida) {
    const adapted = adaptToCalculos(calmParsed, esAccidente)
    adapted.tipoAccion = tipoAccion
    return adapted
  }

  // RUTA 2: cálculo manual
  const ripteActual = parseMonto(config.ripte_actual)
  const ripteAccidente = parseMonto(config.ripte_accidente)
  const intereseseBNA = parseMonto(config.intereses_bna)
  const ibmBruto = parseMonto(config.ibm_bruto) || parseMonto(datos?.ibm_bruto_afip)
  const edad = config.edad_actor || datos?.actor?.edad_al_accidente
  // CLAVE: % de incapacidad para la condena viene de la ACREDITADA (pericia),
  // no del % reclamado en la demanda.
  const porcentaje = config.porcentaje_incapacidad
    || datos?.incapacidad_acreditada_pericia?.total_porcentaje
    || datos?.pericia_medica?.incapacidad_total_perito
    || datos?.pericia_medica?.incapacidad_fisica_porcentaje

  if (!ripteActual || !ripteAccidente || ibmBruto == null || !edad || !porcentaje) return null
  if (intereseseBNA == null) return null

  const coefRipte = ripteActual / ripteAccidente
  const ibmConIntereses = ibmBruto + intereseseBNA
  const hipotesisA = calcIndemnizacion(ibmConIntereses, edad, porcentaje)
  const ibmRIPTE = ibmBruto * coefRipte
  const hipotesisB = calcIndemnizacion(ibmRIPTE, edad, porcentaje)

  const adicional20 = esAccidente ? hipotesisB * 0.20 : 0
  const total = hipotesisB + adicional20
  const totalEnLetras = numeroALetras(total, { conPesos: true })

  return {
    ibmBruto: round2(ibmBruto),
    intereseseBNA: round2(intereseseBNA),
    ibmConIntereses: round2(ibmConIntereses),
    hipotesisA: round2(hipotesisA),
    coefRipte: parseFloat(coefRipte.toFixed(3)),
    ripteActual, ripteAccidente,
    ibmRIPTE: round2(ibmRIPTE),
    hipotesisB: round2(hipotesisB),
    adicional20: round2(adicional20),
    total: round2(total),
    totalEnLetras,
    esAccidente, tipoAccion, edad, porcentaje,
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
// EXTRACT (no streaming)
// =============================================================================

export async function extractBasicInfo(apiKey, chunks) {
  const prompt = buildExtractUserPrompt(chunks)
  const text = await callClaude(apiKey, prompt, 3000)
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
// GENERATE SECTION — streaming + validador
// =============================================================================

/**
 * @param {Function} [onChunk]      callback de streaming (piece, soFar)
 * @param {Function} [onValidation] callback con hallazgos del validador,
 *                                  invocado al final con { sectionType, findings }
 */
export async function generateSection(
  apiKey, sectionType, chunks, data, config, calculos = null,
  onChunk = null, onValidation = null
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
  const maxTokens = sectionType === 'segunda' || sectionType === 'sentencia' ? 4800 : 4000
  const text = await callClaude(apiKey, userPrompt, maxTokens, onChunk)

  if (typeof onValidation === 'function') {
    const findings = validarTextoSentencia(text)
    onValidation({ sectionType, findings })
  }

  return text
}

// =============================================================================
// Re-exports
// =============================================================================

export { detectarVarianteWeiss } from './sentenciaPrompts'
export { parseCalculadorCALM, adaptToCalculos, esPlanillaCALM } from './parseCalculador'

// =============================================================================
// LECTURA DE ARCHIVOS EXTRA
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
