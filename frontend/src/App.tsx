import { Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { Activity, FolderGit2, Settings, TerminalSquare, LogOut, BarChart3 } from 'lucide-react';
import './AppLayout.css';

import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import FixDetails from './pages/FixDetails';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AnalyticsPage from './pages/AnalyticsPage';

// ── Auth Guard ───────────────────────────────────────────────────────────────
function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('neurodeploy_token');
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// ── App Shell (sidebar + header) ─────────────────────────────────────────────
function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { path: '/', label: 'Dashboard', icon: Activity },
    { path: '/projects', label: 'Projects', icon: FolderGit2 },
    { path: '/fixes', label: 'Fix Jobs', icon: TerminalSquare },
    { path: '/analytics', label: 'Analytics', icon: BarChart3 },
    { path: '/settings', label: 'Settings', icon: Settings },
  ];

  const handleLogout = () => {
    localStorage.removeItem('neurodeploy_token');
    navigate('/login');
  };

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-box"></div>
          <span className="logo-text">NeuroDeploy</span>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.path ||
              (item.path !== '/' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`nav-item ${isActive ? 'active' : ''}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <button className="nav-item logout-btn" onClick={handleLogout}>
          <LogOut size={18} />
          <span>Logout</span>
        </button>
      </aside>

      <main className="main-content">
        <header className="top-header">
          <div className="header-breadcrumbs">
            {location.pathname === '/' ? 'Dashboard' : location.pathname.split('/')[1]}
          </div>
          <div className="header-actions">
            <div className="user-avatar">ND</div>
          </div>
        </header>

        <div className="page-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/fixes" element={<FixDetails />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

// ── Root App ─────────────────────────────────────────────────────────────────
function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default App;
