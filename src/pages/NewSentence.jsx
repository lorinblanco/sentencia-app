import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  extractAllText, buildChunks, extractBasicInfo, generateSection,
  extractExtraFileText, buildCalculos,
  tryParsePlanillaCALM, detectarTipoAccion, validarTextoSentencia,
} from '../lib/claude'
import {
  buildAdhesionPrimera, buildAdhesionSegunda, detectarVarianteWeiss,
  buildEncabezadoSentencia, buildCierreArt54
} from '../lib/sentenciaPrompts'
import { getRipteFechaAccidente } from '../lib/ripteHistorico'
import { saveSentence } from '../lib/supabase'
import { buildWordDocument } from '../lib/word'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const OPCIONES_VOTO = [
  {
    id: 'zacarias_primero',
    label: 'Zacarías → Stolarczyk → Weiss',
    juez1: { nombre: 'ZACARÍAS', nombreCompleto: 'LA SEÑORA JUEZA DOCTORA ANDREA MARCELA ZACARÍAS', corto: 'Dra. Zacarías', genero: 'f' },
    juez2: { nombre: 'STOLARCZYK', nombreCompleto: 'EL SEÑOR JUEZ DOCTOR MARIO DANIEL STOLARCZYK', corto: 'Dr. Stolarczyk', genero: 'm' },
  },
  {
    id: 'stolarczyk_primero',
    label: 'Stolarczyk → Zacarías → Weiss',
    juez1: { nombre: 'STOLARCZYK', nombreCompleto: 'EL SEÑOR JUEZ DOCTOR MARIO DANIEL STOLARCZYK', corto: 'Dr. Stolarczyk', genero: 'm' },
    juez2: { nombre: 'ZACARÍAS', nombreCompleto: 'LA SEÑORA JUEZA DOCTORA ANDREA MARCELA ZACARÍAS', corto: 'Dra. Zacarías', genero: 'f' },
  },
]

const WEISS = {
  nombre: 'WEISS',
  nombreCompleto: 'LA SEÑORA JUEZA DOCTORA MARÍA ALEJANDRA WEISS',
  corto: 'Dra. Weiss',
  nombreCivil: 'María Alejandra Weiss',
}

const STEPS = [
  { id: 'upload', label: 'Archivos', icon: '📂' },
  { id: 'config', label: 'Configuración', icon: '⚙️' },
  { id: 'generate', label: 'Generación', icon: '✍️' },
  { id: 'result', label: 'Resultado', icon: '📄' },
]

const GEN_STEPS = [
  'Leyendo el PDF del expediente...',
  'Procesando archivos adicionales...',
  'Detectando planilla CALM...',
  'Extrayendo datos básicos del expediente...',
  'Redactando antecedentes y hechos...',
  'Redactando resolución y pericia médica...',
  'Redactando IBM y cierre Primera Cuestión...',
  'Redactando Segunda Cuestión completa...',
  'Redactando Sentencia dispositivo...',
  'Generando archivo Word...',
]

function getTipoArchivo(f) {
  const name = f.name.toLowerCase()
  if (name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm')) return 'excel'
  return 'otro'
}

function normalizarFecha(s) {
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const MESES = {
    enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
    julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
  }
  const m2 = s.toLowerCase().match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/)
  if (m2 && MESES[m2[2]]) return `${m2[3]}-${MESES[m2[2]]}-${m2[1].padStart(2, '0')}`
  return ''
}

