// api/generate.js
// =============================================================================
// SENTENCIA - API endpoint para generación de proyecto de sentencia
// Tribunal del Trabajo N° 5 de Quilmes
// Versión 2.1 - Mayo 2026
//
// CAMBIOS RESPECTO A v2.0:
//   - Eliminada la estimación lineal de intereses BNA (calcInteresesBNA).
//     Ahora se recibe `intereseseBNA` como input del body (campo manual del
//     usuario, alimentado por su cálculo o por el endpoint /api/tasa-bna).
//   - Agregada conversión robusta número→letras vía src/lib/numeroALetras.js.
//   - El monto total se calcula en JS y se pasa a Claude con su forma textual
//     ya resuelta, evitando errores de conversión por parte del LLM.
// =============================================================================

import {
  PROMPT_EXTRACT,
  PROMPT_ANTECEDENTES,
  PROMPT_RESOLUCION,
  PROMPT_SEGUNDA_CUESTION,
  PROMPT_SENTENCIA,
} from '../src/lib/sentenciaPrompts.js';

import { numeroALetras, fmtMontoAR } from '../src/lib/numeroALetras.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

// =============================================================================
// HELPERS
// =============================================================================

function calcIndemnizacion(ibm, edad, porcentaje) {
  return 53 * ibm * 65 / edad * (porcentaje / 100);
}

async function callClaude(systemPrompt, userMessage, maxTokens = 4000) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

