// src/lib/parseCalculador.js
// =============================================================================
// PARSER DEL CALCULADOR LRT — Instituto de Derecho del Trabajo (CALM)
// v1.0 - Mayo 2026
//
// Lee el .xlsx/.xlsm de la planilla del CALM y devuelve un objeto con todos
// los valores numéricos que necesitamos para redactar la sentencia. Como la
// planilla tiene formato fijo (celdas siempre en las mismas coordenadas),
// el parser es 100% determinista — no usa LLM ni regex sobre texto.
//
// IMPORTANTE: la planilla DEBE estar cargada con datos reales (12 salarios,
// fechas, % incapacidad, tasa BNA en C41). Si viene en blanco, devuelve
// `problemas` con la lista de campos faltantes.
//
// USO:
//   import { parseCalculadorCALM } from './parseCalculador'
//   const result = await parseCalculadorCALM(file)  // file: File object
//   if (result.problemas.length > 0) { ... }
//   const { meta, salarios, totales, calculos } = result
// =============================================================================

// SheetJS (XLSX global) ya se carga en claude.js cuando hay un .xlsx adjunto.
// Acá lo importamos por si se usa standalone, pero si XLSX ya está en window,
// reutilizamos la global para no duplicar la librería.

async function ensureXLSX() {
  if (typeof window !== 'undefined' && window.XLSX) return window.XLSX
  // Carga dinámica si no está cargada todavía
  await new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  return window.XLSX
}

// =============================================================================
// DETECCIÓN: ¿es la planilla del CALM?
// =============================================================================

export function esPlanillaCALM(workbook) {
  if (!workbook?.Sheets?.Calculador) return false
  const ws = workbook.Sheets.Calculador
  const a1 = ws['A1']?.v?.toString() || ''
  return a1.includes('CALM') ||
         a1.includes('COLEGIO DE ABOGADOS DE LA MATANZA') ||
         a1.includes('INSTITUTO DE DERECHO DEL TRABAJO')
}

// =============================================================================
// HELPERS de celda
// =============================================================================

function getCell(sheet, coord) {
  return sheet[coord]?.v
}

function getNum(sheet, coord) {
  const v = sheet[coord]?.v
  return typeof v === 'number' ? v : null
}

function getStr(sheet, coord) {
  const v = sheet[coord]?.v
  return v == null ? '' : v.toString().trim()
}

function getDate(sheet, coord) {
  const v = sheet[coord]?.v
  if (v instanceof Date) return v
  if (typeof v === 'number') {
    // Excel serial date → JS Date
    // Excel epoch: 1900-01-01 (con bug del año bisiesto)
    return new Date(Math.round((v - 25569) * 86400 * 1000))
  }
  return null
}

