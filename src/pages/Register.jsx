import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export default function Register() {
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { signUp } = useAuth()
  const navigate = useNavigate()

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirm) return setError('Las contraseñas no coinciden')
    if (form.password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres')
    setLoading(true)
    try {
      await signUp(form.email, form.password, form.fullName)
      navigate('/pending')
    } catch (err) {
      setError(err.message || 'Error al registrarse')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy-900 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-gold-500 rounded-xl flex items-center justify-center text-white font-bold text-lg font-serif">S</div>
            <span className="text-white text-2xl font-semibold tracking-tight">Sentenc<span className="text-gold-400">IA</span></span>
          </div>
          <p className="text-navy-300 text-sm mt-1">Tribunal del Trabajo N°5 – Quilmes</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-lg font-semibold text-gray-900 mb-1">Crear cuenta</h1>
          <p className="text-sm text-gray-500 mb-6">Tu cuenta quedará pendiente hasta que el administrador la apruebe.</p>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Nombre completo</label>
              <input className="input" placeholder="Dr. Juan Pérez" value={form.fullName} onChange={set('fullName')} required />
            </div>
            <div>
              <label className="label">Correo electrónico</label>
              <input type="email" className="input" placeholder="usuario@tribunal.gob.ar" value={form.email} onChange={set('email')} required />
            </div>
            <div>
              <label className="label">Contraseña</label>
              <input type="password" className="input" placeholder="Mínimo 8 caracteres" value={form.password} onChange={set('password')} required />
            </div>
            <div>
              <label className="label">Confirmar contraseña</label>
              <input type="password" className="input" placeholder="Repetir contraseña" value={form.confirm} onChange={set('confirm')} required />
            </div>

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center mt-2">
              {loading ? (
                <><span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Registrando...</>
              ) : 'Solicitar acceso'}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-gray-500">
            ¿Ya tenés cuenta?{' '}
            <Link to="/login" className="text-navy-700 font-medium hover:underline">Iniciar sesión</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
