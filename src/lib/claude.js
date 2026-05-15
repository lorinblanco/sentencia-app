// Claude API client - proxied through Vercel Edge Function

const TEMPLATE_CONTEXT = `Sos la Dra. Andrea Marcela Zacarías (u otro magistrado designado primer voto), integrante del Tribunal del Trabajo N°5 de Quilmes.
Redactás proyectos de sentencias judiciales laborales con el NIVEL DE DETALLE EXACTO de los modelos reales del Tribunal.

REGLAS ABSOLUTAS:
1. El nivel de detalle debe ser MÁXIMO: describís cada hallazgo físico del perito (grados de movimiento exactos, signos Tinel/Phalen/bostezo/cajón, estudios complementarios con fechas, material de osteosíntesis si hay)
2. Las escalas psicológicas van completas cuando las hay (Beck, Hamilton, TEPT, Rosenberg)
3. La tabla AFIP/RIPTE va completa con los 12 meses individuales (período, salario, RIPTE, actualizado)
4. La fundamentación legal es extensa: Muzychuk (SCBA - inconstitucionalidad DNU 669/19), Barrios (con cita textual), Monchiero, Amaya, Aquino, Milone, Ascua, Vizzoti
5. Las hipótesis IBM: (a) tasa activa BNA, (b) RIPTE actualizado al último publicado
6. Nunca resumís. Si falta un dato del expediente, lo dejás en [COMPLETAR] pero el resto va completo y detallado
7. Estilo técnico-jurídico preciso, sin adornos
8. Cuando la IA declara inconstitucionalidad del inc. 2 art. 12 LRT: fundamento completo de 6-8 párrafos`;

async function callClaude(apiKey, system, messages, maxTokens = 2000) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ system, messages, max_tokens: maxTokens })
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || `Error HTTP ${res.status}`)
  }
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  if (!data.content?.[0]?.text) throw new Error('Respuesta vacía de la API')
  return data.content[0].text
}

// ── Step 1: Extract structured data from PDF ──────────────────────────────────
export async function extractExpedienteData(apiKey, pdfBase64) {
  const extractSystem = `Sos un asistente judicial especializado en causas laborales del Tribunal de Trabajo N°5 de Quilmes. 
Extraés datos de expedientes judiciales con máxima precisión. 
Respondés ÚNICAMENTE con JSON válido, sin texto adicional, sin bloques de código markdown.`

  const extractPrompt = `Analizá este expediente judicial y extraé TODOS los datos relevantes para dictar sentencia.

Devolvé ÚNICAMENTE este JSON (sin texto extra):
{
  "causa_numero": "",
  "caratula": "",
  "tipo_accion": "",
  "actor": { "nombre": "", "dni": "", "cuil": "", "fecha_nacimiento": "", "edad_al_accidente": null, "domicilio": "", "tareas": "" },
  "demandada": [{ "nombre": "", "cuit": "" }],
  "empleador": { "nombre": "", "cuit": "" },
  "letrado_actor": { "nombre": "", "matricula": "", "calidad": "apoderado" },
  "letrado_actor_patrocinante": { "nombre": "", "matricula": "" },
  "letrado_demandada": [{ "nombre": "", "matricula": "" }],
  "accidente": {
    "fecha": "", "hora": "", "tipo": "",
    "descripcion_detallada": "",
    "diagnostico_inicial": "", "prestador_inicial": "",
    "intervenciones_quirurgicas": "", "fecha_alta": ""
  },
  "tramite_cm": {
    "expediente_srt": "", "comision_medica": "373-Quilmes",
    "fecha_dictamen_cm": "", "incapacidad_cm": "", "diagnostico_cm": ""
  },
  "tramite_judicial": {
    "fecha_demanda": "", "fecha_contestacion": "",
    "excepcion_prescripcion": false,
    "fecha_apertura_prueba": "",
    "fecha_informativa_srt": "", "fecha_informativa_afip": "",
    "fecha_dictamen_pericial": "", "fecha_impugnacion_pericia": "",
    "fecha_respuesta_perito": "",
    "fecha_alegatos_actor": "", "fecha_alegatos_demandada": "",
    "fecha_pase_acuerdo": "", "otros_actos": []
  },
  "pericia_medica": {
    "perito_nombre": "", "perito_matricula": "",
    "region_1": { "nombre": "", "diagnostico": "", "hallazgos_examen": "", "grados_movimiento": "", "signos_especiales": "", "estudios_complementarios": "" },
    "region_2": { "nombre": "", "diagnostico": "", "hallazgos_examen": "" },
    "region_3": { "nombre": "", "diagnostico": "", "hallazgos_examen": "" },
    "incapacidad_fisica_porcentaje": null, "incapacidad_fisica_detalle": "",
    "factores_ponderacion": { "dificultad_porcentaje": null, "edad_porcentaje": null, "descripcion": "" },
    "incapacidad_total_perito": null,
    "impugnacion_fundamentos": "", "respuesta_perito": ""
  },
  "pericia_psiquiatrica": {
    "tiene": false, "perito_nombre": "", "perito_matricula": "",
    "escalas_aplicadas": [], "diagnostico": "",
    "incapacidad_porcentaje": null, "impugnacion": ""
  },
  "datos_afip": {
    "salarios_mensuales": [],
    "ripte_contingencia_mes": "", "ripte_contingencia_valor": null,
    "vib_ripte_base": null, "ibm_con_intereses": null
  },
  "inconstitucionalidades_planteadas": [],
  "resultado_propuesto": "favorable"
}`

  const text = await callClaude(apiKey, extractSystem, [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      { type: 'text', text: extractPrompt }
    ]
  }])

  try {
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { raw: text, _parseError: true }
  }
}

