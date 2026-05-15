import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

const Logo = () => (
  <div className="flex items-center gap-2.5">
    <div className="w-8 h-8 bg-gold-500 rounded-lg flex items-center justify-center text-white font-bold text-sm font-serif">S</div>
    <span className="font-semibold text-navy-900 text-base tracking-tight">Sentenc<span className="text-gold-500">IA</span></span>
  </div>
)

function NavItem({ to, icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-navy-700 text-white'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        }`
      }
    >
      <span className="text-base">{icon}</span>
      <span>{label}</span>
    </NavLink>
  )
}

export default function Layout() {
  const { profile, isAdmin, signOut } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-gray-100">
          <Logo />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <NavItem to="/" icon="🏠" label="Inicio" end />
          <NavItem to="/nueva" icon="✨" label="Nueva sentencia" />
          <NavItem to="/historial" icon="📂" label="Historial" />
          <NavItem to="/perfil" icon="⚙️" label="Mi perfil & API key" />

          {isAdmin && (
            <>
              <div className="pt-4 pb-1">
                <p className="px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Administración</p>
              </div>
              <NavItem to="/admin/usuarios" icon="👥" label="Usuarios" />
              <NavItem to="/admin/plantillas" icon="📄" label="Plantillas" />
              <NavItem to="/admin/configuracion" icon="🔧" label="Configuración" />
            </>
          )}
        </nav>

        {/* User footer */}
        <div className="border-t border-gray-100 p-3">
          <div className="flex items-center gap-2.5 px-1">
            <div className="w-8 h-8 rounded-full bg-navy-700 text-white flex items-center justify-center text-xs font-semibold flex-shrink-0">
              {profile?.full_name?.[0] || profile?.email?.[0] || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-800 truncate">{profile?.full_name || 'Usuario'}</p>
              <p className="text-xs text-gray-400 truncate">{profile?.email}</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="mt-2 w-full text-left px-3 py-2 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
          >
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 overflow-hidden">
        <div className="h-full overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
