import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, getUserSentences } from '../lib/supabase'

export default function Dashboard({ profile, session }) {
  const navigate = useNavigate()
  const [sentences, setSentences] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getUserSentences(session.user.id).then(data => {
      setSentences(data)
      setLoading(false)
    })
  }, [session.user.id])

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚖️</span>
            <div>
              <h1 className="font-bold text-slate-900 text-lg leading-none">SentencIA</h1>
              <p className="text-xs text-slate-400">Tribunal del Trabajo N°5 · Quilmes</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {profile?.role === 'admin' && (
              <button onClick={() => navigate('/admin')}
                className="text-sm text-blue-700 font-medium hover:underline">
                Administración
              </button>
            )}
            <button onClick={() => navigate('/configuracion')}
              className="text-sm text-slate-500 hover:text-slate-700">
              ⚙ Configuración
            </button>
            <button onClick={() => supabase.auth.signOut()}
              className="text-sm text-slate-400 hover:text-slate-600">
              Salir
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Welcome */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-slate-800">
              Bienvenido/a, {profile?.full_name?.split(' ')[0] || 'usuario'}
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              Generá proyectos de sentencia en accidentes de trabajo con IA
            </p>
          </div>
          <button
            onClick={() => {
              if (!profile?.anthropic_api_key) {
                if (confirm('Para generar sentencias necesita configurar su API key de Claude. ¿Ir a configuración?'))
                  navigate('/configuracion')
                return
              }
              navigate('/nueva')
            }}
            className="flex items-center gap-2 px-5 py-3 bg-blue-900 text-white rounded-xl font-medium text-sm hover:bg-blue-800 transition-colors shadow-sm"
          >
            <span>+</span> Nueva sentencia
          </button>
        </div>

        {/* API Key warning */}
        {!profile?.anthropic_api_key && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
            <span className="text-amber-500 text-lg">⚠</span>
            <div>
              <p className="text-amber-800 font-medium text-sm">Configure su API key de Claude</p>
              <p className="text-amber-700 text-sm mt-0.5">
                Para generar sentencias necesita ingresar su clave de API de Anthropic.{' '}
                <button onClick={() => navigate('/configuracion')} className="underline font-medium">
                  Ir a configuración →
                </button>
              </p>
            </div>
          </div>
        )}

        {/* Sentences list */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">
            Proyectos recientes
          </h3>

          {loading ? (
            <div className="flex items-center gap-2 text-slate-400 py-8">
              <span className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full spinner"></span>
              Cargando...
            </div>
          ) : sentences.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
              <div className="text-4xl mb-3 opacity-30">📄</div>
              <p className="text-slate-500">Aún no generó ningún proyecto de sentencia.</p>
              <p className="text-slate-400 text-sm mt-1">Haga clic en "Nueva sentencia" para comenzar.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sentences.map(s => (
                <div
                  key={s.id}
                  onClick={() => navigate(`/sentencia/${s.id}`)}
                  className="bg-white rounded-xl border border-slate-200 p-4 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer flex items-center justify-between group"
                >
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium px-2 py-0.5 bg-blue-50 text-blue-700 rounded-md">
                        N° {s.causa_numero}
                      </span>
                      <span className="text-xs text-slate-400 px-2 py-0.5 bg-slate-50 rounded-md">
                        {s.tipo_accion || 'Accidente de trabajo'}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-800 mt-1.5">{s.caratula || '—'}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {new Date(s.created_at).toLocaleDateString('es-AR', {
                        day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
                      })}
                    </p>
                  </div>
                  <span className="text-slate-300 group-hover:text-blue-500 transition-colors text-lg">→</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
