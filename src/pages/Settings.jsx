import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, updateApiKey } from '../lib/supabase'

export default function Settings({ profile, session, onUpdate }) {
  const navigate = useNavigate()
  const [apiKey, setApiKey] = useState(profile?.anthropic_api_key || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showKey, setShowKey] = useState(false)

  async function save() {
  setSaving(true); setSaved(false); setError('')
  try {
    if (!apiKey.startsWith('sk-ant-')) throw new Error('La API key debe comenzar con sk-ant-')
    await updateApiKey(session.user.id, apiKey)
    const { data, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).single()
    if (error) throw new Error(error.message)
    onUpdate(data)
    setSaved(true)
  } catch (e) { setError(e.message) }
  setSaving(false)
}
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <button onClick={() => navigate('/')} className="text-slate-600 hover:text-slate-900">← Inicio</button>
          <h1 className="font-semibold text-slate-800">Configuración</h1>
          <div className="w-16"></div>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-6 py-8 space-y-6">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-800 mb-1">Perfil</h2>
          <div className="mt-3 space-y-2 text-sm">
            <div><span className="text-slate-500">Nombre:</span> <span className="font-medium">{profile?.full_name}</span></div>
            <div><span className="text-slate-500">Email:</span> <span className="font-medium">{profile?.email}</span></div>
            <div><span className="text-slate-500">Rol:</span> <span className="font-medium capitalize">{profile?.role}</span></div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-800 mb-1">API key de Claude (Anthropic)</h2>
          <p className="text-sm text-slate-500 mb-4">
            Su clave personal de Anthropic. Se usa para generar sentencias y se cobra a su propia cuenta.
            Obténgala en <a href="https://console.anthropic.com" target="_blank" className="text-blue-600 underline">console.anthropic.com</a>.
          </p>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-ant-api03-..."
              className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 pr-20"
            />
            <button onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600">
              {showKey ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
          {error && <p className="mt-2 text-red-600 text-sm">{error}</p>}
          {saved && <p className="mt-2 text-green-600 text-sm">✓ API key guardada correctamente</p>}
          <button onClick={save} disabled={saving}
            className="mt-4 px-5 py-2.5 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
            {saving ? 'Guardando...' : 'Guardar API key'}
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="font-semibold text-slate-800 mb-4">Sesión</h2>
          <button onClick={() => supabase.auth.signOut()}
            className="px-4 py-2 border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50">
            Cerrar sesión
          </button>
        </div>
      </main>
    </div>
  )
}
