import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { extractExpedienteData, generateSentenceSection, getPrompts } from '../lib/claude'
import { saveSentence } from '../lib/supabase'
import { buildWordDocument } from '../lib/word'

const TIPO_ACCIONES = [
  'Acción especial – Ley 24.557',
  'Revisión resolución CM – Art. 2 inc. J ley 15.057',
  'Apelación resolución administrativa – Ley 27.348',
  'Enfermedad profesional – Acción especial',
]

const JUECES = [
  'LA SEÑORA JUEZA DOCTORA ZACARÍAS',
  'EL SEÑOR JUEZ DOCTOR STOLARCZYK',
  'LA SEÑORA JUEZA DOCTORA WEISS',
]

const JUECES_LABEL = ['Dra. Zacarías', 'Dr. Stolarczyk', 'Dra. Weiss']

const STEPS = [
  { id: 'upload', label: 'Expediente', icon: '📂' },
  { id: 'config', label: 'Configuración', icon: '⚙️' },
  { id: 'generate', label: 'Generación', icon: '✍️' },
  { id: 'result', label: 'Resultado', icon: '📄' },
]

const GEN_STEPS = [
  'Extrayendo datos del expediente...',
  'Buscando RIPTE actual...',
  'Redactando antecedentes...',
  'Redactando resolución y pericia médica...',
  'Redactando IBM y cierre Primera Cuestión...',
  'Redactando Segunda Cuestión...',
  'Redactando Sentencia dispositivo...',
  'Generando archivo Word...',
]