// ── Sentence generation (5 section calls) ─────────────────────────────────────
export async function generateSentenceSection(apiKey, sectionName, prompt, expedienteData, config) {
  const contextJson = JSON.stringify({ expediente: expedienteData, config }, null, 2)
  return await callClaude(apiKey, TEMPLATE_CONTEXT, [{
    role: 'user',
    content: `DATOS DEL EXPEDIENTE Y CONFIGURACIÓN:\n${contextJson.slice(0, 6000)}\n\n${prompt}`
  }])
}

// ── Prompts for each section ──────────────────────────────────────────────────
export function getPrompts(data, config) {
  const { primer_voto_1, primer_voto_2, ripte_actual, ripte_fecha, honorarios } = config
  const actorGen = /a$/i.test(data.actor?.nombre?.split(' ')[0] || '')
  const elLa = actorGen ? 'la actora' : 'el actor'
  const suPronoun = actorGen ? 'su' : 'su'

  return {
    antecedentes: `Redactá ÚNICAMENTE la sección "Antecedentes:" de la Primera Cuestión.

NIVEL DE DETALLE OBLIGATORIO (igual al modelo real del Tribunal):
- Fecha exacta de presentación de la demanda
- Nombre completo del letrado actor con matrícula y calidad (apoderado/patrocinante)
- Relato completo del accidente: fecha, hora si está, lugar, tareas que realizaba, mecánica DETALLADA del siniestro, diagnóstico inicial, prestadores, intervenciones quirúrgicas con fechas, alta médica
- Incapacidades reclamadas (física X%, psíquica X% si hay) en contraste con el % de la CM
- Todos los planteos de inconstitucionalidad articulados
- Fecha de presentación de la contestación, nombre del letrado demandada con matrícula
- Postura de la demandada: negativas pormenorizadas, impugnaciones, excepciones (prescripción si hay), su versión de los hechos si difiere
- Auto de apertura a prueba (fecha)
- Todas las informativas con fechas (SRT, AFIP primera y segunda si hay)
- Fecha del dictamen pericial médico (y psiquiátrico si hay)
- Fechas de todas las impugnaciones y respuestas del perito
- Fechas de alegatos de ambas partes
- Fecha del pase al Acuerdo
- Cualquier otro acto relevante

Comenzá directamente con "Antecedentes:" y terminá justo antes de "Resolución:". 
NO incluyas encabezados ni texto antes de "Antecedentes:".`,

    resolucion: `Redactá ÚNICAMENTE la sección "Resolución:" de la Primera Cuestión.

ESTRUCTURA OBLIGATORIA con nivel de detalle MÁXIMO:

1. HECHOS INCUESTIONADOS (2-3 párrafos):
"Teniendo en cuenta que la parte actora persigue la indemnización por incapacidad laboral... corresponde abocarse a definir si corresponde o no dicho reclamo."
"Teniendo en cuenta los términos de la demanda y de la contestación, llega incuestionado que ${elLa} sufrió [accidente/enfermedad] el [fecha]; que la accionada brindó las correspondientes prestaciones hasta el alta médica del [fecha] y que llevó a cabo el procedimiento administrativo ante la C.M. (expte. SRT N° [número]), en el que se determinó que ${elLa} padecía un [X]% de incapacidad. En virtud de la disconformidad con lo allí resuelto se presenta ${elLa} ante los estrados judiciales. Las partes discrepan en cuanto al porcentaje de incapacidad..."

2. PERICIA MÉDICA DETALLADA:
"Al efecto y a fin de discernir la cuestión controvertida, este órgano jurisdiccional cuenta con la pericia médica presentada en fecha [fecha] por el Dr./Dra. [perito], quien luego de brindar los antecedentes de interés médico legal, practicó el examen médico pericial:"

Para CADA región afectada, describir en detalle:
- Presencia/ausencia de deformaciones articulares visibles
- Arcos de movimiento con grados exactos (ej: "flexión de 0° a 110°, extensión de 0° a 30°")
- Signos clínicos específicos (Tinel positivo/negativo, Phalen positivo/negativo, bostezo, cajón, Lassègue, etc.)
- Estado muscular (tono, fuerza, hipotrofia si hay, con localización)
- Material de osteosíntesis si corresponde
- Exámenes complementarios (resonancias, radiografías) con fechas y hallazgos relevantes

Si hay pericia psiquiátrica:
- Escalas aplicadas con resultados (Beck: X/63, Hamilton: X/52, TEPT: X/80, Rosenberg: X/40)
- Descripción clínica del cuadro
- Diagnóstico con encuadre en DSM/CIE

Porcentajes determinados (física, psíquica, factores de ponderación con detalle, total).

3. ANÁLISIS DE IMPUGNACIONES:
Si la demandada impugnó la pericia: mencioná los fundamentos de la impugnación y la respuesta del perito.

4. CONCLUSIÓN:
"No hallando razones que ameriten apartarme de lo dictaminado por el perito médico, considerando al efecto las objeciones formuladas por la parte demandada en fecha [fecha] y las explicaciones brindadas por el galeno, tengo por probado que ${elLa} es portador/a de una incapacidad psicofísica parcial y permanente del [X]% de la T.O. por el accidente por el que aquí se acciona."

Comenzá directamente con "Resolución:" y terminá antes del IBM.`,

    ibm: `Redactá la sección del IBM y el cierre de la Primera Cuestión.

ESTRUCTURA OBLIGATORIA:

1. PÁRRAFO INTRODUCTORIO IBM:
"A fin de determinar el ingreso base mensual, tendré en consideración el promedio mensual de todos los salarios devengados —de conformidad con lo establecido por el artículo 1° del Convenio N° 95 de la OIT— por el trabajador durante el año anterior al accidente, según las remuneraciones informadas por AFIP (prueba informativa recibida el [fecha]), actualizados mes a mes aplicándose la variación del índice RIPTE (Remuneraciones Imponibles Promedio de los Trabajadores Estables):"

2. TABLA AFIP/RIPTE (si tenés los datos en el expediente):
Para cada uno de los 12 meses: período, salario AFIP original, RIPTE del período, salario actualizado
Si no tenés los datos exactos: describí el método y usá [COMPLETAR CON DATOS AFIP]

3. RESULTADOS:
- Total salarios actualizados por RIPTE
- RIPTE a la fecha de la contingencia: [valor]
- Valor Ingreso Base (VIB/IBM) art. 12 LRT: $ [IBM base]
- IBM con intereses (tasa activa BNA desde fecha accidente hasta fecha dictamen): $ [IBM con intereses]

4. EDAD:
"Teniendo en cuenta la fecha de nacimiento del actor/la actora —[fecha]—, y la del accidente sufrido —[fecha]—, tengo por acreditado que contaba con [X] años de edad a la fecha del siniestro."

5. CIERRE PRIMERA CUESTIÓN:
"Así lo voto (art. 57 inc. 4) ley 15.057)."
"A la misma cuestión planteada los Señores Jueces/la Señora Jueza Doctora/el Señor Juez Doctor ${config.juez2} y ${config.juez3}, por compartir fundamentos, adhieren al voto que antecede."

6. VOTO WEISS (siempre, aunque vote en otra posición):
"A LA PRIMERA CUESTIÓN PLANTEADA LA SEÑORA JUEZA DOCTORA ${config.weissName?.toUpperCase() || 'WEISS'} DIJO:
Sin perjuicio de compartir la solución adoptada en cuanto a la procedencia de la actualización del ingreso base mensual conforme al índice RIPTE, discrepo con el fundamento en que se sustenta. Mientras el voto mayoritario —siguiendo el criterio del Tribunal del Trabajo N.º 5— basa su decisión en la declaración de inconstitucionalidad del inciso 2 del artículo 12 de la Ley de Riesgos del Trabajo, considero, conforme a la postura que mantengo en el Tribunal del Trabajo N.º 4 que integro, que tanto la procedencia de la actualización como la invalidez de la norma citada derivan de la inconstitucionalidad sobreviniente del artículo 7 de la ley 23.928, conforme lo dispuesto por la ley 25.561, cuya tacha fue oportunamente articulada por la parte actora.
Así lo voto."

NO incluyas la Segunda Cuestión.`,

    segunda: `Redactá la SEGUNDA CUESTIÓN completa.

Empezá con:
"SEGUNDA CUESTIÓN: ¿Qué pronunciamiento corresponde dictar?

A LA SEGUNDA CUESTIÓN PLANTEADA ${config.primer_voto_2_nombre_completo} DIJO:"

ESTRUCTURA CON MÁXIMO DETALLE:

1. SÍNTESIS (2 párrafos): 
- Lo probado (incapacidad %, IBM base)
- IBM actualizado con RIPTE y adición de intereses: $ [IBM art.12]

2. RAZONAMIENTO CONSTITUCIONAL COMPLETO (8-10 párrafos extensos):
a) Art. 11 ley 27.348 y su finalidad
b) DNU 669/19: "aunque inconstitucional por falta de los presupuestos de necesidad y urgencia, según lo resuelto por la Suprema Corte de Justicia de la Provincia de Buenos Aires en el precedente 'Muzychuk'..."
c) Los vaivenes normativos y la ausencia de criterio sostenido
d) Fallo Barrios SCBA: CITAR TEXTUALMENTE: "el alza generalizada de los precios y la depreciación monetaria, agravados en los últimos tiempos y fuertemente en el último bienio, parece una constante"
e) SCBA: "Monchiero" L.120.521, "Amaya" L.120.648
f) CSJN: "Aquino", "Milone", "Ascua", "Vizzoti" - tutela preferente del trabajador
g) Incompatibilidad inc. 2 art. 12 LRT con arts. 14 bis y 17 CN
h) Conclusión: declarar inconstitucionalidad del inc. 2 art. 12 LRT

3. COMPARATIVA IBM (párrafo central del argumento):
"Adviértase que la fórmula indemnizatoria utilizando la tasa de interés devengada entre la fecha del infortunio ([fecha accidente]) hasta la actualidad calculada según el promedio de la tasa activa cartera general nominal anual vencida a treinta (30) días del Banco de la Nación Argentina arroja un IBM de $ [IBM TASA ACTIVA - completar con planilla BNA oficial] y una indemnización de $ [INDEMNIZACIÓN A]; mientras que si se aplicara en igual período el índice RIPTE, el IBM se elevaría a $ [IBM RIPTE] y la indemnización alcanzaría el importe de $ [INDEMNIZACIÓN B] (según el siguiente detalle: último RIPTE publicado ${ripte_fecha}: $ ${ripte_actual} / RIPTE [mes accidente]: $ [RIPTE ACCIDENTE]; coeficiente: ${ripte_actual} / [RIPTE ACC] = [COEF]; IBM base $ [IBM BASE] × [COEF] = $ [IBM RIPTE]; 53 × $ [IBM RIPTE] × 65 ./. [edad] × [%]%)."

4. CÁLCULO FINAL:
"Por ello y teniendo en cuenta los hechos probados en el Veredicto, de acuerdo con lo previsto por los arts. 6 y 14.2 de la ley 24.557, corresponde —teniendo en cuenta la edad del trabajador/la trabajadora a la fecha del accidente ([X] años), la minusvalía de su capacidad laborativa ([X]%)— la indemnización que le corresponde arroja la suma de $ [MONTO] (53 × $ [IBM RIPTE] × 65 ./. [edad] × [%]%)."

"Corresponde adicionar a la suma liquidada de $ [MONTO] el 20% previsto en el art. 3 ley 26.773 de $ [20%]."

"El monto total al que asciende la indemnización... asciende a la suma de pesos [EN LETRAS] ([MONTO] + [20%] = [TOTAL])."

5. INTERESES:
"Este Tribunal de Trabajo Nº 5, al aplicar la actualización por RIPTE en virtud de la declaración de inconstitucionalidad del inc. 2 del art. 12 LRT, considera inapropiado fijar además una tasa de interés pura adicional sobre el IBM, dado que ello generaría un incremento excesivo del crédito ya actualizado, superando una compensación razonablemente justa."
"A partir de la mora en el pago... art. 770 CCC... tasa activa BNA 30 días... hasta la efectiva cancelación."

6. ABSTRACTO INCONSTITUCIONALIDADES

7. COSTAS: "...a cargo de [demandada] en su condición de vencida (art. 24 ley 15.057)."

8. "Así lo voto (art. 57 inc. 4) ley 15.057)."
   Adhesión del segundo juez
   Adhesión de Weiss con su salvedad`,

    sentencia: `Redactá la SENTENCIA DISPOSITIVO completa.

Empezá con:
"Con lo que terminó el Acuerdo firmando los Señores Jueces por ante mí que doy fe.

\\t\\t\\t\\tS  E  N  T  E  N  C  I  A

AUTOS Y VISTO: CONSIDERANDO: Lo resuelto en el Acuerdo que antecede y conforme los fundamentos allí vertidos, el Tribunal del Trabajo N° 5, por mayoría RESUELVE:"

INCISOS EN ORDEN EXACTO:
1°) Declarar la inconstitucionalidad del DNU 669/19 (art. 99 inc. 3° CN) y la inconstitucionalidad sobrevenida e inaplicabilidad al caso del inciso segundo del art. 12 ley 24.557 (por violentar arts. 14 bis, 17 y 33 CN).

2°) Hacer lugar a la demanda. Monto: LETRAS ($ NÚMERO). Plazo: 10 días de quedar firme. Nombre del actor. Nombre de la demandada. Artículos: 6.1, 8.1 y 14.2.a ley 24.557, art. 12 ley 27.348, art. 3 ley 26.773. Incapacidad X% T.O. Arts. 345 CPCC y 89 ley 15.057.

3°) INSTRUCCIONES CBU (texto íntegro):
"En atención a lo dispuesto por el art. 17 de la ley 27.348; el monto de condena, se abonará por la demandada obligada al pago, en forma directa en la cuenta bancaria sueldo –ley 26.590– del trabajador (actor). A tal fin, se debe adjuntar constancia de CBU del acreedor judicial e informar sus datos en el expediente: nombre y apellido completo, CBU, CUIT, DNI, número y tipo de cuenta, banco, sucursal y localidad, correo electrónico, en el cuerpo del escrito que presenten.
Si el trabajador no contara con cuenta sueldo a su exclusiva titularidad –ley 26.590–, bajo juramento de decir verdad que no cuenta con la misma, podrá denunciar cualquier otra cuenta bancaria de la que sea único y exclusivo titular, no admitiéndose cuentas que contaren con otros titulares o, en su defecto, abrir a su exclusiva titularidad una cuenta gratuita en el Banco de la Provincia de Buenos Aires. (Cuenta DNI).
Una vez que se cumpla lo indicado en el párrafo anterior, comenzará a correr el plazo impuesto en la sentencia para que el obligado realice el pago.
La parte obligada al pago deberá acreditar en autos el debido cumplimiento de las obligaciones dinerarias impuestas dentro del mismo plazo que se dispone para que las abone."

4°) Intereses: art. 770 CCC, acumulación al capital, tasa activa BNA 30 días hasta cancelación efectiva.

5°) Costas a cargo de la demandada (art. 24 ley 15.057).

6°) Honorarios letrado actor: ${honorarios.actorNombre || '[LETRADO ACTOR]'} en la suma de $ ${honorarios.actor || '[A COMPLETAR]'} (IUS según ac. 4200/25); letrado demandada: ${honorarios.demNombre || '[LETRADO DEMANDADA]'} en la suma de $ ${honorarios.dem || '[A COMPLETAR]'}; aportes previsionales 10% e IVA en caso de corresponder (arts. 2, 10, 13, 15, 16, 21, 23, 28, 29, 43, 51 y 54 ley 14.967).
Honorarios perito médico Dr./Dra. [PERITO]: $ ${honorarios.perito || '[A COMPLETAR]'} + aportes ley 6.742 y decreto 1.845/64 + IVA.
${honorarios.peritoPs ? `Honorarios perito psiquiatra/psicólogo Dr./Dra. [PERITO PSI]: $ ${honorarios.peritoPs} + aportes + IVA.` : ''}

7°) Instrucciones pago honorarios:
"Los honorarios se abonarán directamente en las cuentas bancarias de los profesionales (abogados y peritos), quienes deben adjuntar constancia de CBU y factura correspondiente e informar sus datos en el expediente: nombre y apellido completo, CBU, CUIT, DNI, número y tipo de cuenta, banco, sucursal y localidad, correo electrónico, en el cuerpo del escrito que presenten; conforme a las pautas que se especifican en: http://blogs.scba.gov.ar/tribunaltrabajo5quilmes/2020/08/12/solicitud-de-tranferencias/ (art. 12 ley 15.057).
Una vez que se cumpla lo indicado en el párrafo anterior, comenzará a correr el plazo para que el obligado realice el pago.
Asimismo, se hace saber que deberán acompañar los comprobantes de pago de aportes."

REGISTRESE, NOTIFIQUESE, con transcripción de lo dispuesto en el art. 54 Ley 14.967 y oportunamente ARCHIVESE.

"ARTÍCULO 54.- Las providencias que regulen honorarios deberán ser notificadas personalmente, por cédula a sus beneficiarios, al mandante o patrocinado y al condenado en costas, si lo hubiere. Asimismo, será válida la notificación de la regulación de honorarios efectuada por cualquier otro medio fehaciente, a costa del interesado. Los honorarios a cargo del mandante o patrocinado quedarán firmes a su respecto si la notificación se hubiere practicado en su domicilio real y a la contraparte en su domicilio constituido. Habiendo cesado el patrocinio o apoderamiento y constituido el ex cliente nuevo domicilio, la notificación de honorarios a éste podrá ser efectuada en este último domicilio. En todos los casos, bajo pena de nulidad, en el instrumento de notificación que se utilice para ello, deberá transcribirse este artículo. Los honorarios regulados por trabajos judiciales deberán abonarse dentro de los diez (10) días de haber quedado firme el auto regulatorio. Los honorarios por trabajos extrajudiciales se abonarán dentro de los diez (10) días de intimado su pago, cuando sean exigibles. Operada la mora, el profesional podrá optar por: a) reclamar los honorarios expresados en la unidad arancelaria Jus prevista en esta ley, con más un interés del 12% anual. b) reclamar los honorarios regulados convertidos al momento de la mora en moneda de curso legal, con más el interés previsto en el artículo 552 del Código Civil y Comercial de la Nación."`
  }
}
