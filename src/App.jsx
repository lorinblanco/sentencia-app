import { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { supabase, getProfile } from './lib/supabase'
import Auth from './pages/Auth'
import Dashboard from './pages/Dashboard'
import NewSentence from './pages/NewSentence'
import SentenceView from './pages/SentenceView'
import Admin from './pages/Admin'
import Settings from './pages/Settings'

export default function App() {
  const [session, setSession] = useState(undefined)
  const [profile, setProfile] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session))
    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (!session) setProfile(null)
    })
  }, [])

  useEffect(() => {
    if (session?.user) {
      getProfile(session.user.id).then(setProfile)
    }
  }, [session])

  if (session === undefined) return <Splash />

  if (!session) return <Auth />

  if (profile?.role === 'pending') return <PendingApproval />

  return (
    <Routes>
      <Route path="/" element={<Dashboard profile={profile} session={session} />} />
      <Route path="/nueva" element={<NewSentence profile={profile} session={session} />} />
      <Route path="/sentencia/:id" element={<SentenceView profile={profile} />} />
      <Route path="/admin" element={profile?.role === 'admin' ? <Admin profile={profile} /> : <Navigate to="/" />} />
      <Route path="/configuracion" element={<Settings profile={profile} session={session} onUpdate={setProfile} />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}

function Splash() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl mb-3">⚖️</div>
        <div className="text-white text-xl font-semibold">SentencIA</div>
        <div className="mt-4 w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full spinner mx-auto"></div>
      </div>
    </div>
  )
}

function PendingApproval() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
        <div className="text-5xl mb-4">⏳</div>
        <h1 className="text-xl font-semibold text-slate-800 mb-2">Registro pendiente de aprobación</h1>
        <p className="text-slate-500 text-sm leading-relaxed">
          Su solicitud de acceso fue recibida. El administrador del sistema revisará su cuenta 
          y le habilitará el acceso. Recibirá confirmación por correo electrónico.
        </p>
        <button
          onClick={() => supabase.auth.signOut()}
          className="mt-6 text-sm text-slate-400 hover:text-slate-600 underline"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}
