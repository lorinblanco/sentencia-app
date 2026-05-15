// SentencIA - Claude API client v6
// Extrae texto del PDF localmente con PDF.js y envía solo chunks específicos a la API
// Esto evita el rate limit de 30k tokens/min al no mandar PDFs binarios

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

// Extrae texto completo del PDF
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

// Divide el texto en chunks específicos por keywords
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

  // Pericia: buscar hallazgos médicos exactos
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

  // AFIP/IBM: salarios y RIPTE
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

  // Si hay archivos extra (remuneraciones), agregarlos al chunk AFIP
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

  // Final: últimos 12k chars
  const final_ = fullText.slice(Math.max(0, len - 12000))

  return { header, pericia, afip, alegatos, final: final_ }
}

const SYSTEM = `Sos la Dra. Andrea Marcela Zacarías (u otro magistrado designado primer voto), integrante del Tribunal del Trabajo N°5 de Quilmes.
Redactás proyectos de sentencias judiciales laborales con el NIVEL DE DETALLE EXACTO de los modelos reales del Tribunal.

REGLAS ABSOLUTAS:
1. Cuando leés texto de un expediente, extraés y usás TODOS los datos concretos. NUNCA escribís [COMPLETAR] si el dato aparece en el texto.
2. Nivel de detalle MÁXIMO: describís cada hallazgo del perito (grados de movimiento exactos, signos Tinel/Phalen/bostezo/cajón, estudios con fechas, material de osteosíntesis)
3. Escalas psicológicas completas (Beck, Hamilton, TEPT, Rosenberg) si las hay
4. Tabla AFIP/RIPTE completa: los 12 meses individuales (período, salario, RIPTE, actualizado)
5. Fundamentación legal extensa: Muzychuk SCBA (inconstitucionalidad DNU 669/19), Barrios (cita textual), Monchiero, Amaya, Aquino, Milone, Ascua, Vizzoti
6. Hipótesis IBM: (a) tasa activa BNA, (b) RIPTE actualizado al último publicado
7. Estilo técnico-jurídico preciso, sin adornos
8. Inconstitucionalidad del inc. 2 art. 12 LRT: fundamento completo de 6-8 párrafos`

async function callClaude(apiKey, messages, maxTokens = 4000) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ system: SYSTEM, messages, max_tokens: maxTokens })
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

// Extrae datos básicos del expediente (causa, caratula, partes, accidente, etc.)
export async function extractBasicInfo(apiKey, chunks) {
  const prompt = `Del siguiente texto de inicio de un expediente judicial argentino del Tribunal del Trabajo N°5 de Quilmes, extraé exactamente estos datos. Respondé SOLO el JSON, sin texto adicional ni bloques markdown:

{
  "causa_numero": "",
  "caratula": "",
  "tipo_accion": "",
  "actor": { "nombre": "", "dni": "", "cuil": "", "fecha_nacimiento": "", "edad_al_accidente": null, "domicilio": "", "tareas": "" },
  "demandada": [{ "nombre": "", "cuit": "" }],
  "empleador": { "nombre": "", "cuit": "" },
  "letrado_actor": { "nombre": "", "matricula": "" },
  "letrado_demandada": [{ "nombre": "", "matricula": "" }],
  "accidente": { "fecha": "", "descripcion_detallada": "", "diagnostico_inicial": "", "intervenciones_quirurgicas": "", "fecha_alta": "" },
  "tramite_cm": { "expediente_srt": "", "fecha_dictamen_cm": "", "incapacidad_cm": "" },
  "pericia_medica": {
    "perito_nombre": "", "incapacidad_total_perito": null,
    "incapacidad_fisica_porcentaje": null,
    "factores_ponderacion": { "porcentaje": null }
  },
  "pericia_psiquiatrica": { "tiene": false, "incapacidad_porcentaje": null },
  "tipo_accion_detectado": ""
}

TIPOS DE ACCIÓN POSIBLES (elegí el que corresponda):
- "Acción especial – Ley 24.557"
- "Revisión resolución CM – Art. 2 inc. J ley 15.057"
- "Apelación resolución administrativa – Ley 27.348"
- "Enfermedad profesional – Acción especial"

TEXTO DEL EXPEDIENTE:
${chunks.header.slice(0, 12000)}`

  const text = await callClaude(apiKey, [{ role: 'user', content: prompt }], 2000)
  try {
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { _parseError: true, raw: text }
  }
}

// Genera una sección específica de la sentencia
export async function generateSection(apiKey, sectionType, chunks, data, config) {
  const prompt = buildPrompt(sectionType, chunks, data, config)
  return await callClaude(apiKey, [{ role: 'user', content: prompt }], 6000)
}