function formatFechaAR(date) {
  if (!(date instanceof Date)) return ''
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

// =============================================================================
// PARSER PRINCIPAL
// =============================================================================

export async function parseCalculadorCALM(file) {
  const XLSX = await ensureXLSX()
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { cellDates: true, type: 'array' })

  if (!esPlanillaCALM(wb)) {
    throw new Error(
      'No parece ser la planilla del Instituto de Derecho del Trabajo del CALM. ' +
      'Verificá que estés subiendo el archivo correcto.'
    )
  }

  const sheet = wb.Sheets['Calculador']

  // ---------- INPUTS (datos cargados por el usuario en el Excel) ----------
  const fechaAccidente = getDate(sheet, 'A16')
  const fechaLiquidacion = getDate(sheet, 'B16')
  const fechaNacimiento = getDate(sheet, 'C16')

  const meta = {
    nombre: getStr(sheet, 'C13'),
    fechaAccidente,
    fechaLiquidacion,
    fechaNacimiento,
    fechaAccidenteAR: formatFechaAR(fechaAccidente),
    fechaLiquidacionAR: formatFechaAR(fechaLiquidacion),
    fechaNacimientoAR: formatFechaAR(fechaNacimiento),
    edad: getNum(sheet, 'D16'),
    porcentajeIncapacidad: getNum(sheet, 'E16'), // decimal: 0.225 = 22.5%
    porcentajeIncapacidadPct:
      getNum(sheet, 'E16') != null ? getNum(sheet, 'E16') * 100 : null,
    ripteAccidente: getNum(sheet, 'F6'),
  }

  // ---------- TABLA DE 12 SALARIOS ----------
  const salarios = []
  for (let row = 22; row <= 33; row++) {
    const bruto = getNum(sheet, `B${row}`)
    // Ignorar filas con placeholder (bruto = 1 o vacío)
    if (bruto == null || bruto === 1) continue
    salarios.push({
      fecha: getDate(sheet, `A${row}`),
      fechaAR: formatFechaAR(getDate(sheet, `A${row}`)),
      bruto,
      ripteMes: getNum(sheet, `C${row}`),
      coef: getNum(sheet, `D${row}`),
      actualizado: getNum(sheet, `E${row}`),
    })
  }

  // ---------- SAC ----------
  const sac = [
    {
      mes: 'SAC Junio',
      ripteMes: getNum(sheet, 'C34'),
      coef: getNum(sheet, 'D34'),
      actualizado: getNum(sheet, 'E34'),
    },
    {
      mes: 'SAC Diciembre',
      ripteMes: getNum(sheet, 'C35'),
      coef: getNum(sheet, 'D35'),
      actualizado: getNum(sheet, 'E35'),
    },
  ]

  // ---------- TOTALES ----------
  const totales = {
    salariosBrutos: getNum(sheet, 'B36'),
    salariosActualizados: getNum(sheet, 'E36'),
  }

  // ---------- CÁLCULOS POR HIPÓTESIS ----------
  // A40 = IBM con RIPTE individual (mes a mes) = E36 / 12
  // C41 = IBM ajustado por tasa activa BNA (input externo del usuario)
  // D41 = IBM con RIPTE puro al día de liquidación = A40 × (RIPTE_actual / RIPTE_accidente)
  // E41 = IBM con RIPTE + Res. 332/23 (IGNORAR post-Muzychuk)
  const calculos = {
    ibmRipteIndividual: getNum(sheet, 'A40'),
    bna: {
      ibm: getNum(sheet, 'C41'),
      indemnizacionBase: getNum(sheet, 'C42'),
      incremento20: getNum(sheet, 'C43'),
      total: getNum(sheet, 'C44'),
    },
    riptePuro: {
      ibm: getNum(sheet, 'D41'),
      indemnizacionBase: getNum(sheet, 'D42'),
      incremento20: getNum(sheet, 'D43'),
      total: getNum(sheet, 'D44'),
    },
    ripteConRes332: {
      // SE IGNORA: post-Muzychuk el sistema no aplica Res 332/23
      ibm: getNum(sheet, 'E41'),
      indemnizacionBase: getNum(sheet, 'E42'),
      incremento20: getNum(sheet, 'E43'),
      total: getNum(sheet, 'E44'),
    },
    ripteActual: getNum(sheet, 'F44'),
    coefRipteGlobal: null, // se calcula abajo
  }

  if (calculos.ripteActual && meta.ripteAccidente) {
    calculos.coefRipteGlobal = calculos.ripteActual / meta.ripteAccidente
  }

  // ---------- VALIDACIÓN ----------
  const problemas = []
  if (!meta.fechaAccidente) problemas.push('Falta la fecha del accidente (celda A16)')
  if (!meta.fechaLiquidacion) problemas.push('Falta la fecha de liquidación (celda B16)')
  if (!meta.fechaNacimiento) problemas.push('Falta la fecha de nacimiento (celda C16)')
  if (!meta.porcentajeIncapacidad)
    problemas.push('Falta el porcentaje de incapacidad (celda E16)')
  if (salarios.length === 0)
    problemas.push(
      'No hay salarios cargados en la planilla. Cargá los 12 salarios en las celdas B22:B33.'
    )
  else if (salarios.length < 12)
    problemas.push(
      `Solo ${salarios.length} salarios cargados, deberían ser 12. ` +
      'Verificá que las celdas B22:B33 estén todas completadas.'
    )
  if (!calculos.bna.ibm)
    problemas.push(
      'Falta el IBM ajustado por tasa BNA en la celda C41. ' +
      'Calculalo externamente y cargalo en la planilla antes de subirla.'
    )
  if (!calculos.ripteActual || calculos.ripteActual < 1000)
    problemas.push('No se detectó el RIPTE actual (celda F44)')
  if (calculos.bna.total == null || isNaN(calculos.bna.total))
    problemas.push('La indemnización con BNA (C44) no se calculó. Revisá la planilla en Excel.')
  if (calculos.riptePuro.total == null || isNaN(calculos.riptePuro.total))
    problemas.push('La indemnización con RIPTE (D44) no se calculó. Revisá la planilla en Excel.')

  return {
    meta,
    salarios,
    sac,
    totales,
    calculos,
    problemas,
    esValida: problemas.length === 0,
  }
}

