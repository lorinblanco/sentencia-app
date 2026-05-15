import { useAuth } from '../contexts/AuthContext'

export default function Pending() {
  const { signOut, profile } = useAuth()
  return (
    <div className="min-h-screen flex items-center justify-center bg-navy-900 px-4">
      <div className="max-w-md text-center space-y-6">
        <div className="inline-flex items-center gap-3">
          <div className="w-12 h-12 bg-gold-500 rounded-xl flex items-center justify-center text-white font-bold text-xl font-serif">S</div>
          <span className="text-white text-3xl font-semibold tracking-tight">Sentenc<span className="text-gold-400">IA</span></span>
        </div>
        <div className="bg-white rounded-2xl p-8 shadow-xl">
          <div className="text-4xl mb-4">⏳</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Cuenta pendiente de aprobación</h2>
          <p className="text-gray-500 text-sm leading-relaxed">
            Tu solicitud fue registrada correctamente. El administrador del sistema revisará tu cuenta y la habilitará a la brevedad.
            Te notificarán cuando puedas acceder.
          </p>
          {profile?.email && (
            <p className="mt-3 text-xs text-gray-400">Cuenta registrada: <strong>{profile.email}</strong></p>
          )}
          <button onClick={signOut} className="mt-6 btn-secondary w-full justify-center">
            Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  )
}
