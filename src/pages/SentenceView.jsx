import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getSentence } from '../lib/supabase'
import { buildWordDocument } from '../lib/word'

export default function SentenceView({ profile }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [sentence, setSentence] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getSentence(id).then(data => { setSentence(data); setLoading(false) })
  }, [id])

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div className="w-8 h-8 border-2 border-blue-300 border-t-blue-900 rounded-full spinner"></div></div>
  if (!sentence) return <div className="flex items-center justify-center min-h-screen text-slate-500">Sentencia no encontrada</div>

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <button onClick={() => navigate('/')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900">← Inicio</button>
          <div className="text-center">
            <p className="text-sm font-medium text-slate-700">{sentence.caratula}</p>
            <p className="text-xs text-slate-400">Causa N° {sentence.causa_numero}</p>
          </div>
          <button onClick={() => buildWordDocument(sentence.content, sentence.caratula, sentence.causa_numero)}
            className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800">
            📥 Descargar Word
          </button>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-600">Proyecto de sentencia</span>
            <span className="text-xs text-slate-400">
              Generado {new Date(sentence.created_at).toLocaleDateString('es-AR')}
            </span>
          </div>
          <div className="sentence-preview p-8">{sentence.content}</div>
        </div>
      </main>
    </div>
  )
}