function parseJSON(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// =============================================================================
// HANDLER PRINCIPAL
// =============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { chunks, config } = req.body;

    if (!chunks?.header) {
      return res.status(400).json({ error: 'Missing required chunks (header)' });
    }

    // --------------------------------------------------------------------
    // INPUTS DEL FRONTEND (config):
    // --------------------------------------------------------------------
    //  ordenVotacion         — "ZACARIAS-STOLARCZYK-WEISS" o similar
    //  primerMagistrado      — "ZACARIAS" | "STOLARCZYK"
    //  segundoMagistrado     — "STOLARCZYK" | "ZACARIAS"
    //  ripteActual           — número (último publicado)
    //  ripteAccidente        — número (RIPTE del mes del accidente)
    //  intereseseBNA         — número (tasa activa BNA acumulada hasta hoy)
    //  ibmBruto              — número (opcional, override)
    //  edadActor             — número (opcional, override)
    //  porcentajeIncapacidad — número (opcional, override)
    //  honorarios            — { letradoActor, letradoDemandada, peritos }
    // --------------------------------------------------------------------

    // ====================================================================
    // PASO 1: Extraer datos básicos del expediente (JSON)
    // ====================================================================
    console.log('[1/5] Extrayendo datos básicos...');
    const extractResponse = await callClaude(
      PROMPT_EXTRACT,
      `# EXPEDIENTE - SECCIONES RELEVANTES

## HEADER (presentación, demanda, contestación)

${chunks.header}

## ALEGATOS (si los hay)

${chunks.alegatos || '(no disponible)'}`,
      3000,
    );
    const datos = parseJSON(extractResponse);

    // ====================================================================
    // PASO 2: Pre-cálculos numéricos
    // ====================================================================
    const ripteActual = config.ripteActual;
    const ripteAccidente = config.ripteAccidente;
    const coefRipte = ripteAccidente ? ripteActual / ripteAccidente : null;

    const ibmBruto = config.ibmBruto || datos.ibm_bruto || null;
    const edad = config.edadActor || datos.edad_accidente || null;
    const porcentaje = config.porcentajeIncapacidad
      || datos.incapacidad_total_porcentaje
      || datos.incapacidad_pericia_porcentaje
      || null;
    const tipoEvento = (datos.tipo_evento || datos.tipo_accion || 'ACCIDENTE').toUpperCase();
    const intereseseBNA = config.intereseseBNA;

    let calculos = null;

    if (ibmBruto && edad && porcentaje && coefRipte && intereseseBNA != null) {
      // Hipótesis (a) — tasa activa BNA
      const ibmConIntereses = ibmBruto + intereseseBNA;
      const hipotesisA_sin20 = calcIndemnizacion(ibmConIntereses, edad, porcentaje);

      // Hipótesis (b) — RIPTE
      const ibmRIPTE = ibmBruto * coefRipte;
      const hipotesisB_sin20 = calcIndemnizacion(ibmRIPTE, edad, porcentaje);

      const esAccidente = !tipoEvento.includes('ENFERMEDAD');
      const adicional20 = esAccidente ? hipotesisB_sin20 * 0.20 : 0;
      const total = hipotesisB_sin20 + adicional20;
      const totalEnLetras = numeroALetras(total, { conPesos: true });

      calculos = {
        ibmBruto: round2(ibmBruto),
        intereseseBNA: round2(intereseseBNA),
        ibmConIntereses: round2(ibmConIntereses),
        hipotesisA: round2(hipotesisA_sin20),
        coefRipte: parseFloat(coefRipte.toFixed(3)),
        ripteActual,
        ripteAccidente,
        ibmRIPTE: round2(ibmRIPTE),
        hipotesisB: round2(hipotesisB_sin20),
        adicional20: round2(adicional20),
        total: round2(total),
        totalEnLetras,
        esAccidente,
        fmt: {
          ibmBruto: fmtMontoAR(ibmBruto),
          intereseseBNA: fmtMontoAR(intereseseBNA),
          ibmConIntereses: fmtMontoAR(ibmConIntereses),
          hipotesisA: fmtMontoAR(hipotesisA_sin20),
          ibmRIPTE: fmtMontoAR(ibmRIPTE),
          hipotesisB: fmtMontoAR(hipotesisB_sin20),
          adicional20: fmtMontoAR(adicional20),
          total: fmtMontoAR(total),
        },
      };
    }

    // Variante del voto de Weiss
    const variantWeiss = !calculos ? 3 : (datos.denuncia_inconst_ley_23928 ? 1 : 2);

    // ====================================================================
    // PASO 3: ANTECEDENTES
    // ====================================================================
    console.log('[2/5] Redactando Antecedentes...');
    const antecedentes = await callClaude(
      PROMPT_ANTECEDENTES,
      `# DATOS EXTRAÍDOS

${JSON.stringify(datos, null, 2)}

# CONFIGURACIÓN

- Orden de votación: ${config.ordenVotacion || 'ZACARIAS-STOLARCZYK-WEISS'}
- Magistrado que vota primero: ${config.primerMagistrado || 'ZACARIAS'}

# CHUNK DEL EXPEDIENTE (header)

${chunks.header}`,
      4000,
    );

    // ====================================================================
    // PASO 4: RESOLUCIÓN (primera cuestión)
    // ====================================================================
    console.log('[3/5] Redactando Resolución...');
    const resolucion = await callClaude(
      PROMPT_RESOLUCION,
      `# DATOS

${JSON.stringify(datos, null, 2)}

# CONFIGURACIÓN

- Primer magistrado: ${config.primerMagistrado || 'ZACARIAS'}
- Segundo magistrado: ${config.segundoMagistrado || 'STOLARCZYK'}
- IBM bruto AFIP: ${fmtMontoAR(ibmBruto)}
- Edad del actor: ${edad}
- % Incapacidad final: ${porcentaje}

# CHUNK DE LA PERICIA

${chunks.pericia || chunks.header}`,
      5000,
    );

    // ====================================================================
    // PASO 5: SEGUNDA CUESTIÓN
    // ====================================================================
    console.log('[4/5] Redactando Segunda Cuestión...');
    const segunda = await callClaude(
      PROMPT_SEGUNDA_CUESTION,
      `# DATOS COMPLETOS

${JSON.stringify({
  ...datos,
  calculos,
  variantWeiss,
  configVotacion: {
    primerMagistrado: config.primerMagistrado || 'ZACARIAS',
    segundoMagistrado: config.segundoMagistrado || 'STOLARCZYK',
  },
}, null, 2)}

# RECORDATORIOS

- variantWeiss = ${variantWeiss} → usar Variante ${variantWeiss} del voto de Weiss.
- Todos los cálculos están en 'calculos' (ya resueltos en JS). NO recalcules, solo usá los valores.
- Para el monto total en letras MAYÚSCULAS usá literalmente: "${calculos?.totalEnLetras || ''}".
- Usá los valores formateados de 'calculos.fmt' para insertar en el texto.
- Si calculos.esAccidente = true → agregar +20% art. 3 ley 26.773.
- Coeficiente RIPTE: ${calculos?.coefRipte || 'N/A'} (RIPTE actual ${calculos?.ripteActual} / RIPTE mes accidente ${calculos?.ripteAccidente}).

# CHUNK CON ALEGATOS

${chunks.alegatos || '(sin alegatos)'}`,
      6000,
    );

    // ====================================================================
    // PASO 6: SENTENCIA (dispositivo final)
    // ====================================================================
    console.log('[5/5] Redactando Sentencia (dispositivo)...');
    const sentencia = await callClaude(
      PROMPT_SENTENCIA,
      `# DATOS

${JSON.stringify(datos, null, 2)}

# CÁLCULOS

${JSON.stringify(calculos, null, 2)}

# HONORARIOS

${JSON.stringify(config.honorarios || {}, null, 2)}

# RECORDATORIOS

- ¿Hace lugar o rechaza? ${calculos ? 'HACE LUGAR' : 'RECHAZA'}
- Demandada: ${datos.demandada?.razon_social}
- Monto total: ${calculos ? calculos.fmt.total : 'N/A'}
- Monto total en letras: "${calculos?.totalEnLetras || 'N/A'}"
- Incluir bloque CBU completo si hace lugar.
- Incluir transcripción literal del art. 54 ley 14.967 al final.`,
      6000,
    );

    // ====================================================================
    // ARMAR SENTENCIA COMPLETA
    // ====================================================================
    const encabezado = `En la ciudad de Quilmes, se reúnen en la Sala de Acuerdos los Señores Jueces que para este acto integran el Tribunal del Trabajo N° 5 de esta ciudad, doctores Andrea Marcela Zacarías, Mario Daniel Stolarczyk y María Alejandra Weiss, a efectos de dictar Sentencia en la causa N° ${datos.causa_numero} caratulada "${datos.caratula}", conforme el siguiente orden de votación: ${config.ordenVotacion || 'ZACARÍAS – STOLARCZYK – WEISS'}.

El Tribunal resolvió plantear y votar las siguientes cuestiones:

PRIMERA CUESTIÓN: ¿Cuáles son los hechos que arriban firmes a esta instancia y cuáles los controvertidos?

SEGUNDA CUESTIÓN: ¿Qué pronunciamiento corresponde dictar?

`;

    const textoCompleto = encabezado + antecedentes + '\n\n' + resolucion + '\n\n' + segunda + '\n\n' + sentencia;

    return res.status(200).json({
      success: true,
      sentencia: textoCompleto,
      metadata: { datos, calculos, variantWeiss },
    });
  } catch (error) {
    console.error('Error en generate.js:', error);
    return res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}