function ChipAuto({ tipo = 'auto' }) {
  const colores = {
    auto: 'bg-blue-100 text-blue-700',
    planilla: 'bg-emerald-100 text-emerald-700',
  }
  const etiquetas = {
    auto: 'auto',
    planilla: 'planilla CALM',
  }
  return (
    <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-medium align-middle ${colores[tipo]}`}>
      {etiquetas[tipo]}
    </span>
  )
}

export default function NewSentence({ profile, session }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  const [files, setFiles] = useState([])
  const [drag, setDrag] = useState(false)
  const fileRef = useRef()

  const [opcionVoto, setOpcionVoto] = useState(0)
  const [ripteManual, setRipteManual] = useState('')
  const [ripteAuto, setRipteAuto] = useState({ valor: '', fecha: '', loading: false })

  const [calcInputs, setCalcInputs] = useState({
    fechaAccidente: '',
    ripteAccidente: '',
    intereseseBNA: '',
    ibmBruto: '',
    edadActor: '',
    porcentajeIncapacidad: '',
  })

  const [honorarios, setHonorarios] = useState({
    actorNombre: '', actor: '', demNombre: '', dem: '',
    perito: '', peritoPs: '', tienePeritoPsi: false
  })

  const [genStep, setGenStep] = useState(-1)
  const [genProgress, setGenProgress] = useState(0)
  const [genSubProgress, setGenSubProgress] = useState(0)
  const [genError, setGenError] = useState('')
  const [extractedData, setExtractedData] = useState(null)
  const [validationFindings, setValidationFindings] = useState([])
  const [sentenceText, setSentenceText] = useState('')
  const [savedId, setSavedId] = useState(null)

  const [prefetching, setPrefetching] = useState(false)
  const [prefetchDone, setPrefetchDone] = useState(false)
  const [prefetchError, setPrefetchError] = useState('')
  const [prefilledFields, setPrefilledFields] = useState({})
  const [cachedChunks, setCachedChunks] = useState(null)

  // === NUEVO v2.4: planilla CALM ===
  const [calmParsed, setCalmParsed] = useState(null)
  const [calmFileName, setCalmFileName] = useState('')
  const [calmDetecting, setCalmDetecting] = useState(false)

  // Detectar planilla CALM al agregar archivos extras (.xlsx/.xlsm)
  useEffect(() => {
    const archivosExtra = files.filter(f => f.tipo !== 'pdf' || f.id !== files.find(g => g.tipo === 'pdf')?.id)
      .filter(f => f.tipo === 'excel')
    if (archivosExtra.length === 0) {
      setCalmParsed(null)
      setCalmFileName('')
      return
    }
    // Solo procesamos el primer Excel encontrado (asumimos uno solo)
    const primerExcel = archivosExtra[0]
    if (calmFileName === primerExcel.file.name) return // ya procesado

    setCalmDetecting(true)
    tryParsePlanillaCALM(primerExcel.file)
      .then(parsed => {
        if (parsed) {
          setCalmParsed(parsed)
          setCalmFileName(primerExcel.file.name)
          console.log('📊 Planilla CALM detectada:', parsed)
          // Autocompletar campos del form con los valores de la planilla
          if (parsed.meta?.fechaAccidente) {
            const iso = parsed.meta.fechaAccidente.toISOString().slice(0, 10)
            setCalcInputs(p => ({ ...p, fechaAccidente: iso }))
            setPrefilledFields(p => ({ ...p, fechaAccidente: true }))
          }
          if (parsed.meta?.ripteAccidente) {
            setCalcInputs(p => ({ ...p, ripteAccidente: parsed.meta.ripteAccidente.toLocaleString('es-AR', { minimumFractionDigits: 2 }) }))
            setPrefilledFields(p => ({ ...p, ripteAccidente: true }))
          }
          if (parsed.meta?.edad) {
            setCalcInputs(p => ({ ...p, edadActor: String(parsed.meta.edad) }))
            setPrefilledFields(p => ({ ...p, edadActor: true }))
          }
          if (parsed.meta?.porcentajeIncapacidadPct) {
            setCalcInputs(p => ({ ...p, porcentajeIncapacidad: String(parsed.meta.porcentajeIncapacidadPct).replace('.', ',') }))
            setPrefilledFields(p => ({ ...p, porcentajeIncapacidad: true }))
          }
          if (parsed.calculos?.ibmRipteIndividual) {
            const ibm = parsed.calculos.ibmRipteIndividual.toLocaleString('es-AR', { minimumFractionDigits: 2 })
            setCalcInputs(p => ({ ...p, ibmBruto: ibm }))
            setPrefilledFields(p => ({ ...p, ibmBruto: true }))
          }
          if (parsed.calculos?.bna?.ibm && parsed.calculos?.ibmRipteIndividual) {
            const intereses = parsed.calculos.bna.ibm - parsed.calculos.ibmRipteIndividual
            setCalcInputs(p => ({ ...p, intereseseBNA: intereses.toLocaleString('es-AR', { minimumFractionDigits: 2 }) }))
            setPrefilledFields(p => ({ ...p, intereseseBNA: true }))
          }
        } else {
          setCalmParsed(null)
          setCalmFileName('')
        }
      })
      .catch(e => {
        console.warn('Error parseando planilla CALM:', e)
        setCalmParsed(null)
        setCalmFileName('')
      })
      .finally(() => setCalmDetecting(false))
  }, [files])

  // Auto-fetch RIPTE actual al entrar al paso 2
  useEffect(() => {
    if (step === 1 && !ripteAuto.valor) {
      setRipteAuto(p => ({ ...p, loading: true }))
      fetch('/api/ripte')
        .then(r => r.json())
        .then(d => {
          if (d.ok && d.ripte) setRipteAuto({ valor: d.ripte, fecha: d.fecha || '', loading: false })
          else setRipteAuto({ valor: '', fecha: '', loading: false })
        })
        .catch(() => setRipteAuto({ valor: '', fecha: '', loading: false }))
    }
  }, [step])

  // RIPTE histórico al cambiar fechaAccidente (si no vino de planilla)
  useEffect(() => {
    const fecha = calcInputs.fechaAccidente
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return
    if (calcInputs.ripteAccidente && !prefilledFields.ripteAccidente) return
    if (calmParsed) return // si hay planilla CALM, ella manda
    const valor = getRipteFechaAccidente(fecha)
    if (valor) {
      setCalcInputs(p => ({ ...p, ripteAccidente: valor }))
      setPrefilledFields(p => ({ ...p, ripteAccidente: true }))
    }
  }, [calcInputs.fechaAccidente])

  function addFiles(newFiles) {
    const added = newFiles.map(f => ({
      file: f, tipo: getTipoArchivo(f), id: Math.random().toString(36).slice(2)
    }))
    setFiles(prev => [...prev, ...added])
  }

  function removeFile(id) {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  function getExpedientePDF() { return files.find(f => f.tipo === 'pdf') }

  function getArchivosExtra() {
    const exp = getExpedientePDF()
    return files.filter(f => f.id !== exp?.id)
  }

  async function prefetchFromPDF() {
    if (prefetchDone || prefetching) return
    const apiKey = profile.anthropic_api_key
    if (!apiKey) return
    const expedientePDF = getExpedientePDF()
    if (!expedientePDF) return

    setPrefetching(true)
    setPrefetchError('')
    try {
      const { fullText } = await extractAllText(expedientePDF.file)
      const chunks = buildChunks(fullText, [])
      chunks.fullText = fullText  // ← el extractor lee el expediente completo, no solo header
      setCachedChunks(chunks)

      const data = await extractBasicInfo(apiKey, chunks)
      if (data._parseError) throw new Error('La IA no devolvió un JSON válido')

      setExtractedData(data)

      const prefilled = { ...prefilledFields }
      const updates = {}

      // Solo precargamos del PDF lo que la planilla CALM NO precargó
      if (!calmParsed) {
        if (data.accidente?.fecha) {
          const f = normalizarFecha(data.accidente.fecha)
          if (f) { updates.fechaAccidente = f; prefilled.fechaAccidente = true }
        }
        if (data.actor?.edad_al_accidente) {
          updates.edadActor = String(data.actor.edad_al_accidente)
          prefilled.edadActor = true
        }
        const pctPericia = data.incapacidad_acreditada_pericia?.total_porcentaje
        if (pctPericia != null) {
          updates.porcentajeIncapacidad = String(pctPericia).replace('.', ',')
          prefilled.porcentajeIncapacidad = true
        }
        if (data.ibm_bruto_afip) {
          updates.ibmBruto = String(data.ibm_bruto_afip).replace('.', ',')
          prefilled.ibmBruto = true
        }
      }

      setCalcInputs(prev => ({ ...prev, ...updates }))
      setPrefilledFields(prefilled)
      setPrefetchDone(true)
    } catch (e) {
      console.error('Prefetch error:', e)
      setPrefetchError(e.message || 'Error precargando datos del PDF')
    } finally {
      setPrefetching(false)
    }
  }

  async function abrirCalculadorCABA() {
    if (!calcInputs.fechaAccidente || !calcInputs.ibmBruto) {
      alert('Antes de calcular intereses BNA, completá:\n- Fecha del accidente\n- IBM bruto AFIP')
      return
    }
    try {
      const r = await fetch('/api/tasa-bna', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capital: parseFloat(calcInputs.ibmBruto.toString().replace(/[$.\s]/g, '').replace(',', '.')),
          fechaDesde: calcInputs.fechaAccidente,
          fechaHasta: new Date().toISOString().slice(0, 10),
        }),
      })
      const data = await r.json()
      if (data.calculadorUrl) {
        window.open(data.calculadorUrl, '_blank')
        alert(data.instrucciones || 'Calculá los intereses en la página del Consejo de la Magistratura y pegá el valor abajo.')
      }
    } catch (e) {
      alert('No se pudo abrir el calculador automáticamente. Ingresá los intereses BNA manualmente.')
    }
  }

  async function generate() {
    setStep(2); setGenError(''); setGenStep(0); setGenProgress(2); setGenSubProgress(0)
    const apiKey = profile.anthropic_api_key
    if (!apiKey) { setGenError('Configure su API key en Configuración.'); return }

    const ripte = ripteManual || ripteAuto.valor || '202.963,20'
    const ripteF = ripteAuto.fecha || 'Último publicado'
    const voto = OPCIONES_VOTO[opcionVoto]

    const config = {
      juez1: voto.juez1,
      juez2: voto.juez2,
      weiss: WEISS,
      orden: `${voto.juez1.corto} – ${voto.juez2.corto} – ${WEISS.corto}`,
      ripte_actual: ripte,
      ripte_fecha: ripteF,
      ripte_accidente: calcInputs.ripteAccidente,
      intereses_bna: calcInputs.intereseseBNA,
      ibm_bruto: calcInputs.ibmBruto,
      edad_actor: calcInputs.edadActor ? parseInt(calcInputs.edadActor) : null,
      porcentaje_incapacidad: calcInputs.porcentajeIncapacidad
        ? parseFloat(calcInputs.porcentajeIncapacidad.toString().replace(',', '.'))
        : null,
      fecha_accidente: calcInputs.fechaAccidente,
      honorarios,
    }

    const expedientePDF = getExpedientePDF()
    if (!expedientePDF) { setGenError('No hay PDF del expediente cargado.'); return }

    try {
      // === Procesamiento de chunks ===
      // Filtrar archivos extras: el Excel CALM se procesa aparte, no como texto
      const archivosExtra = getArchivosExtra().filter(f =>
        !(calmFileName && f.file.name === calmFileName)
      )
      let chunks

      if (cachedChunks && archivosExtra.length === 0) {
        chunks = cachedChunks
        setGenStep(0); setGenProgress(5)
        await new Promise(r => setTimeout(r, 150))
        setGenStep(1); setGenProgress(22)
      } else {
        setGenStep(0); setGenProgress(5)
        const { fullText } = await extractAllText(expedientePDF.file, (pct) => {
          setGenSubProgress(pct)
          setGenProgress(5 + Math.round(pct * 0.15))
        })
        setGenStep(1); setGenProgress(22)
        const extraTexts = []
        for (const f of archivosExtra) {
          try {
            const text = await extractExtraFileText(f.file)
            if (text) extraTexts.push(text)
          } catch (e) {
            console.warn('Error leyendo archivo extra:', f.file.name, e)
          }
        }
        chunks = buildChunks(fullText, extraTexts)
        chunks.fullText = fullText  // ← el extractor lee el expediente completo, no solo header
      }

      // === Detección de planilla CALM ===
      setGenStep(2); setGenProgress(28)
      await new Promise(r => setTimeout(r, 200))
      if (calmParsed) {
        console.log('📊 Usando planilla CALM como fuente de cálculos')
      } else {
        console.log('📊 No hay planilla CALM, usando cálculo manual')
      }

      // === Extract LLM ===
      setGenStep(3); setGenProgress(35)
      let data = (extractedData && !extractedData._parseError) ? extractedData : null
      if (!data) {
        data = await extractBasicInfo(apiKey, chunks)
        setExtractedData(data)
      }

            // === Detección de tipo de acción (3 valores) ===
      const tipoAccion = detectarTipoAccion(chunks, data)
      console.log(`🩺 Tipo detectado: ${tipoAccion}`)
 
      // Inyectar el tipo en data para que los prompts lo respeten
      data.tipoAccion = tipoAccion
      if (!data.tipo_accion_detectado) {
        data.tipo_accion_detectado =
          tipoAccion === 'ENFERMEDAD' ? 'Enfermedad profesional - Acción especial'
          : tipoAccion === 'REVISION_CM' ? 'Revisión resolución CM - Art. 2 inc. J ley 15.057'
          : 'Acción especial - Ley 24.557'
      }
 
      // === Construcción de cálculos (planilla CALM tiene prioridad) ===
      const calculos = buildCalculos(config, data, calmParsed, tipoAccion)
      console.log('Cálculos:', calculos)
      console.log('Variante Weiss:', detectarVarianteWeiss(calculos, data))
 
      const encabezado = buildEncabezado(data, config)
      let fullSentence = encabezado + '\n\n'
      fullSentence += 'El Tribunal resolvió plantear y votar las siguientes cuestiones:\n\n'
      fullSentence += `PRIMERA CUESTIÓN: ¿Cuáles son los hechos que arriban firmes a esta instancia y cuáles los controvertidos?\n\n`
      fullSentence += `A LA PRIMERA CUESTIÓN PLANTEADA ${voto.juez1.nombreCompleto} DIJO:\n\n`
      setSentenceText(fullSentence)
 
      // Callbacks: streaming (vista previa en vivo) y validación post-sección
      const allFindings = []
      const streamUpdate = (piece, soFar) => { setSentenceText(fullSentence + soFar) }
      const onValidation = ({ sectionType, findings }) => {
        if (findings.length > 0) {
          allFindings.push(...findings.map(f => ({ ...f, sectionType })))
        }
      }
 
      setGenStep(4); setGenProgress(45)
      const antecedentes = await generateSection(
        apiKey, 'antecedentes', chunks, data, config, calculos, streamUpdate, onValidation
      )
      fullSentence += antecedentes + '\n\n'
      setSentenceText(fullSentence)

      await sleep(15000)
      setGenStep(5); setGenProgress(60)
      const resolucion = await generateSection(
        apiKey, 'resolucion', chunks, data, config, calculos, streamUpdate, onValidation
      )
      fullSentence += resolucion + '\n\n'
      setSentenceText(fullSentence)

      await sleep(15000)
      setGenStep(6); setGenProgress(72)
      const ibm = await generateSection(
        apiKey, 'ibm', chunks, data, config, calculos, streamUpdate, onValidation
      )
      fullSentence += ibm + '\n\n'
      fullSentence += buildAdhesionPrimera(config) + '\n\n'
      fullSentence += `SEGUNDA CUESTIÓN: ¿Qué pronunciamiento corresponde dictar?\n\n`
      fullSentence += `A LA SEGUNDA CUESTIÓN PLANTEADA ${voto.juez1.nombreCompleto} DIJO:\n\n`
      setSentenceText(fullSentence)

      await sleep(15000)
      setGenStep(7); setGenProgress(85)
      const segunda = await generateSection(
        apiKey, 'segunda', chunks, data, config, calculos, streamUpdate, onValidation
      )
      fullSentence += segunda + '\n\n'
      fullSentence += buildAdhesionSegunda(config, calculos, data) + '\n\n'

      // Encabezado oficial "SENTENCIA / AUTOS Y VISTOS / RESUELVE" — texto fijo
      // del tribunal, no pasa por el LLM. La fórmula "por mayoría / por unanimidad"
      // se decide según cómo vota Weiss.
      const varianteWeiss = detectarVarianteWeiss(calculos, data)
      fullSentence += buildEncabezadoSentencia(varianteWeiss) + '\n\n'
      setSentenceText(fullSentence)

      await sleep(15000)
      setGenStep(8); setGenProgress(93)
      const dispositivo = await generateSection(
        apiKey, 'sentencia', chunks, data, config, calculos, streamUpdate, onValidation
      )
      fullSentence += dispositivo + '\n\n'
      fullSentence += buildCierreArt54() + '\n\n'
      setSentenceText(fullSentence) 
      // Guardar findings del validador para mostrarlos en la UI
      setValidationFindings(allFindings)
      setGenStep(9); setGenProgress(98)
      const meta = {
        causa_numero: data.causa_numero || '',
        caratula: data.caratula || '',
        tipo_accion: data.tipo_accion || data.tipo_accion_detectado || '',
      }
      const saved = await saveSentence(session.user.id, meta, fullSentence)
      setSavedId(saved.id)
      setGenProgress(100)
      setStep(3)

    } catch (e) {
      setGenError(e.message || 'Error generando la sentencia')
      console.error(e)
    }
  }

  function buildEncabezado(data, config) {
    const causa = data.causa_numero || '[N° CAUSA]'
    const caratula = data.caratula || '[CARÁTULA]'
    const { juez1, juez2, weiss } = config
    const j1Sin = juez1.corto.replace(/^Dr[ao]\.\s*/, '')
    const j2Sin = juez2.corto.replace(/^Dr[ao]\.\s*/, '')
    return `En la ciudad de Quilmes, se reúnen en la Sala de Acuerdos los Señores Jueces que, para este acto, integran el Tribunal del Trabajo N.º 5 de esta ciudad, ${j1Sin}, ${j2Sin} y ${weiss.nombreCivil}, a efectos de dictar Sentencia en la causa Nº ${causa} caratulada "${caratula}", conforme el siguiente orden de votación: ${juez1.nombre} – ${juez2.nombre} – ${weiss.nombre}.`
  }

  async function downloadWord() {
    if (!sentenceText) return
    await buildWordDocument(sentenceText, extractedData?.caratula, extractedData?.causa_numero)
  }

  const expedientePDF = getExpedientePDF()

  // Validación: con planilla CALM, los campos de cálculo son opcionales (los tomamos de la planilla)
  const camposCalculoOK = calmParsed
    ? calmParsed.esValida
    : (calcInputs.ripteAccidente && calcInputs.intereseseBNA && calcInputs.ibmBruto
       && calcInputs.edadActor && calcInputs.porcentajeIncapacidad)

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <button onClick={() => navigate('/')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <span>←</span> <span className="font-semibold">SentencIA</span>
          </button>
          <h1 className="text-sm font-medium text-slate-500">Nueva sentencia</h1>
          <div className="w-24"></div>
        </div>
      </header>

      <div className="bg-white border-b border-slate-100 px-6 py-3">
        <div className="max-w-4xl mx-auto flex items-center gap-0">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center flex-1">
              <div className={`flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg transition-all ${
                i === step ? 'bg-blue-900 text-white' :
                i < step ? 'text-green-700' : 'text-slate-400'
              }`}>
                <span>{i < step ? '✓' : s.icon}</span>
                <span className="hidden sm:block">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-px mx-2 ${i < step ? 'bg-green-400' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-6 py-8">

        {step === 0 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 1 — Archivos del expediente</h2>
              <p className="text-slate-500 text-sm mt-1">
                Subí el PDF del expediente y la planilla del CALM en Excel con los salarios cargados.
              </p>
            </div>

            <div
              className={`border-2 border-dashed rounded-2xl p-10 text-center transition-all cursor-pointer ${
                drag ? 'border-blue-400 bg-blue-50' : 'border-slate-300 hover:border-slate-400 bg-white'
              }`}
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => {
                e.preventDefault(); setDrag(false)
                addFiles(Array.from(e.dataTransfer.files))
              }}
              onClick={() => fileRef.current.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.xlsx,.xls,.xlsm"
                multiple
                className="hidden"
                onChange={e => addFiles(Array.from(e.target.files))}
              />
              <div className="text-4xl mb-3">📂</div>
              <p className="font-medium text-slate-700">Arrastrá los archivos o hacé clic para seleccionar</p>
              <p className="text-sm text-slate-400 mt-2">PDF expediente · Excel planilla CALM (con datos cargados)</p>
            </div>

            {files.length > 0 && (
              <div className="mt-5 space-y-2">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Archivos cargados</p>
                {files.map(f => (
                  <div key={f.id} className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
                    <span className="text-xl">{f.tipo === 'pdf' ? '📄' : f.tipo === 'excel' ? '📊' : '📎'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700 truncate">{f.file.name}</p>
                      <p className="text-xs text-slate-400">
                        {(f.file.size / 1024).toFixed(0)} KB · {f.tipo.toUpperCase()}
                        {f.id === expedientePDF?.id && (
                          <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">
                            Expediente principal
                          </span>
                        )}
                        {f.tipo === 'excel' && calmFileName === f.file.name && calmParsed?.esValida && (
                          <span className="ml-2 px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded text-xs font-medium">
                            Planilla CALM ✓
                          </span>
                        )}
                      </p>
                    </div>
                    <button onClick={() => removeFile(f.id)}
                      className="text-slate-400 hover:text-red-500 text-lg leading-none">×</button>
                  </div>
                ))}
                <button
                  onClick={() => fileRef.current.click()}
                  className="w-full py-2.5 border border-dashed border-slate-300 rounded-xl text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
                >
                  + Agregar más archivos
                </button>
              </div>
            )}

            {calmDetecting && (
              <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-700 text-sm flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-blue-400 border-t-blue-700 rounded-full animate-spin"></span>
                Analizando planilla CALM...
              </div>
            )}

            {calmParsed && !calmParsed.esValida && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm">
                <p className="font-medium mb-1">⚠ Planilla CALM detectada con problemas:</p>
                <ul className="list-disc list-inside text-xs">
                  {calmParsed.problemas.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}

            {files.length > 0 && !expedientePDF && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm">
                ⚠ Se necesita al menos un PDF con el expediente.
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                disabled={!expedientePDF}
                onClick={() => { setStep(1); prefetchFromPDF() }}
                className="px-6 py-3 bg-blue-900 text-white rounded-xl font-medium text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continuar →
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 2 — Configuración</h2>
              <p className="text-slate-500 text-sm mt-1">
                Datos del cálculo. El tipo de acción y los nombres se detectan automáticamente.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6">

              {/* ORDEN DE VOTACIÓN */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Orden de votación</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Resultado del sorteo. La Dra. Weiss siempre vota en tercer lugar.
                </p>
                <div className="space-y-3">
                  {OPCIONES_VOTO.map((op, i) => (
                    <label key={op.id}
                      className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        opcionVoto === i ? 'border-blue-900 bg-blue-50' : 'border-slate-200 hover:border-slate-300'
                      }`}>
                      <input type="radio" checked={opcionVoto === i} onChange={() => setOpcionVoto(i)}
                        className="accent-blue-900 w-4 h-4" />
                      <div>
                        <p className="font-medium text-slate-800 text-sm">{op.label}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* RIPTE ACTUAL */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">RIPTE actual (último publicado)</h3>
                {calmParsed?.calculos?.ripteActual ? (
                  <div className="mt-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <p className="text-xs text-emerald-600 font-medium">RIPTE de la planilla CALM <ChipAuto tipo="planilla" /></p>
                    <p className="text-2xl font-bold text-emerald-700 font-mono">
                      $ {calmParsed.calculos.ripteActual.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                ) : ripteAuto.loading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></span>
                    Buscando valor oficial...
                  </div>
                ) : ripteAuto.valor ? (
                  <div className="px-4 py-2.5 bg-green-50 border border-green-200 rounded-lg inline-block">
                    <p className="text-xs text-green-600 font-medium">RIPTE oficial</p>
                    <p className="text-2xl font-bold text-green-700 font-mono">$ {ripteAuto.valor}</p>
                    {ripteAuto.fecha && <p className="text-xs text-green-500">{ripteAuto.fecha}</p>}
                  </div>
                ) : (
                  <input
                    value={ripteManual}
                    onChange={e => setRipteManual(e.target.value)}
                    placeholder="Ej: 202.963,20"
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm w-48"
                  />
                )}
              </div>

              {/* PLANILLA CALM — banner si está cargada */}
              {calmParsed?.esValida && (
                <div className="bg-emerald-50 border-2 border-emerald-300 rounded-xl p-5">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">📊</span>
                    <div className="flex-1">
                      <h3 className="font-semibold text-emerald-800">Planilla CALM detectada y validada</h3>
                      <p className="text-sm text-emerald-700 mt-1">
                        Los cálculos numéricos vienen directamente de la planilla. Los campos de abajo se autocompletaron desde ahí.
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <div><span className="font-medium text-emerald-800">IBM bruto:</span> <span className="text-emerald-700 font-mono">${calmParsed.calculos.ibmRipteIndividual.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
                        <div><span className="font-medium text-emerald-800">IBM con RIPTE:</span> <span className="text-emerald-700 font-mono">${calmParsed.calculos.riptePuro.ibm.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
                        <div><span className="font-medium text-emerald-800">Indem. RIPTE (sin 20%):</span> <span className="text-emerald-700 font-mono">${calmParsed.calculos.riptePuro.indemnizacionBase.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
                        <div><span className="font-medium text-emerald-800">Indem. RIPTE (+20%):</span> <span className="text-emerald-700 font-mono">${calmParsed.calculos.riptePuro.total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* DATOS DEL CÁLCULO */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Datos del cálculo de indemnización</h3>
                <p className="text-xs text-slate-400 mb-3">
                  {calmParsed?.esValida
                    ? 'Datos tomados de la planilla CALM. Estos campos son solo informativos.'
                    : 'Todos los campos son obligatorios.'}
                </p>

                {prefetching && (
                  <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2">
                    <span className="w-3 h-3 border-2 border-blue-400 border-t-blue-700 rounded-full animate-spin shrink-0"></span>
                    <span className="text-sm text-blue-700">Leyendo el expediente y precargando datos…</span>
                  </div>
                )}
                {prefetchDone && Object.keys(prefilledFields).length > 0 && !calmParsed && (
                  <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm text-green-700">
                      ✓ Datos precargados desde el PDF. Los marcados con <ChipAuto /> los detectó la IA.
                    </p>
                  </div>
                )}
                {prefetchError && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-sm text-amber-700">⚠ No se pudo precargar: {prefetchError}.</p>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Fecha del accidente *
                      {calmParsed && prefilledFields.fechaAccidente ? <ChipAuto tipo="planilla" /> : prefilledFields.fechaAccidente && <ChipAuto />}
                    </label>
                    <input
                      type="date"
                      value={calcInputs.fechaAccidente}
                      disabled={!!calmParsed}
                      onChange={e => setCalcInputs(p => ({ ...p, fechaAccidente: e.target.value }))}
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm ${calmParsed ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      RIPTE del mes del accidente *
                      {calmParsed && prefilledFields.ripteAccidente ? <ChipAuto tipo="planilla" /> : prefilledFields.ripteAccidente && <ChipAuto />}
                    </label>
                    <input
                      value={calcInputs.ripteAccidente}
                      disabled={!!calmParsed}
                      onChange={e => setCalcInputs(p => ({ ...p, ripteAccidente: e.target.value }))}
                      placeholder="Ej: 7.076,47"
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm ${calmParsed ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      IBM bruto AFIP *
                      {calmParsed && prefilledFields.ibmBruto ? <ChipAuto tipo="planilla" /> : prefilledFields.ibmBruto && <ChipAuto />}
                    </label>
                    <input
                      value={calcInputs.ibmBruto}
                      disabled={!!calmParsed}
                      onChange={e => setCalcInputs(p => ({ ...p, ibmBruto: e.target.value }))}
                      placeholder="Ej: 54.784,59"
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm ${calmParsed ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Edad del actor *
                      {calmParsed && prefilledFields.edadActor ? <ChipAuto tipo="planilla" /> : prefilledFields.edadActor && <ChipAuto />}
                    </label>
                    <input
                      type="number"
                      value={calcInputs.edadActor}
                      disabled={!!calmParsed}
                      onChange={e => setCalcInputs(p => ({ ...p, edadActor: e.target.value }))}
                      placeholder="Ej: 52"
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm ${calmParsed ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      % de incapacidad total *
                      {calmParsed && prefilledFields.porcentajeIncapacidad ? <ChipAuto tipo="planilla" /> : prefilledFields.porcentajeIncapacidad && <ChipAuto />}
                    </label>
                    <input
                      value={calcInputs.porcentajeIncapacidad}
                      disabled={!!calmParsed}
                      onChange={e => setCalcInputs(p => ({ ...p, porcentajeIncapacidad: e.target.value }))}
                      placeholder="Ej: 22,5"
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm ${calmParsed ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Intereses tasa activa BNA *
                      {calmParsed && prefilledFields.intereseseBNA ? <ChipAuto tipo="planilla" /> : null}
                    </label>
                    <input
                      value={calcInputs.intereseseBNA}
                      disabled={!!calmParsed}
                      onChange={e => setCalcInputs(p => ({ ...p, intereseseBNA: e.target.value }))}
                      placeholder="Ej: 192.451,91"
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm ${calmParsed ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                    />
                    {!calmParsed && (
                      <button
                        type="button"
                        onClick={abrirCalculadorCABA}
                        className="text-xs text-blue-600 hover:text-blue-800 underline mt-1 inline-block"
                      >
                        🔗 Abrir calculador del Consejo de la Magistratura CABA
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* HONORARIOS — sin cambios */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Honorarios</h3>
                <p className="text-xs text-slate-400 mb-4">Si los dejás en blanco quedan como [A COMPLETAR].</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Letrado/a actor/a</label>
                    <input value={honorarios.actorNombre} onChange={e => setHonorarios(p => ({...p, actorNombre: e.target.value}))}
                      placeholder="Nombre del letrado"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2" />
                    <input value={honorarios.actor} onChange={e => setHonorarios(p => ({...p, actor: e.target.value}))}
                      placeholder="$ 0.000.000"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Letrado/a demandada</label>
                    <input value={honorarios.demNombre} onChange={e => setHonorarios(p => ({...p, demNombre: e.target.value}))}
                      placeholder="Nombre del letrado"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2" />
                    <input value={honorarios.dem} onChange={e => setHonorarios(p => ({...p, dem: e.target.value}))}
                      placeholder="$ 0.000.000"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Perito médico</label>
                    <input value={honorarios.perito} onChange={e => setHonorarios(p => ({...p, perito: e.target.value}))}
                      placeholder="$ 0.000.000"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-600 mb-1 cursor-pointer">
                      <input type="checkbox" checked={honorarios.tienePeritoPsi}
                        onChange={e => setHonorarios(p => ({...p, tienePeritoPsi: e.target.checked}))}
                        className="accent-blue-900" />
                      Perito psiquiatra/psicólogo
                    </label>
                    {honorarios.tienePeritoPsi && (
                      <input value={honorarios.peritoPs} onChange={e => setHonorarios(p => ({...p, peritoPs: e.target.value}))}
                        placeholder="$ 0.000.000"
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-between">
              <button onClick={() => setStep(0)}
                className="px-6 py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                ← Volver
              </button>
              <button
                disabled={(!ripteManual && !ripteAuto.valor && !calmParsed) || !camposCalculoOK}
                onClick={generate}
                className="px-8 py-3 bg-blue-900 text-white rounded-xl font-semibold text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
              >
                ✍️ GENERAR PROYECTO DE SENTENCIA
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Generando proyecto de sentencia</h2>
              <p className="text-slate-500 text-sm mt-1">2-4 minutos aproximadamente.</p>
            </div>

            {genError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-6">
                <p className="font-medium text-red-700 mb-2">Error durante la generación</p>
                <p className="text-sm text-red-600 whitespace-pre-wrap">{genError}</p>
                <button onClick={() => setStep(1)}
                  className="mt-4 px-4 py-2 border border-red-300 text-red-700 rounded-lg text-sm hover:bg-red-50">
                  ← Volver a configuración
                </button>
              </div>
            ) : (
              <>
                <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-slate-700">
                      {genStep >= 0 ? GEN_STEPS[Math.min(genStep, GEN_STEPS.length - 1)] : 'Iniciando...'}
                    </span>
                    <span className="text-sm text-slate-400">{genProgress}%</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-900 rounded-full transition-all duration-500"
                      style={{ width: `${genProgress}%` }} />
                  </div>
                </div>

                {sentenceText && (
                  <div className="bg-white rounded-xl border border-slate-200 p-6">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                      <span className="text-sm font-medium text-slate-600">Vista previa en tiempo real</span>
                    </div>
                    <div className="max-h-80 overflow-y-auto text-xs bg-slate-50 p-4 rounded-lg whitespace-pre-wrap">
                      {sentenceText.slice(-2500)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">✅ Proyecto generado</h2>
            </div>

            {extractedData && !extractedData._parseError && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4 grid grid-cols-2 gap-3 text-sm">
                <div><span className="font-medium text-blue-800">Causa:</span> <span className="text-blue-700">{extractedData.causa_numero || '—'}</span></div>
                <div><span className="font-medium text-blue-800">Actor/a:</span> <span className="text-blue-700">{extractedData.actor?.nombre || '—'}</span></div>
                <div><span className="font-medium text-blue-800">Demandada:</span> <span className="text-blue-700">{Array.isArray(extractedData.demandada) ? extractedData.demandada[0]?.nombre : extractedData.demandada?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Tipo:</span> <span className="text-blue-700">{extractedData.tipo_accion_detectado || 'No detectado'}</span></div>
                <div><span className="font-medium text-blue-800">Incapacidad acreditada:</span> <span className="text-blue-700">{extractedData.incapacidad_acreditada_pericia?.total_porcentaje ?? '—'}% T.O.</span></div>
                <div><span className="font-medium text-blue-800">Fuente cálculos:</span> <span className="text-blue-700">{calmParsed ? 'Planilla CALM 📊' : 'Form manual'}</span></div>
              </div>
            )}

            <div className="flex gap-3 mb-6">
              <button onClick={downloadWord}
                className="flex items-center gap-2 px-6 py-3 bg-blue-900 text-white rounded-xl font-semibold text-sm hover:bg-blue-800 transition-colors shadow-md">
                📥 Descargar Word (.docx)
              </button>
              <button onClick={() => navigator.clipboard.writeText(sentenceText)}
                className="px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                📋 Copiar texto
              </button>
              <button onClick={() => navigate('/')}
                className="px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-500 hover:bg-slate-50 ml-auto">
                Volver
              </button>
            </div>

            <div className="bg-white rounded-xl border border-slate-200">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600">Proyecto de sentencia</span>
                <span className="text-xs text-slate-400">{sentenceText.split(' ').length} palabras</span>
              </div>
              <div className="p-6 max-h-[600px] overflow-y-auto whitespace-pre-wrap text-sm">
                {sentenceText}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  )
}