// =============================================================================
// ADAPTADOR para el resto del sistema
// =============================================================================

/**
 * Convierte el resultado del parser al formato que espera buildCalculos() y
 * los prompts de sentencia. Esto reemplaza el cálculo manual del sistema
 * actual.
 *
 * @param {object} parsed   Resultado de parseCalculadorCALM()
 * @param {boolean} esAccidente  true=accidente, false=enfermedad profesional
 * @returns {object}  Objeto compatible con buildCalculos() actual
 */
export function adaptToCalculos(parsed, esAccidente) {
  const { calculos: c, meta } = parsed
  const hipotesisB = c.riptePuro.indemnizacionBase
  const adicional20 = esAccidente ? c.riptePuro.incremento20 : 0
  const total = esAccidente ? c.riptePuro.total : hipotesisB

  return {
    ibmBruto: c.ibmRipteIndividual, // E36/12
    intereseseBNA: c.bna.ibm - c.ibmRipteIndividual, // los intereses puros
    ibmConIntereses: c.bna.ibm,
    hipotesisA: c.bna.indemnizacionBase, // sin +20%
    coefRipte: c.coefRipteGlobal,
    ripteActual: c.ripteActual,
    ripteAccidente: meta.ripteAccidente,
    ibmRIPTE: c.riptePuro.ibm,
    hipotesisB,
    adicional20,
    total,
    esAccidente,
    edad: meta.edad,
    porcentaje: meta.porcentajeIncapacidadPct,
    // Versiones formateadas para los prompts
    fmt: {
      ibmBruto: fmtAR(c.ibmRipteIndividual),
      intereseseBNA: fmtAR(c.bna.ibm - c.ibmRipteIndividual),
      ibmConIntereses: fmtAR(c.bna.ibm),
      hipotesisA: fmtAR(c.bna.indemnizacionBase),
      ibmRIPTE: fmtAR(c.riptePuro.ibm),
      hipotesisB: fmtAR(hipotesisB),
      adicional20: fmtAR(adicional20),
      total: fmtAR(total),
      ripteActual: fmtAR(c.ripteActual),
      ripteAccidente: fmtAR(meta.ripteAccidente),
    },
    // Datos extras que la planilla aporta y los prompts pueden usar
    salarios: parsed.salarios, // los 12 salarios mes a mes
    sac: parsed.sac,
    totalSalariosBrutos: parsed.totales.salariosBrutos,
    totalSalariosActualizados: parsed.totales.salariosActualizados,
    fuente: 'planilla_calm',
  }
}

function fmtAR(num) {
  if (num == null || isNaN(num)) return ''
  return num.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