function buildPrompt(type, chunks, data, config) {
  const { juez1, juez2, weiss, honorarios = {} } = config
  const ripte = config.ripte_actual || '[RIPTE ACTUAL]'
  const rfecha = config.ripte_fecha || '[FECHA]'

  const j1Corto = juez1?.corto || 'Dra. Zacarías'
  const j2Corto = juez2?.corto || 'Dr. Stolarczyk'
  const j2NombreCompleto = juez2?.nombreCompleto || 'EL SEÑOR JUEZ DOCTOR STOLARCZYK'
  const weissNombreCompleto = weiss?.nombreCompleto || 'LA SEÑORA JUEZA DOCTORA WEISS'

  const REGLA = 'REGLA: Usá TODOS los datos exactos del texto. NUNCA pongas [COMPLETAR] si el dato está en el texto.\n\n'

  if (type === 'antecedentes') {
    return REGLA +
      'TEXTO DEL EXPEDIENTE (demanda, accidente, contestación, prueba):\n' +
      chunks.header + '\n\n' +
      'Redactá ÚNICAMENTE la sección "Antecedentes:" de la Primera Cuestión.\n\n' +
      'NIVEL DE DETALLE OBLIGATORIO:\n' +
      '- Fecha exacta de presentación de la demanda + letrado actor con tomo/folio/colegio\n' +
      '- Datos completos del actor: nombre, DNI, CUIL, fecha de nacimiento, domicilio, tareas\n' +
      '- Datos del empleador: nombre, CUIT, descripción de tareas, horario\n' +
      '- Relato detallado del accidente: fecha, hora, lugar, mecánica del siniestro\n' +
      '- Diagnóstico inicial, prestadores, intervenciones quirúrgicas con fechas, alta médica\n' +
      '- Incapacidad reclamada (física X%, psíquica X%) vs % CM, número expediente SRT\n' +
      '- Todos los planteos de inconstitucionalidad articulados\n' +
      '- Fecha de la contestación + letrado demandada con tomo/folio\n' +
      '- Postura de la demandada (reconocimientos, negativas, excepciones)\n' +
      '- Auto de apertura a prueba (fecha), informativas (AFIP y SRT con fechas)\n' +
      '- Dictamen pericial médico (fecha), impugnaciones y respuestas (fechas)\n' +
      '- Alegatos actor y demandada (fechas), pase al Acuerdo (fecha)\n\n' +
      'Comenzá exactamente con "Antecedentes:" — sin título adicional.'
  }

  if (type === 'resolucion') {
    return REGLA +
      'TEXTO DEL EXPEDIENTE — DICTAMEN PERICIAL MÉDICO:\n' + chunks.pericia + '\n\n' +
      'CONTEXTO — INICIO DEL EXPEDIENTE:\n' + chunks.header.slice(0, 4000) + '\n\n' +
      'Redactá ÚNICAMENTE la sección "Resolución:" de la Primera Cuestión.\n\n' +
      'ESTRUCTURA:\n\n' +
      '1. HECHOS INCUESTIONADOS (2-3 párrafos): accidente firme, prestaciones ART, % CM con N° expediente SRT, disconformidad.\n\n' +
      '2. PERICIA MÉDICA DETALLADA — la sección más extensa, usando TODOS los hallazgos del dictamen.\n' +
      '   Empezá con: "Al efecto y a fin de discernir la cuestión controvertida, este órgano jurisdiccional cuenta con la pericia médica presentada en fecha [fecha] por el Dr./Dra. [perito], M.P. [matrícula], quien luego de brindar los antecedentes de interés médico legal, practicó el examen médico pericial:"\n\n' +
      '   Para CADA región afectada describí en detalle:\n' +
      '   - Diagnóstico específico\n' +
      '   - Grados exactos de movimiento (ej: flexión 0°-110°, extensión 0°-30°)\n' +
      '   - Signos clínicos (Tinel +/-, Phalen +/-, bostezo +/-, cajón +/-, Lassègue)\n' +
      '   - Estado muscular (hipotrofia, fuerza)\n' +
      '   - Material de osteosíntesis si hay\n' +
      '   - Estudios complementarios con fecha y hallazgos\n\n' +
      '   Si hay pericia psiquiátrica: escalas con resultados numéricos (Beck X/63, Hamilton X/52, TEPT X/80, Rosenberg X/40), diagnóstico DSM/CIE.\n\n' +
      '   Porcentajes: cada región con su %, factores de ponderación, TOTAL %.\n\n' +
      '3. ANÁLISIS DE IMPUGNACIONES (si las hay): fundamentos demandada y respuesta del perito.\n\n' +
      '4. CONCLUSIÓN: "No hallando razones que ameriten apartarme de lo dictaminado por el perito médico, considerando las objeciones de la parte demandada en fecha [fecha] y las explicaciones del galeno, tengo por probado que [el/la actor/a] es portador/a de una incapacidad psicofísica parcial y permanente del [X]% de la T.O. por el accidente por el que aquí se acciona."\n\n' +
      'Comenzá exactamente con "Resolución:"'
  }

  if (type === 'ibm') {
    return REGLA +
      'TEXTO DEL EXPEDIENTE — SECCIÓN AFIP/RIPTE/IBM:\n' + chunks.afip + '\n\n' +
      'CONTEXTO — INICIO:\n' + chunks.header.slice(0, 3000) + '\n\n' +
      'Redactá la sección IBM y el cierre de la Primera Cuestión:\n\n' +
      '1. INTRODUCCIÓN IBM:\n' +
      '   "A fin de determinar el ingreso base mensual, tendré en consideración el promedio mensual de todos los salarios devengados —de conformidad con lo establecido por el artículo 1° del Convenio N° 95 de la OIT— por el trabajador durante el año anterior al accidente, según las remuneraciones informadas por AFIP (prueba informativa recibida el [fecha]), actualizados mes a mes aplicándose la variación del índice RIPTE:"\n\n' +
      '2. TABLA DE 12 MESES: si tenés los salarios AFIP y valores RIPTE en el texto, transcribí TODOS con formato:\n' +
      '   PERÍODO: $ SALARIO_AFIP → actualizado: $ SALARIO_ACTUALIZADO\n' +
      '   Luego: Total salarios actualizados por RIPTE: $ TOTAL\n\n' +
      `3. "RIPTE a la fecha de la contingencia: [valor exacto si está en el texto]"\n` +
      `   "RIPTE actual (último publicado): $ ${ripte} (${rfecha})"\n` +
      `   "Valor Ingreso Base (VIB/IBM) art. 12 LRT: $ [monto exacto]"\n` +
      `   "IBM con intereses (tasa activa BNA desde fecha accidente): $ [monto]"\n\n` +
      '4. EDAD: "Teniendo en cuenta la fecha de nacimiento del/de la actor/a —[fecha]—, y la del accidente sufrido —[fecha]—, tengo por acreditado que contaba con [X] años de edad a la fecha del siniestro."\n\n' +
      '5. CIERRE: "Así lo voto (art. 57 inc. 4) ley 15.057)."\n\n' +
      'No incluyas Segunda Cuestión ni adhesiones. Solo terminá con "Así lo voto".'
  }

  if (type === 'segunda') {
    return REGLA +
      'TEXTO DEL EXPEDIENTE — DICTAMEN, AFIP y ALEGATOS:\n' +
      chunks.afip.slice(0, 10000) + '\n\n--- ALEGATOS ---\n\n' + chunks.alegatos + '\n\n' +
      'Redactá ÚNICAMENTE el contenido del voto de la SEGUNDA CUESTIÓN (sin el encabezado "SEGUNDA CUESTIÓN" ni "A LA SEGUNDA CUESTIÓN PLANTEADA").\n\n' +
      'ESTRUCTURA con MÁXIMO DETALLE:\n\n' +
      '1. SÍNTESIS (2 párrafos): lo probado (incapacidad %, IBM base) + IBM actualizado con RIPTE + intereses.\n\n' +
      '2. RAZONAMIENTO CONSTITUCIONAL (8-10 párrafos extensos):\n' +
      '   a) Art. 11 ley 27.348 y su finalidad\n' +
      '   b) DNU 669/19: "aunque inconstitucional por falta de los presupuestos de necesidad y urgencia, según lo resuelto por la SCBA en \'Muzychuk\'..."\n' +
      '   c) Fallo Barrios SCBA: CITAR TEXTUALMENTE: "el alza generalizada de los precios y la depreciación monetaria, agravados en los últimos tiempos y fuertemente en el último bienio, parece una constante"\n' +
      '   d) Monchiero L.120.521, Amaya L.120.648, Aquino, Milone, Ascua, Vizzoti — tutela preferente del trabajador\n' +
      '   e) Incompatibilidad inc. 2 art. 12 LRT con arts. 14 bis y 17 CN\n' +
      '   f) Declaración de inconstitucionalidad del inc. 2 art. 12 LRT\n\n' +
      '3. COMPARATIVA IBM (párrafo central):\n' +
      '   "La fórmula utilizando tasa activa BNA desde [fecha accidente] arroja un IBM de $ [TASA] y una indemnización de $ [INDEM_A]; mientras que aplicando RIPTE, el IBM se elevaría a $ [RIPTE] y la indemnización alcanzaría $ [INDEM_B] (último RIPTE ' +
      rfecha + ': $ ' + ripte + ' / RIPTE [mes accidente]: $ [X] / coeficiente: [Y] / IBM base × coef = $ [IBM RIPTE] / 53 × IBM × 65 ÷ edad × %)."\n\n' +
      '4. CÁLCULO FINAL:\n' +
      '   "Conforme arts. 6 y 14.2 ley 24.557, teniendo en cuenta la edad ([X] años) y la incapacidad ([X]%), la indemnización es: 53 × $ [IBM RIPTE] × 65 ÷ [edad] × [%]% = $ [MONTO]."\n' +
      '   "Corresponde adicionar el 20% del art. 3 ley 26.773: $ [20%]."\n' +
      '   "Total: $ [MONTO + 20%] (PESOS [EN LETRAS])."\n\n' +
      '5. INTERESES: art. 770 CCC, tasa activa BNA 30 días desde mora hasta cancelación.\n\n' +
      '6. ABSTRACTO INCONSTITUCIONALIDADES restantes.\n\n' +
      '7. COSTAS: a cargo de la demandada vencida (art. 24 ley 15.057).\n\n' +
      '8. Cerrá con: "Así lo voto (art. 57 inc. 4) ley 15.057)."\n\n' +
      'NO incluyas adhesiones — solo el voto del primer juez.'
  }

  if (type === 'sentencia') {
    const honActor = honorarios.actor ? `$ ${honorarios.actor}` : '[A COMPLETAR]'
    const honDem = honorarios.dem ? `$ ${honorarios.dem}` : '[A COMPLETAR]'
    const honPerito = honorarios.perito ? `$ ${honorarios.perito}` : '[A COMPLETAR]'
    const honPsi = honorarios.tienePeritoPsi && honorarios.peritoPs ? `$ ${honorarios.peritoPs}` : null
    const nombreActor = honorarios.actorNombre || '[LETRADO ACTOR]'
    const nombreDem = honorarios.demNombre || '[LETRADO DEMANDADA]'

    return REGLA +
      'CONTEXTO — DATOS BÁSICOS:\n' + chunks.header.slice(0, 5000) + '\n\n' +
      '--- FINAL DEL EXPEDIENTE ---\n' + chunks.final + '\n\n' +
      'Redactá la SENTENCIA DISPOSITIVO completa (sin "S E N T E N C I A" ni el AUTOS Y VISTO, esos se agregan automáticamente).\n\n' +
      'INCISOS EN ORDEN EXACTO:\n\n' +
      '1°) Declarar la inconstitucionalidad del DNU 669/19 (art. 99 inc. 3° CN) y la inconstitucionalidad sobreviniente e inaplicabilidad al caso del inc. 2° del art. 12 ley 24.557 (por violentar arts. 14 bis, 17 y 33 CN).\n\n' +
      '2°) HACER LUGAR a la demanda. Monto: LETRAS ($ NÚMERO). Plazo: 10 días de quedar firme. Nombre del/de la actor/a. Nombre de la demandada. Arts.: 6.1, 8.1 y 14.2.a ley 24.557, art. 12 ley 27.348, art. 3 ley 26.773. Incapacidad X% T.O. Arts. 345 CPCC y 89 ley 15.057.\n\n' +
      '3°) INSTRUCCIONES CBU (texto íntegro obligatorio):\n' +
      '"En atención a lo dispuesto por el art. 17 de la ley 27.348; el monto de condena, se abonará por la demandada obligada al pago, en forma directa en la cuenta bancaria sueldo –ley 26.590– del trabajador (actor). A tal fin, se debe adjuntar constancia de CBU del acreedor judicial e informar sus datos en el expediente: nombre y apellido completo, CBU, CUIT, DNI, número y tipo de cuenta, banco, sucursal y localidad, correo electrónico, en el cuerpo del escrito que presenten.\n' +
      'Si el trabajador no contara con cuenta sueldo a su exclusiva titularidad –ley 26.590–, bajo juramento de decir verdad que no cuenta con la misma, podrá denunciar cualquier otra cuenta bancaria de la que sea único y exclusivo titular, no admitiéndose cuentas que contaren con otros titulares o, en su defecto, abrir a su exclusiva titularidad una cuenta gratuita en el Banco de la Provincia de Buenos Aires. (Cuenta DNI).\n' +
      'Una vez que se cumpla lo indicado en el párrafo anterior, comenzará a correr el plazo impuesto en la sentencia para que el obligado realice el pago.\n' +
      'La parte obligada al pago deberá acreditar en autos el debido cumplimiento de las obligaciones dinerarias impuestas dentro del mismo plazo que se dispone para que las abone."\n\n' +
      '4°) INTERESES: art. 770 CCC, acumulación al capital, tasa activa BNA 30 días hasta cancelación efectiva.\n\n' +
      '5°) COSTAS: a cargo de la demandada (art. 24 ley 15.057).\n\n' +
      `6°) HONORARIOS:\n` +
      `Letrado/a actor/a ${nombreActor}: ${honActor} (IUS según ac. 4200/25)\n` +
      `Letrado/a demandada ${nombreDem}: ${honDem}\n` +
      `Aportes previsionales 10% e IVA en caso de corresponder (arts. 2, 10, 13, 15, 16, 21, 23, 28, 29, 43, 51 y 54 ley 14.967).\n` +
      `Perito médico Dr./Dra. [PERITO]: ${honPerito} + aportes ley 6.742 y decreto 1.845/64 + IVA.\n` +
      (honPsi ? `Perito psiquiatra/psicólogo Dr./Dra. [PERITO PSI]: ${honPsi} + aportes + IVA.\n` : '') + '\n' +
      '7°) INSTRUCCIONES PAGO HONORARIOS (texto íntegro):\n' +
      '"Los honorarios se abonarán directamente en las cuentas bancarias de los profesionales (abogados y peritos), quienes deben adjuntar constancia de CBU y factura correspondiente e informar sus datos en el expediente: nombre y apellido completo, CBU, CUIT, DNI, número y tipo de cuenta, banco, sucursal y localidad, correo electrónico, en el cuerpo del escrito que presenten; conforme a las pautas que se especifican en: http://blogs.scba.gov.ar/tribunaltrabajo5quilmes/2020/08/12/solicitud-de-tranferencias/ (art. 12 ley 15.057).\n' +
      'Una vez que se cumpla lo indicado en el párrafo anterior, comenzará a correr el plazo para que el obligado realice el pago.\n' +
      'Asimismo, se hace saber que deberán acompañar los comprobantes de pago de aportes."\n\n' +
      'REGISTRESE, NOTIFIQUESE, con transcripción de lo dispuesto en el art. 54 Ley 14.967 y oportunamente ARCHIVESE.\n\n' +
      'TRANSCRIPCIÓN ART. 54 LEY 14.967 (texto íntegro):\n' +
      '"ARTÍCULO 54.- Las providencias que regulen honorarios deberán ser notificadas personalmente, por cédula a sus beneficiarios, al mandante o patrocinado y al condenado en costas, si lo hubiere. Asimismo, será válida la notificación de la regulación de honorarios efectuada por cualquier otro medio fehaciente, a costa del interesado. Los honorarios a cargo del mandante o patrocinado quedarán firmes a su respecto si la notificación se hubiere practicado en su domicilio real y a la contraparte en su domicilio constituido. Habiendo cesado el patrocinio o apoderamiento y constituido el ex cliente nuevo domicilio, la notificación de honorarios a éste podrá ser efectuada en este último domicilio. En todos los casos, bajo pena de nulidad, en el instrumento de notificación que se utilice para ello, deberá transcribirse este artículo. Los honorarios regulados por trabajos judiciales deberán abonarse dentro de los diez (10) días de haber quedado firme el auto regulatorio. Los honorarios por trabajos extrajudiciales se abonarán dentro de los diez (10) días de intimado su pago, cuando sean exigibles. Operada la mora, el profesional podrá optar por: a) reclamar los honorarios expresados en la unidad arancelaria Jus prevista en esta ley, con más un interés del 12% anual. b) reclamar los honorarios regulados convertidos al momento de la mora en moneda de curso legal, con más el interés previsto en el artículo 552 del Código Civil y Comercial de la Nación."'
  }

  return ''
}

// Lee texto de un archivo Excel/PDF de remuneraciones (para procesar archivos extra)
export async function extractExtraFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'pdf') {
    const result = await extractAllText(file)
    return `[Archivo: ${file.name}]\n${result.fullText.slice(0, 10000)}`
  }

  if (ext === 'xlsx' || ext === 'xls') {
    // Carga SheetJS dinámicamente
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