export default function NewSentence({ profile, session }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  // Step 0: Upload
  const [file, setFile] = useState(null)
  const [fileB64, setFileB64] = useState('')
  const [drag, setDrag] = useState(false)
  const fileRef = useRef()

  // Step 1: Config
  const [tipoAccion, setTipoAccion] = useState(TIPO_ACCIONES[0])
  const [votoPrimero1, setVotoPrimero1] = useState(0)  // Primera cuestión
  const [votoPrimero2, setVotoPrimero2] = useState(0)  // Segunda cuestión
  const [ripteManual, setRipteManual] = useState('')
  const [ripteAuto, setRipteAuto] = useState({ valor: '', fecha: '', loading: false })
  const [honorarios, setHonorarios] = useState({
    actorNombre: '', actor: '', demNombre: '', dem: '',
    perito: '', peritoPs: '', tienePeritoPsi: false
  })

  // Step 2: Generation
  const [genStep, setGenStep] = useState(-1)
  const [genProgress, setGenProgress] = useState(0)
  const [genError, setGenError] = useState('')
  const [extractedData, setExtractedData] = useState(null)

  // Step 3: Result
  const [sentenceText, setSentenceText] = useState('')
  const [savedId, setSavedId] = useState(null)

  // Fetch RIPTE on config step
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

  function readFile(f) {
    return new Promise((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(fr.result.split(',')[1])
      fr.onerror = rej
      fr.readAsDataURL(f)
    })
  }

  async function handleFile(f) {
    if (!f || f.type !== 'application/pdf') return
    setFile(f)
    const b64 = await readFile(f)
    setFileB64(b64)
  }

  function getJuezNombre(idx) {
    const map = [
      { largo: 'A LA PRIMERA CUESTIÓN PLANTEADA LA SEÑORA JUEZA DOCTORA ZACARÍAS', corto: 'Zacarías', weiss: false },
      { largo: 'A LA PRIMERA CUESTIÓN PLANTEADA EL SEÑOR JUEZ DOCTOR STOLARCZYK', corto: 'Stolarczyk', weiss: false },
      { largo: 'A LA PRIMERA CUESTIÓN PLANTEADA LA SEÑORA JUEZA DOCTORA WEISS', corto: 'Weiss', weiss: true },
    ]
    return map[idx]
  }

  async function generate() {
    setStep(2); setGenError(''); setGenStep(0); setGenProgress(5)
    const apiKey = profile.anthropic_api_key
    if (!apiKey) { setGenError('Configure su API key en Configuración.'); return }

    const ripte = ripteManual || ripteAuto.valor || '198.241,70'
    const ripteF = ripteAuto.fecha || 'Último publicado'

    const juez1 = getJuezNombre(votoPrimero1)
    const juez2 = [0,1,2].find(i => i !== votoPrimero1 && i !== 2)
    const juez2Label = JUECES_LABEL[juez2 ?? 1]
    const config = {
      tipo_accion: tipoAccion,
      primer_voto_1_nombre_completo: JUECES[votoPrimero1].replace('A LA PRIMERA CUESTIÓN PLANTEADA ', ''),
      primer_voto_2_nombre_completo: JUECES[votoPrimero2].replace('A LA PRIMERA CUESTIÓN PLANTEADA ', '').replace('PRIMERA', 'SEGUNDA'),
      juez1: JUECES_LABEL[votoPrimero1],
      juez2: juez2Label,
      juez3: 'Dra. María Alejandra Weiss',
      weissName: 'María Alejandra Weiss',
      ripte_actual: ripte,
      ripte_fecha: ripteF,
      honorarios,
      orden_votacion: `${JUECES_LABEL[votoPrimero1]} – ${juez2Label} – Dra. Weiss`,
    }

    try {
      // Step 0: Extract data
      setGenStep(0); setGenProgress(8)
      const data = await extractExpedienteData(apiKey, fileB64)
      setExtractedData(data)
      data._config = config

      // Step 1: RIPTE (already done)
      setGenStep(1); setGenProgress(15)
      await new Promise(r => setTimeout(r, 400))

      const prompts = getPrompts(data, config)
      const encabezado = buildEncabezado(data, config)

      let fullText = encabezado + '\n\n'
      fullText += 'El Tribunal resolvió plantear y votar las siguientes cuestiones:\n\n'
      fullText += 'PRIMERA CUESTIÓN: ¿Cuáles son los hechos que arriban firmes a esta instancia y cuáles los controvertidos?\n\n'
      fullText += `${JUECES[votoPrimero1].replace('PRIMERA CUESTIÓN PLANTEADA', 'PRIMERA CUESTIÓN PLANTEADA')} DIJO:\n\n`

      // Steps 2-6: Generate sections
      const sections = [
        { key: 'antecedentes', stepIdx: 2, pct: 30 },
        { key: 'resolucion', stepIdx: 3, pct: 50 },
        { key: 'ibm', stepIdx: 4, pct: 65 },
        { key: 'segunda', stepIdx: 5, pct: 80 },
        { key: 'sentencia', stepIdx: 6, pct: 95 },
      ]

      for (const { key, stepIdx, pct } of sections) {
        setGenStep(stepIdx); setGenProgress(pct - 10)
        const text = await generateSentenceSection(apiKey, key, prompts[key], data, config)
        fullText += text + '\n\n'
        setSentenceText(fullText)
        setGenProgress(pct)
      }

      // Step 7: Save
      setGenStep(7); setGenProgress(98)
      const meta = {
        causa_numero: data.causa_numero || '',
        caratula: data.caratula || '',
        tipo_accion: data.tipo_accion || tipoAccion,
      }
      const saved = await saveSentence(session.user.id, meta, fullText)
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
    const j1 = JUECES_LABEL[votoPrimero1]
    const j2 = JUECES_LABEL[[0,1,2].find(i => i !== votoPrimero1 && i !== 2) ?? 1]
    return `En la ciudad de Quilmes, se reúnen en la Sala de Acuerdos los Señores Jueces que, para este acto, integran el Tribunal del Trabajo N.º 5 de esta ciudad, ${j1.replace(/^Dr[ao]\.\s*/,'')}, ${j2.replace(/^Dr[ao]\.\s*/,'')} y María Alejandra Weiss, a efectos de dictar Sentencia en la causa Nº ${causa} caratulada "${caratula}", conforme el siguiente orden de votación: ${j1.split(' ').pop().toUpperCase()} – ${j2.split(' ').pop().toUpperCase()} – WEISS.`
  }

  async function downloadWord() {
    if (!sentenceText) return
    await buildWordDocument(sentenceText, extractedData?.caratula, extractedData?.causa_numero)
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <button onClick={() => navigate('/')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <span>←</span> <span className="font-semibold">SentencIA</span>
          </button>
          <h1 className="text-sm font-medium text-slate-500">Nueva sentencia</h1>
          <div className="w-24"></div>
        </div>
      </header>

      {/* Step indicator */}
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

        {/* ── STEP 0: Upload ─────────────────────────────────────────────── */}
        {step === 0 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 1 — Expediente</h2>
              <p className="text-slate-500 text-sm mt-1">
                Suba el archivo PDF con el expediente completo del caso. 
                La IA leerá su contenido para extraer todos los datos necesarios.
              </p>
            </div>

            <div
              className={`border-2 border-dashed rounded-2xl p-12 text-center transition-all cursor-pointer ${
                drag ? 'border-blue-400 bg-blue-50' :
                file ? 'border-green-400 bg-green-50' : 'border-slate-300 hover:border-slate-400 bg-white'
              }`}
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]) }}
              onClick={() => fileRef.current.click()}
            >
              <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
                onChange={e => handleFile(e.target.files[0])} />
              {file ? (
                <>
                  <div className="text-4xl mb-3">✅</div>
                  <p className="font-medium text-green-700">{file.name}</p>
                  <p className="text-sm text-green-600 mt-1">{(file.size / 1024).toFixed(0)} KB · PDF listo</p>
                  <p className="text-xs text-slate-400 mt-3">Haga clic para cambiar el archivo</p>
                </>
              ) : (
                <>
                  <div className="text-5xl mb-4">📂</div>
                  <p className="font-medium text-slate-700">Arrastrá el PDF aquí o hacé clic para seleccionar</p>
                  <p className="text-sm text-slate-400 mt-2">
                    Suba el expediente digital completo (AUGIT/SISTAU). Puede ser escaneado o con texto seleccionable.
                  </p>
                  <p className="text-xs text-slate-400 mt-1">Solo archivos PDF</p>
                </>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                disabled={!file}
                onClick={() => setStep(1)}
                className="px-6 py-3 bg-blue-900 text-white rounded-xl font-medium text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continuar →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 1: Config ─────────────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 2 — Configuración</h2>
              <p className="text-slate-500 text-sm mt-1">
                Complete los datos que no pueden extraerse automáticamente del expediente.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6">
              {/* Tipo de acción */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Tipo de acción</h3>
                <p className="text-xs text-slate-400 mb-3">La IA intentará detectarlo del expediente; aquí puede confirmarlo o corregirlo antes de generar.</p>
                <select value={tipoAccion} onChange={e => setTipoAccion(e.target.value)}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {TIPO_ACCIONES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>

              {/* Orden de votación */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Orden de votación</h3>
                <p className="text-xs text-slate-400 mb-4">Seleccione quién vota primero en cada cuestión. Los demás dos adhieren.</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Primera Cuestión (hechos)</label>
                    {JUECES_LABEL.map((j, i) => (
                      <label key={i} className="flex items-center gap-2 mb-2 cursor-pointer">
                        <input type="radio" checked={votoPrimero1 === i} onChange={() => setVotoPrimero1(i)}
                          className="accent-blue-900" />
                        <span className="text-sm text-slate-700">{j}</span>
                      </label>
                    ))}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-2">Segunda Cuestión (resolución)</label>
                    {JUECES_LABEL.map((j, i) => (
                      <label key={i} className="flex items-center gap-2 mb-2 cursor-pointer">
                        <input type="radio" checked={votoPrimero2 === i} onChange={() => setVotoPrimero2(i)}
                          className="accent-blue-900" />
                        <span className="text-sm text-slate-700">{j}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIPTE */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">RIPTE actual</h3>
                <p className="text-xs text-slate-400 mb-3">
                  Valor actualizado automáticamente desde el sitio oficial del Ministerio de Trabajo.
                </p>
                {ripteAuto.loading ? (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full spinner"></span>
                    Buscando valor oficial...
                  </div>
                ) : ripteAuto.valor ? (
                  <div className="flex items-center gap-3">
                    <div className="px-4 py-2.5 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-xs text-green-600 font-medium">RIPTE obtenido automáticamente</p>
                      <p className="text-2xl font-bold text-green-700 font-mono">$ {ripteAuto.valor}</p>
                      {ripteAuto.fecha && <p className="text-xs text-green-500">{ripteAuto.fecha}</p>}
                    </div>
                    <p className="text-xs text-slate-400">Si el valor no es correcto, corríjalo:</p>
                  </div>
                ) : (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm mb-3">
                    No se pudo obtener automáticamente. Ingrese el valor manualmente.
                  </div>
                )}
                <div className="mt-3">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {ripteAuto.valor ? 'Corregir manualmente (opcional)' : 'Valor del RIPTE *'}
                  </label>
                  <input
                    value={ripteManual}
                    onChange={e => setRipteManual(e.target.value)}
                    placeholder={ripteAuto.valor || 'Ej: 198.241,70'}
                    className="px-3 py-2 border border-slate-200 rounded-lg text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Honorarios */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Honorarios</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Ingrese los montos de honorarios para incluir en el dispositivo. 
                  Si los deja en blanco quedarán como [A COMPLETAR].
                </p>
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
                disabled={!ripteManual && !ripteAuto.valor}
                onClick={generate}
                className="px-8 py-3 bg-blue-900 text-white rounded-xl font-semibold text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
              >
                ✍️ GENERAR PROYECTO DE SENTENCIA
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Generating ─────────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Generando proyecto de sentencia</h2>
              <p className="text-slate-500 text-sm mt-1">
                La IA está redactando cada sección con el nivel de detalle del modelo real. Este proceso tarda 2-4 minutos.
              </p>
            </div>

            {genError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-6">
                <p className="font-medium text-red-700 mb-2">Error durante la generación</p>
                <p className="text-sm text-red-600">{genError}</p>
                <button onClick={() => setStep(1)}
                  className="mt-4 px-4 py-2 border border-red-300 text-red-700 rounded-lg text-sm hover:bg-red-50">
                  ← Volver a configuración
                </button>
              </div>
            ) : (
              <>
                {/* Progress bar */}
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
                  <div className="mt-4 grid grid-cols-4 gap-2">
                    {GEN_STEPS.slice(0, 8).map((s, i) => (
                      <div key={i} className={`text-xs px-2 py-1.5 rounded text-center ${
                        genStep > i ? 'bg-green-100 text-green-700' :
                        genStep === i ? 'bg-blue-100 text-blue-700 font-medium' :
                        'bg-slate-100 text-slate-400'
                      }`}>
                        {genStep > i ? '✓ ' : ''}{s.replace('...', '')}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live preview */}
                {sentenceText && (
                  <div className="bg-white rounded-xl border border-slate-200 p-6">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-2 h-2 bg-blue-500 rounded-full pulse-dot"></span>
                      <span className="text-sm font-medium text-slate-600">Vista previa en tiempo real</span>
                    </div>
                    <div className="sentence-preview max-h-80 overflow-y-auto text-xs bg-slate-50 p-4 rounded-lg">
                      {sentenceText.slice(-2000)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── STEP 3: Result ─────────────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-800">✅ Proyecto generado exitosamente</h2>
                <p className="text-slate-500 text-sm mt-1">
                  Revise el contenido antes de descargar. Los campos marcados como [COMPLETAR] requieren verificación manual.
                </p>
              </div>
            </div>

            {/* Extracted data summary */}
            {extractedData && !extractedData._parseError && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4 grid grid-cols-2 gap-3 text-sm">
                <div><span className="font-medium text-blue-800">Causa:</span> <span className="text-blue-700">{extractedData.causa_numero}</span></div>
                <div><span className="font-medium text-blue-800">Actor/a:</span> <span className="text-blue-700">{extractedData.actor?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Demandada:</span> <span className="text-blue-700">{Array.isArray(extractedData.demandada) ? extractedData.demandada[0]?.nombre : extractedData.demandada?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Incapacidad:</span> <span className="text-blue-700">{extractedData.pericia_medica?.incapacidad_total_perito}% T.O.</span></div>
              </div>
            )}

            {/* Action buttons */}
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

            {/* Full sentence preview */}
            <div className="bg-white rounded-xl border border-slate-200">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-600">Proyecto de sentencia</span>
                <span className="text-xs text-slate-400">{sentenceText.split(' ').length} palabras</span>
              </div>
              <div className="sentence-preview p-6 max-h-[600px] overflow-y-auto">
                {sentenceText}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  )
}
