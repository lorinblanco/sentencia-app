import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllProfiles, approveUser, revokeUser, getTemplates, upsertTemplate, deleteTemplate, getSetting, setSetting } from '../lib/supabase'

export default function Admin({ profile }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('users')
  const [users, setUsers] = useState([])
  const [templates, setTemplates] = useState([])
  const [ripte, setRipte] = useState('')
  const [loading, setLoading] = useState(true)
  const [newTpl, setNewTpl] = useState({ name: '', tipo: '', content: '' })
  const [editingTpl, setEditingTpl] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    const [u, t, r] = await Promise.all([getAllProfiles(), getTemplates(), getSetting('ripte_manual')])
    setUsers(u); setTemplates(t); setRipte(r || ''); setLoading(false)
  }

  async function toggleUser(u) {
    if (u.role === 'admin') return
    if (u.role === 'user') await revokeUser(u.id)
    else await approveUser(u.id)
    load()
  }

  async function saveTpl() {
    setSaving(true); setMsg('')
    try {
      const tpl = editingTpl ? { ...editingTpl } : { ...newTpl, uploaded_by: profile.id }
      await upsertTemplate(tpl)
      setMsg('Plantilla guardada'); setNewTpl({ name: '', tipo: '', content: '' }); setEditingTpl(null)
      load()
    } catch (e) { setMsg('Error: ' + e.message) }
    setSaving(false)
  }

  async function saveRipte() {
    setSaving(true)
    await setSetting('ripte_manual', ripte)
    setMsg('RIPTE guardado como respaldo')
    setSaving(false)
  }

  const TAB = [
    { id: 'users', label: '👥 Usuarios' },
    { id: 'templates', label: '📋 Plantillas' },
    { id: 'settings', label: '⚙ Ajustes' },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <button onClick={() => navigate('/')} className="text-slate-600 hover:text-slate-900">← Inicio</button>
          <h1 className="font-bold text-slate-800">⚖️ SentencIA · Administración</h1>
          <div className="w-16"></div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-6 border-b border-slate-200">
          {TAB.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                tab === t.id ? 'border-blue-900 text-blue-900' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {msg && (
          <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
            ✓ {msg}
          </div>
        )}

        {loading ? <div className="text-slate-400 py-8">Cargando...</div> : (

          <>
            {/* USERS TAB */}
            {tab === 'users' && (
              <div>
                <h2 className="font-semibold text-slate-800 mb-4">Gestión de usuarios ({users.length})</h2>
                <div className="space-y-2">
                  {users.map(u => (
                    <div key={u.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-slate-800">{u.full_name || '—'}</p>
                        <p className="text-sm text-slate-500">{u.email}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Registrado: {new Date(u.created_at).toLocaleDateString('es-AR')}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                          u.role === 'admin' ? 'bg-purple-100 text-purple-700' :
                          u.role === 'user' ? 'bg-green-100 text-green-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>
                          {u.role === 'admin' ? 'Admin' : u.role === 'user' ? 'Activo' : 'Pendiente'}
                        </span>
                        {u.role !== 'admin' && u.id !== profile.id && (
                          <button onClick={() => toggleUser(u)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              u.role === 'user'
                                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                                : 'bg-green-50 text-green-700 hover:bg-green-100'
                            }`}>
                            {u.role === 'user' ? 'Revocar acceso' : 'Aprobar acceso'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TEMPLATES TAB */}
            {tab === 'templates' && (
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h2 className="font-semibold text-slate-800 mb-4">Plantillas existentes</h2>
                  {templates.length === 0 ? (
                    <p className="text-slate-400 text-sm">No hay plantillas cargadas.</p>
                  ) : (
                    <div className="space-y-2">
                      {templates.map(t => (
                        <div key={t.id} className="bg-white rounded-xl border border-slate-200 p-4">
                          <p className="font-medium text-slate-800 text-sm">{t.name}</p>
                          <p className="text-xs text-slate-400">{t.tipo}</p>
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => setEditingTpl(t)}
                              className="text-xs text-blue-600 hover:underline">Editar</button>
                            <button onClick={async () => { await deleteTemplate(t.id); load() }}
                              className="text-xs text-red-500 hover:underline">Eliminar</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <h2 className="font-semibold text-slate-800 mb-4">
                    {editingTpl ? 'Editar plantilla' : 'Nueva plantilla'}
                  </h2>
                  <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
                    <input
                      value={editingTpl ? editingTpl.name : newTpl.name}
                      onChange={e => editingTpl ? setEditingTpl(p => ({...p, name: e.target.value})) : setNewTpl(p => ({...p, name: e.target.value}))}
                      placeholder="Nombre de la plantilla"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                      value={editingTpl ? editingTpl.tipo : newTpl.tipo}
                      onChange={e => editingTpl ? setEditingTpl(p => ({...p, tipo: e.target.value})) : setNewTpl(p => ({...p, tipo: e.target.value}))}
                      placeholder="Tipo (ej: Accidente de trabajo)"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <textarea
                      rows={10}
                      value={editingTpl ? editingTpl.content : newTpl.content}
                      onChange={e => editingTpl ? setEditingTpl(p => ({...p, content: e.target.value})) : setNewTpl(p => ({...p, content: e.target.value}))}
                      placeholder="Contenido de la plantilla (texto modelo)..."
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                    />
                    <div className="flex gap-2">
                      <button onClick={saveTpl} disabled={saving}
                        className="flex-1 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
                        {saving ? 'Guardando...' : 'Guardar plantilla'}
                      </button>
                      {editingTpl && (
                        <button onClick={() => setEditingTpl(null)}
                          className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-600">
                          Cancelar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SETTINGS TAB */}
            {tab === 'settings' && (
              <div className="max-w-lg space-y-6">
                <div className="bg-white rounded-xl border border-slate-200 p-6">
                  <h2 className="font-semibold text-slate-800 mb-1">RIPTE de respaldo</h2>
                  <p className="text-sm text-slate-500 mb-3">
                    Valor que se usa si la búsqueda automática falla. Actualizarlo manualmente una vez por mes.
                  </p>
                  <input value={ripte} onChange={e => setRipte(e.target.value)}
                    placeholder="Ej: 198.241,70"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button onClick={saveRipte} disabled={saving}
                    className="mt-3 px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
