import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { extractExpedienteData, generateSentenceSection, getPrompts } from '../lib/claude'
import { saveSentence } from '../lib/supabase'
import { buildWordDocument } from '../lib/word'

// Weiss SIEMPRE vota última y SIEMPRE tiene la salvedad art. 7 ley 23.928
// Solo se elige quién vota primero entre Zacarías y Stolarczyk
// El orden es el mismo para PRIMERA y SEGUNDA cuestión

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
  'Extrayendo datos del expediente...',
  'Buscando RIPTE actual...',
  'Redactando antecedentes y hechos...',
  'Redactando resolución y pericia médica...',
  'Redactando IBM y cierre Primera Cuestión...',
  'Redactando Segunda Cuestión...',
  'Redactando Sentencia dispositivo...',
  'Generando archivo Word...',
]

const FILE_TYPES = {
  'application/pdf': { icon: '📄', label: 'PDF' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { icon: '📊', label: 'Excel' },
  'application/vnd.ms-excel': { icon: '📊', label: 'Excel' },
}

export default function NewSentence({ profile, session }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  // Step 0: Archivos múltiples
  const [files, setFiles] = useState([]) // [{ file, b64, tipo }]
  const [drag, setDrag] = useState(false)
  const fileRef = useRef()

  // Step 1: Config
  const [opcionVoto, setOpcionVoto] = useState(0) // índice en OPCIONES_VOTO
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

  function getTipoArchivo(f) {
    const name = f.name.toLowerCase()
    if (name.endsWith('.pdf')) return 'pdf'
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return 'excel'
    return 'otro'
  }

  async function addFiles(newFiles) {
    const added = []
    for (const f of newFiles) {
      const tipo = getTipoArchivo(f)
      const b64 = tipo === 'pdf' ? await readFile(f) : null
      added.push({ file: f, b64, tipo, id: Math.random().toString(36).slice(2) })
    }
    setFiles(prev => [...prev, ...added])
  }

  function removeFile(id) {
    setFiles(prev => prev.filter(f => f.id !== id))
  }

  function getExpedientePDF() {
    // El primer PDF es el expediente principal
    return files.find(f => f.tipo === 'pdf')
  }

  async function generate() {
    setStep(2); setGenError(''); setGenStep(0); setGenProgress(5)
    const apiKey = profile.anthropic_api_key
    if (!apiKey) { setGenError('Configure su API key en Configuración.'); return }

    const ripte = ripteManual || ripteAuto.valor || '198.241,70'
    const ripteF = ripteAuto.fecha || 'Último publicado'
    const voto = OPCIONES_VOTO[opcionVoto]

    const config = {
      juez1: voto.juez1,
      juez2: voto.juez2,
      weiss: WEISS,
      orden: `${voto.juez1.corto} – ${voto.juez2.corto} – ${WEISS.corto}`,
      ripte_actual: ripte,
      ripte_fecha: ripteF,
      honorarios,
    }

    const expedientePDF = getExpedientePDF()
    if (!expedientePDF) { setGenError('No hay PDF del expediente cargado.'); return }

    try {
      setGenStep(0); setGenProgress(8)
      const data = await extractExpedienteData(apiKey, expedientePDF.b64)
      setExtractedData(data)
      data._config = config

      setGenStep(1); setGenProgress(15)
      await new Promise(r => setTimeout(r, 400))

      const prompts = getPrompts(data, config)
      const encabezado = buildEncabezado(data, config)

      let fullText = encabezado + '\n\n'
      fullText += 'El Tribunal resolvió plantear y votar las siguientes cuestiones:\n\n'
      fullText += `PRIMERA CUESTIÓN: ¿Cuáles son los hechos que arriban firmes a esta instancia y cuáles los controvertidos?\n\n`
      fullText += `A LA PRIMERA CUESTIÓN PLANTEADA ${voto.juez1.nombreCompleto} DIJO:\n\n`

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

        // Insertar adhesiones según la sección
        if (key === 'ibm') {
          // Cierre Primera Cuestión: adhesión juez2 y Weiss
          fullText += buildAdhesionPrimera(voto, data) + '\n\n'
          fullText += `SEGUNDA CUESTIÓN: ¿Qué pronunciamiento corresponde dictar?\n\n`
          fullText += `A LA SEGUNDA CUESTIÓN PLANTEADA ${voto.juez1.nombreCompleto} DIJO:\n\n`
        }

        setSentenceText(fullText)
        setGenProgress(pct)
      }

      // Adhesión Segunda Cuestión y cierre
      fullText += buildAdhesionSegunda(voto) + '\n\n'
      fullText += buildCierre(data, config) + '\n\n'
      setSentenceText(fullText)

      setGenStep(7); setGenProgress(98)
      const meta = {
        causa_numero: data.causa_numero || '',
        caratula: data.caratula || '',
        tipo_accion: data.tipo_accion || '',
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
    const { juez1, juez2, weiss } = config
    return `En la ciudad de Quilmes, se reúnen en la Sala de Acuerdos los Señores Jueces que, para este acto, integran el Tribunal del Trabajo N.º 5 de esta ciudad, ${juez1.corto.replace(/^Dr[ao]\.\s*/, '')}, ${juez2.corto.replace(/^Dr[ao]\.\s*/, '')} y ${weiss.nombreCivil}, a efectos de dictar Sentencia en la causa Nº ${causa} caratulada "${caratula}", conforme el siguiente orden de votación: ${juez1.nombre} – ${juez2.nombre} – ${weiss.nombre}.`
  }

  function buildAdhesionPrimera(voto, data) {
    const { juez1, juez2 } = voto
    const j2articulo = juez2.genero === 'm' ? 'el Señor Juez Doctor' : 'la Señora Jueza Doctora'
    const j2nombreCompleto = juez2.genero === 'm' ? 'Mario Daniel Stolarczyk' : 'Andrea Marcela Zacarías'

    const adhesionJ2 = `A la misma cuestión planteada ${j2articulo} ${j2nombreCompleto}, por compartir fundamentos, adhiere en todos sus términos al voto que antecede.`

    const adhesionWeiss = `A la misma cuestión planteada ${WEISS.nombreCompleto} DIJO: En virtud de las particularidades que presenta el caso en estudio, y por los fundamentos vertidos, adhiero al voto del/de la ${juez1.corto}. Sin perjuicio de ello, dejo a salvo mi opinión respecto a que la limitación impuesta por el art. 7 de la ley 23.928 podría resultar inconstitucional en forma sobreviniente, conforme los fundamentos que he desarrollado en anteriores pronunciamientos. Así lo voto.`

    return `${adhesionJ2}\n\n${adhesionWeiss}`
  }

  function buildAdhesionSegunda(voto) {
    const { juez2 } = voto
    const j2corto = juez2.corto.replace(/^Dr[ao]\.\s*/, '')
    return `A la misma cuestión planteada los señores jueces doctores ${j2corto} y ${WEISS.nombreCivil}, por compartir fundamentos, adhieren en todos sus términos al voto que antecede.\n\nCon lo que terminó el Acuerdo firmando los Señores Jueces por ante mí que doy fe.`
  }

  function buildCierre(data, config) {
    return `S  E  N  T  E  N  C  I  A\n\nAUTOS Y VISTO: CONSIDERANDO lo decidido en el Acuerdo que antecede y los fundamentos allí vertidos, el Tribunal del Trabajo N° 5 de Quilmes, por mayoría,\n\nRESUELVE:`
  }

  async function downloadWord() {
    if (!sentenceText) return
    await buildWordDocument(sentenceText, extractedData?.caratula, extractedData?.causa_numero)
  }

  const expedientePDF = getExpedientePDF()
  const archivosExtra = files.filter(f => f.tipo !== 'pdf' || f.id !== expedientePDF?.id)

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

        {/* ── STEP 0: Upload múltiple ──────────────────────────────────── */}
        {step === 0 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 1 — Archivos del expediente</h2>
              <p className="text-slate-500 text-sm mt-1">
                Suba el PDF del expediente y, opcionalmente, archivos adicionales con las remuneraciones (PDF o Excel).
              </p>
            </div>

            {/* Zona de drop */}
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
              <p className="text-xs text-slate-400 mt-1">Podés subir más de un archivo a la vez</p>
            </div>

            {/* Lista de archivos cargados */}
            {files.length > 0 && (
              <div className="mt-5 space-y-2">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Archivos cargados</p>
                {files.map((f, i) => (
                  <div key={f.id} className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
                    <span className="text-xl">{FILE_TYPES[f.file.type]?.icon || '📎'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700 truncate">{f.file.name}</p>
                      <p className="text-xs text-slate-400">
                        {(f.file.size / 1024).toFixed(0)} KB · {FILE_TYPES[f.file.type]?.label || f.tipo}
                        {i === 0 && f.tipo === 'pdf' && (
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

                {/* Botón agregar más */}
                <button
                  onClick={() => fileRef.current.click()}
                  className="w-full py-2.5 border border-dashed border-slate-300 rounded-xl text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
                >
                  + Agregar más archivos
                </button>
              </div>
            )}

            {/* Advertencia si no hay PDF */}
            {files.length > 0 && !expedientePDF && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-700 text-sm">
                ⚠ Se necesita al menos un archivo PDF con el expediente para generar la sentencia.
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                disabled={!expedientePDF}
                onClick={() => setStep(1)}
                className="px-6 py-3 bg-blue-900 text-white rounded-xl font-medium text-sm hover:bg-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continuar →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 1: Config ───────────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Paso 2 — Configuración</h2>
              <p className="text-slate-500 text-sm mt-1">
                El tipo de acción se detectará automáticamente del expediente. Solo configure el orden de votación y los demás datos.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6">

              {/* Orden de votación */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-medium text-slate-800 mb-1">Orden de votación</h3>
                <p className="text-xs text-slate-400 mb-4">
                  Seleccione el resultado del sorteo. La Dra. Weiss siempre vota en tercer lugar.
                </p>
                <div className="space-y-3">
                  {OPCIONES_VOTO.map((op, i) => (
                    <label key={op.id}
                      className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        opcionVoto === i
                          ? 'border-blue-900 bg-blue-50'
                          : 'border-slate-200 hover:border-slate-300'
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
                <div className="mt-4 p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <p className="text-xs text-slate-500 font-medium mb-1">Esquema que se aplicará:</p>
                  <p className="text-xs text-slate-400 leading-relaxed font-mono">
                    1ª Cuestión: {OPCIONES_VOTO[opcionVoto].juez1.corto} (voto completo) →{' '}
                    {OPCIONES_VOTO[opcionVoto].juez2.corto} (adhiere) → Dra. Weiss (adhiere + salvedad)<br />
                    2ª Cuestión: {OPCIONES_VOTO[opcionVoto].juez1.corto} (voto completo) →{' '}
                    {OPCIONES_VOTO[opcionVoto].juez2.corto} y Weiss (adhieren juntos)
                  </p>
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
                    <p className="text-xs text-slate-400">Si el valor no es correcto, corríjalo abajo:</p>
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
                  Ingrese los montos para incluir en el dispositivo. Si los deja en blanco quedarán como [A COMPLETAR].
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

        {/* ── STEP 2: Generating ──────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-slate-800">Generando proyecto de sentencia</h2>
              <p className="text-slate-500 text-sm mt-1">
                La IA está redactando cada sección. Este proceso tarda 2-4 minutos.
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
                {sentenceText && (
                  <div className="bg-white rounded-xl border border-slate-200 p-6">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                      <span className="text-sm font-medium text-slate-600">Vista previa en tiempo real</span>
                    </div>
                    <div className="sentence-preview max-h-80 overflow-y-auto text-xs bg-slate-50 p-4 rounded-lg whitespace-pre-wrap">
                      {sentenceText.slice(-2000)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── STEP 3: Result ──────────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-800">✅ Proyecto generado exitosamente</h2>
                <p className="text-slate-500 text-sm mt-1">
                  Revise el contenido. Los campos marcados [COMPLETAR] requieren verificación manual.
                </p>
              </div>
            </div>

            {extractedData && !extractedData._parseError && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4 grid grid-cols-2 gap-3 text-sm">
                <div><span className="font-medium text-blue-800">Causa:</span> <span className="text-blue-700">{extractedData.causa_numero}</span></div>
                <div><span className="font-medium text-blue-800">Actor/a:</span> <span className="text-blue-700">{extractedData.actor?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Demandada:</span> <span className="text-blue-700">{Array.isArray(extractedData.demandada) ? extractedData.demandada[0]?.nombre : extractedData.demandada?.nombre}</span></div>
                <div><span className="font-medium text-blue-800">Tipo:</span> <span className="text-blue-700">{extractedData.tipo_accion || 'Detectado automáticamente'}</span></div>
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
