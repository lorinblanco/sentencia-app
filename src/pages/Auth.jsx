import { useState } from 'react'
import { signIn, signUp } from '../lib/supabase'

export default function Auth() {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setSuccess(''); setLoading(true)
    try {
      if (mode === 'login') {
        await signIn(email, password)
      } else {
        if (!fullName.trim()) throw new Error('Ingrese su nombre completo')
        if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres')
        await signUp(email, password, fullName)
        setSuccess('Registro exitoso. Su cuenta será revisada por el administrador antes de poder acceder.')
        setMode('login')
      }
    } catch (e) {
      const msg = e.message || ''
      if (msg.includes('Invalid login')) setError('Email o contraseña incorrectos')
      else if (msg.includes('already registered')) setError('Este email ya está registrado')
      else setError(msg || 'Error inesperado')
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-900 rounded-2xl mb-4 shadow-lg">
            <span className="text-3xl">⚖️</span>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">SentencIA</h1>
          <p className="text-blue-300 text-sm mt-1">Tribunal del Trabajo N°5 · Quilmes</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-lg font-semibold text-slate-800 mb-6">
            {mode === 'login' ? 'Iniciar sesión' : 'Solicitar acceso'}
          </h2>

          {success && (
            <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{success}</div>
          )}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nombre completo</label>
                <input
                  type="text" value={fullName} onChange={e => setFullName(e.target.value)}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Dr./Dra. Nombre Apellido"
                  required
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Correo electrónico</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="usuario@poder-judicial.gob.ar"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Contraseña</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={mode === 'register' ? 'Mínimo 8 caracteres' : '••••••••'}
                required
              />
            </div>
            <button
              type="submit" disabled={loading}
              className="w-full py-3 bg-blue-900 text-white rounded-lg font-medium text-sm hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full spinner"></span>
                  {mode === 'login' ? 'Ingresando...' : 'Registrando...'}
                </span>
              ) : (mode === 'login' ? 'Ingresar' : 'Solicitar acceso')}
            </button>
          </form>

          <div className="mt-5 text-center text-sm text-slate-500">
            {mode === 'login' ? (
              <>¿No tiene acceso?{' '}
                <button onClick={() => { setMode('register'); setError(''); setSuccess('') }}
                  className="text-blue-700 font-medium hover:underline">Solicitar registro</button>
              </>
            ) : (
              <>¿Ya tiene acceso?{' '}
                <button onClick={() => { setMode('login'); setError(''); setSuccess('') }}
                  className="text-blue-700 font-medium hover:underline">Iniciar sesión</button>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-blue-400 text-xs mt-6">
          Sistema de uso interno · Datos protegidos
        </p>
      </div>
    </div>
  )
}
