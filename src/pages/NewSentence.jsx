import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  extractAllText, buildChunks, extractBasicInfo, generateSection,
  extractExtraFileText, buildCalculos
} from '../lib/claude'
import {
  buildAdhesionPrimera, buildAdhesionSegunda, detectarVarianteWeiss
} from '../lib/sentenciaPrompts'
import { getRipteFechaAccidente } from '../lib/ripteHistorico'
import { saveSentence } from '../lib/supabase'
import { buildWordDocument } from '../lib/word'

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
  'Buscando RIPTE actual...',
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
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return 'excel'
  return 'otro'
}

// Normaliza fechas del estilo "31/03/2021" o "31 de marzo de 2021" → "2021-03-31"
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

// Chip pequeño que indica que un campo fue autocompletado desde el PDF
function ChipAuto() {
  return (
    <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium align-middle">
      auto
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
  const [sentenceText, setSentenceText] = useState('')
  const [savedId, setSavedId] = useState(null)

  // ── PARCHE: estados de precarga ──────────────────────────────────────────
  const [prefetching, setPrefetching] = useState(false)
  const [prefetchDone, setPrefetchDone] = useState(false)
  const [prefetchError, setPrefetchError] = useState('')
  const [prefilledFields, setPrefilledFields] = useState({})
  const [cachedChunks, setCachedChunks] = useState(null)
  // ────────────────────────────────────────────────────────────────────────

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

  // ── PARCHE: al cambiar la fecha del accidente, autocompletar RIPTE del mes ──
  useEffect(() => {
    const fecha = calcInputs.fechaAccidente
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return
    // No sobreescribir si el usuario ya puso algo manualmente
    if (calcInputs.ripteAccidente && !prefilledFields.ripteAccidente) return
    const valor = getRipteFechaAccidente(fecha)
    if (valor) {
      setCalcInputs(p => ({ ...p, ripteAccidente: valor }))
      setPrefilledFields(p => ({ ...p, ripteAccidente: true }))
    }
  }, [calcInputs.fechaAccidente])
  // ────────────────────────────────────────────────────────────────────────

  function addFiles(newFiles) {
    const added = newFiles.map(f => ({
      file: f, tipo: getTipoArchivo(f), id: Math.random().toString(36).slice(2)
    }))
    setFiles(prev => [...prev, ...added])
  }

  function removeFile(id) { setFiles(prev => prev.filter(f => f.id !== id)) }

  function getExpedientePDF() { return files.find(f => f.tipo === 'pdf') }

  function getArchivosExtra() {
    const exp = getExpedientePDF()
    return files.filter(f => f.id !== exp?.id)
  }

  // ── PARCHE: extracción anticipada al pasar al Paso 2 ────────────────────
  async function prefetchFromPDF() {
    if (prefetchDone || prefetching) return
    const apiKey = profile.anthropic_api_key
    if (!apiKey) return                         // sin key no hay extracción
    const expedientePDF = getExpedientePDF()
    if (!expedientePDF) return

    setPrefetching(true)
    setPrefetchError('')
    try {
      const { fullText } = await extractAllText(expedientePDF.file)
      const chunks = buildChunks(fullText, [])
      setCachedChunks(chunks)                   // lo reutiliza generate()

      const data = await extractBasicInfo(apiKey, chunks)
      if (data._parseError) throw new Error('La IA no devolvió un JSON válido')

      setExtractedData(data)                    // lo reutiliza generate()

      // Mapear campos extraídos → calcInputs
      const prefilled = {}
      const updates = {}

      if (data.accidente?.fecha) {
        const f = normalizarFecha(data.accidente.fecha)
        if (f) { updates.fechaAccidente = f; prefilled.fechaAccidente = true }
      }
      if (data.actor?.edad_al_accidente) {
        updates.edadActor = String(data.actor.edad_al_accidente)
        prefilled.edadActor = true
      }
      if (data.pericia_medica?.incapacidad_total_perito) {
        updates.porcentajeIncapacidad = String(
          data.pericia_medica.incapacidad_total_perito
        ).replace('.', ',')
        prefilled.porcentajeIncapacidad = true
      }
      if (data.ibm_bruto_afip) {
        updates.ibmBruto = String(data.ibm_bruto_afip).replace('.', ',')
        prefilled.ibmBruto = true
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
  // ────────────────────────────────────────────────────────────────────────

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
      // ── PARCHE: reutilizar chunks y extractedData del prefetch ───────────
      const archivosExtra = getArchivosExtra()
      let chunks

      if (cachedChunks && archivosExtra.length === 0) {
        // Camino rápido: el prefetch ya leyó el PDF sin archivos extra
        chunks = cachedChunks
        setGenStep(0); setGenProgress(5)
        await new Promise(r => setTimeout(r, 150))
        setGenStep(1); setGenProgress(22)
      } else {
        // Extracción completa (hay archivos extra o no hubo prefetch)
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
      }

      setGenStep(2); setGenProgress(28)
      await new Promise(r => setTimeout(r, 300))

      setGenStep(3); setGenProgress(35)
      // Reutilizar datos del prefetch si están disponibles y son válidos
      let data = (extractedData && !extractedData._parseError) ? extractedData : null
      if (!data) {
        data = await extractBasicInfo(apiKey, chunks)
        setExtractedData(data)
      }
      // ────────────────────────────────────────────────────────────────────

      const calculos = buildCalculos(config, data)
      console.log('Cálculos:', calculos)
      console.log('Variante Weiss:', detectarVarianteWeiss(calculos, data))

      const encabezado = buildEncabezado(data, config)
      let fullSentence = encabezado + '\n\n'
      fullSentence += 'El Tribunal resolvió plantear y votar las siguientes cuestiones:\n\n'
      fullSentence += `PRIMERA CUESTIÓN: ¿Cuáles son los hechos que arriban firmes a esta instancia y cuáles los controvertidos?\n\n`
      fullSentence += `A LA PRIMERA CUESTIÓN PLANTEADA ${voto.juez1.nombreCompleto} DIJO:\n\n`
      setSentenceText(fullSentence)

      setGenStep(4); setGenProgress(45)
      const antecedentes = await generateSection(apiKey, 'antecedentes', chunks, data, config, calculos)
      fullSentence += antecedentes + '\n\n'
      setSentenceText(fullSentence)

      setGenStep(5); setGenProgress(60)
      const resolucion = await generateSection(apiKey, 'resolucion', chunks, data, config, calculos)
      fullSentence += resolucion + '\n\n'
      setSentenceText(fullSentence)

      setGenStep(6); setGenProgress(72)
      const ibm = await generateSection(apiKey, 'ibm', chunks, data, config, calculos)
      fullSentence += ibm + '\n\n'
      fullSentence += buildAdhesionPrimera(config) + '\n\n'
      fullSentence += `SEGUNDA CUESTIÓN: ¿Qué pronunciamiento corresponde dictar?\n\n`
      fullSentence += `A LA SEGUNDA CUESTIÓN PLANTEADA ${voto.juez1.nombreCompleto} DIJO:\n\n`
      setSentenceText(fullSentence)

      setGenStep(7); setGenProgress(85)
      const segunda = await generateSection(apiKey, 'segunda', chunks, data, config, calculos)
      fullSentence += segunda + '\n\n'
      fullSentence += buildAdhesionSegunda(config, calculos, data) + '\n\n'
      setSentenceText(fullSentence)

      setGenStep(8); setGenProgress(93)
      const dispositivo = await generateSection(apiKey, 'sentencia', chunks, data, config, calculos)
      fullSentence += `S  E  N  T  E  N  C  I  A\n\n`
      fullSentence += `AUTOS Y VISTO: CONSIDERANDO lo decidido en el Acuerdo que antecede y los fundamentos allí vertidos, el Tribunal del Trabajo N° 5 de Quilmes, por mayoría,\n\nRESUELVE:\n\n`
      fullSentence += dispositivo
      setSentenceText(fullSentence)

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

  const camposCalculoOK = calcInputs.ripteAccidente
    && calcInputs.intereseseBNA
    && calcInputs.ibmBruto
    && calcInputs.edadActor
    && calcInputs.porcentajeIncapacidad

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

        {/* ═══ PASO 0 — ARCHIVOS ══════════════════════════════════════════════ */}
        {step === 0 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 1 — Archivos del expediente</h2>
              <p className="text-slate-500 text-sm mt-1">
                Suba el PDF del expediente y, opcionalmente, archivos con las remuneraciones (PDF o Excel).
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
                accept=".pdf,.xlsx,.xls"
                multiple
                className="hidden"
                onChange={e => addFiles(Array.from(e.target.files))}
              />
              <div className="text-4xl mb-3">📂</div>
              <p className="font-medium text-slate-700">Arrastrá los archivos aquí o hacé clic para seleccionar</p>
              <p className="text-sm text-slate-400 mt-2">PDF (expediente y/o remuneraciones) · Excel (remuneraciones)</p>
              <p className="text-xs text-slate-400 mt-1">Podés subir varios archivos a la vez</p>
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

            {files.length > 0 && !expedientePDF && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm">
                ⚠ Se necesita al menos un PDF con el expediente.
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                disabled={!expedientePDF}
                onClick={() => {
                  setStep(1)
                  prefetchFromPDF()   // extracción anticipada en segundo plano
                }}
                className="px-6 py-3 bg-blue-900 text-white rounded-xl font-medium text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continuar →
              </button>
            </div>
          </div>
        )}

        {/* ═══ PASO 1 — CONFIGURACIÓN ════════════════════════════════════════ */}
        {step === 1 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 2 — Configuración</h2>
              <p className="text-slate-500 text-sm mt-1">
                Complete los datos del cálculo. El tipo de acción y los nombres se detectan automáticamente.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6">

              {/* ORDEN DE VOTACIÓN */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Orden de votación</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Seleccione el resultado del sorteo. La Dra. Weiss siempre vota en tercer lugar.
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
                        <p className="text-xs text-slate-400 mt-0.5">
                          {op.juez1.corto} vota primero · {op.juez2.corto} adhiere · Dra. Weiss vota con salvedad art. 7 ley 23.928
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* RIPTE ACTUAL */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">RIPTE actual (último publicado)</h3>
                <p className="text-xs text-slate-400 mb-3">Se busca automáticamente.</p>
                {ripteAuto.loading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></span>
                    Buscando valor oficial...
                  </div>
                ) : ripteAuto.valor ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="px-4 py-2.5 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-xs text-green-600 font-medium">RIPTE oficial</p>
                      <p className="text-2xl font-bold text-green-700 font-mono">$ {ripteAuto.valor}</p>
                      {ripteAuto.fecha && <p className="text-xs text-green-500">{ripteAuto.fecha}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm mb-3">
                    No se pudo obtener automáticamente. Ingréselo manualmente.
                  </div>
                )}
                <div className="mt-3">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {ripteAuto.valor ? 'Corregir manualmente (opcional)' : 'Valor del RIPTE *'}
                  </label>
                  <input
                    value={ripteManual}
                    onChange={e => setRipteManual(e.target.value)}
                    placeholder={ripteAuto.valor || 'Ej: 202.963,20'}
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* DATOS DEL CÁLCULO */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Datos del cálculo de indemnización</h3>
                <p className="text-xs text-slate-400 mb-3">
                  Todos los campos son obligatorios. La IA usará estos valores para la comparación tasa BNA vs RIPTE y declarar inconstitucionalidad del art. 12 LRT si corresponde.
                </p>

                {/* ── PARCHE: banners de estado del prefetch ── */}
                {prefetching && (
                  <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2">
                    <span className="w-3 h-3 border-2 border-blue-400 border-t-blue-700 rounded-full animate-spin shrink-0"></span>
                    <span className="text-sm text-blue-700">
                      Leyendo el expediente y precargando datos… (5–10 seg)
                    </span>
                  </div>
                )}
                {prefetchDone && Object.keys(prefilledFields).length > 0 && (
                  <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm text-green-700">
                      ✓ Datos precargados desde el PDF. Revisá los campos marcados con{' '}
                      <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-medium">auto</span>
                      {' '}y completá los faltantes. Los intereses BNA siempre se ingresan a mano.
                    </p>
                  </div>
                )}
                {prefetchError && (
                  <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-sm text-amber-700">
                      ⚠ No se pudo precargar: {prefetchError}. Completá los campos a mano.
                    </p>
                  </div>
                )}
                {/* ─────────────────────────────────────────── */}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Fecha del accidente *
                      {prefilledFields.fechaAccidente && <ChipAuto />}
                    </label>
                    <input
                      type="date"
                      value={calcInputs.fechaAccidente}
                      onChange={e => {
                        setCalcInputs(p => ({ ...p, fechaAccidente: e.target.value }))
                        // Si el usuario edita la fecha manualmente, limpiar el chip
                        setPrefilledFields(p => ({ ...p, fechaAccidente: false, ripteAccidente: false }))
                        setCalcInputs(p => ({ ...p, fechaAccidente: e.target.value, ripteAccidente: '' }))
                      }}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      RIPTE del mes del accidente *
                      {prefilledFields.ripteAccidente && <ChipAuto />}
                    </label>
                    <input
                      value={calcInputs.ripteAccidente}
                      onChange={e => {
                        setCalcInputs(p => ({ ...p, ripteAccidente: e.target.value }))
                        setPrefilledFields(p => ({ ...p, ripteAccidente: false }))
                      }}
                      placeholder="Ej: 8.665,19"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      IBM bruto AFIP *
                      {prefilledFields.ibmBruto && <ChipAuto />}
                    </label>
                    <input
                      value={calcInputs.ibmBruto}
                      onChange={e => {
                        setCalcInputs(p => ({ ...p, ibmBruto: e.target.value }))
                        setPrefilledFields(p => ({ ...p, ibmBruto: false }))
                      }}
                      placeholder="Ej: 43.369,60"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="text-xs text-slate-400 mt-0.5">Promedio últimos 12 meses</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Edad del actor al accidente *
                      {prefilledFields.edadActor && <ChipAuto />}
                    </label>
                    <input
                      type="number"
                      value={calcInputs.edadActor}
                      onChange={e => {
                        setCalcInputs(p => ({ ...p, edadActor: e.target.value }))
                        setPrefilledFields(p => ({ ...p, edadActor: false }))
                      }}
                      placeholder="Ej: 37"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      % de incapacidad total *
                      {prefilledFields.porcentajeIncapacidad && <ChipAuto />}
                    </label>
                    <input
                      value={calcInputs.porcentajeIncapacidad}
                      onChange={e => {
                        setCalcInputs(p => ({ ...p, porcentajeIncapacidad: e.target.value }))
                        setPrefilledFields(p => ({ ...p, porcentajeIncapacidad: false }))
                      }}
                      placeholder="Ej: 3,8"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="text-xs text-slate-400 mt-0.5">Incluye factores de ponderación</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Intereses tasa activa BNA *
                    </label>
                    <input
                      value={calcInputs.intereseseBNA}
                      onChange={e => setCalcInputs(p => ({ ...p, intereseseBNA: e.target.value }))}
                      placeholder="Ej: 144.186,96"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={abrirCalculadorCABA}
                      className="text-xs text-blue-600 hover:text-blue-800 underline mt-1 inline-block"
                    >
                      🔗 Abrir calculador del Consejo de la Magistratura CABA
                    </button>
                  </div>
                </div>
              </div>

              {/* HONORARIOS */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Honorarios</h3>
                <p className="text-xs text-slate-400 mb-4">Si los deja en blanco quedarán como [A COMPLETAR].</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Letrado/a actor/a</label>
                    <input value={honorarios.actorNombre} onChange={e => setHonorarios(p => ({...p, actorNombre: e.target.value}))}
                      placeholder="Nombre del letrado"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <input value={honorarios.actor} onChange={e => setHonorarios(p => ({...p, actor: e.target.value}))}
                      placeholder="$ 0.000.000"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Letrado/a demandada</label>
                    <input value={honorarios.demNombre} onChange={e => setHonorarios(p => ({...p, demNombre: e.target.value}))}
                      placeholder="Nombre del letrado"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <input value={honorarios.dem} onChange={e => setHonorarios(p => ({...p, dem: e.target.value}))}
                      placeholder="$ 0.000.000"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Perito médico</label>
                    <input value={honorarios.perito} onChange={e => setHonorarios(p => ({...p, perito: e.target.value}))}
                      placeholder="$ 0.000.000"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
                        className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
                disabled={(!ripteManual && !ripteAuto.valor) || !camposCalculoOK}
                onClick={generate}
                className="px-8 py-3 bg-blue-900 text-white rounded-xl font-semibold text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
              >
                ✍️ GENERAR PROYECTO DE SENTENCIA
              </button>
            </div>
            {!camposCalculoOK && (
              <p className="text-xs text-amber-600 mt-2 text-right">
                ⚠ Faltan completar campos del cálculo de indemnización.
              </p>
            )}
          </div>
        )}

        {/* ═══ PASO 2 — GENERACIÓN ════════════════════════════════════════════ */}
        {step === 2 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Generando proyecto de sentencia</h2>
              <p className="text-slate-500 text-sm mt-1">
                Leyendo el PDF localmente y enviando solo las secciones relevantes a la IA. Esto tarda 2-4 minutos.
              </p>
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

                  {genStep === 0 && genSubProgress > 0 && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500">Leyendo páginas del PDF...</span>
                        <span className="text-xs text-slate-400">{genSubProgress}%</span>
                      </div>
                      <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-400 rounded-full transition-all duration-300"
                          style={{ width: `${genSubProgress}%` }} />
                      </div>
                    </div>
                  )}

                  <div className="mt-4 grid grid-cols-5 gap-2">
                    {GEN_STEPS.slice(0, 10).map((s, i) => (
                      <div key={i} className={`text-xs px-2 py-1.5 rounded text-center ${
                        genStep > i ? 'bg-green-100 text-green-700' :
                        genStep === i ? 'bg-blue-100 text-blue-700 font-medium' :
                        'bg-slate-100 text-slate-400'
                      }`}>
                        {genStep > i ? '✓' : (i + 1)}
                      </div>
                    ))}
                  </div>
                </div>

                {sentenceText && (
                  <div className="bg-white rounded-xl border border-slate-200 p-6">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                      <span className="text-sm font-medium text-slate-600">Vista previa en tiempo real</span>
                    </div>
                    <div className="sentence-preview max-h-80 overflow-y-auto text-xs bg-slate-50 p-4 rounded-lg whitespace-pre-wrap">
                      {sentenceText.slice(-2500)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ═══ PASO 3 — RESULTADO ═════════════════════════════════════════════ */}
        {step === 3 && (
          <div>
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-800">✅ Proyecto generado exitosamente</h2>
                <p className="text-slate-500 text-sm mt-1">
                  Revise el contenido. Los campos [COMPLETAR] requieren verificación manual.
                </p>
              </div>
            </div>

            {extractedData && !extractedData._parseError && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4 grid grid-cols-2 gap-3 text-sm">
                <div><span className="font-medium text-blue-800">Causa:</span> <span className="text-blue-700">{extractedData.causa_numero}</span></div>
                <div><span className="font-medium text-blue-800">Actor/a:</span> <span className="text-blue-700">{extractedData.actor?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Demandada:</span> <span className="text-blue-700">{Array.isArray(extractedData.demandada) ? extractedData.demandada[0]?.nombre : extractedData.demandada?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Tipo:</span> <span className="text-blue-700">{extractedData.tipo_accion || extractedData.tipo_accion_detectado || 'No detectado'}</span></div>
                <div><span className="font-medium text-blue-800">Incapacidad:</span> <span className="text-blue-700">{extractedData.pericia_medica?.incapacidad_total_perito}% T.O.</span></div>
                <div><span className="font-medium text-blue-800">Orden:</span> <span className="text-blue-700">{OPCIONES_VOTO[opcionVoto].label}</span></div>
              </div>
            )}

            <div className="flex gap-3 mb-6">
              <button onClick={downloadWord}
                className="flex items-center gap-2 px-6 py-3 bg-blue-900 text-white rounded-xl font-semibold text-sm hover:bg-blue-800 transition-colors shadow-md">
                📥 Descargar Word (.docx)
              </button>
              <button onClick={() => navigator.clipboard.writeText(sentenceText)}
                className="flex items-center gap-2 px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                📋 Copiar texto
              </button>
              <button onClick={() => navigate('/')}
                className="px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-500 hover:bg-slate-50 ml-auto">
                Volver al inicio
              </button>
            </div>

            <div className="bg-white rounded-xl border border-slate-200">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600">Proyecto de sentencia</span>
                <span className="text-xs text-slate-400">{sentenceText.split(' ').length} palabras</span>
              </div>
              <div className="sentence-preview p-6 max-h-[600px] overflow-y-auto whitespace-pre-wrap text-sm">
                {sentenceText}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  )
}
