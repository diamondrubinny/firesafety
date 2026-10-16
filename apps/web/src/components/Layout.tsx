import { Link, NavLink, Outlet } from 'react-router-dom';
import { ROLE_LABELS_HE } from '@firesafety/shared';
import { useAuth } from '../lib/auth';
import { SystemBanner } from './SystemBanner';

export function Layout() {
  const { me, hasRole, logout } = useAuth();
  return (
    <>
      <a href="#main" className="skip-link">
        דילוג לתוכן הראשי
      </a>
      <header className="site-header">
        <div className="brand">ניטור בטיחות אש</div>
        <nav aria-label="ניווט ראשי">
          <ul>
            <li><NavLink to="/" end>אירועים פעילים</NavLink></li>
            <li><NavLink to="/history">היסטוריה</NavLink></li>
            <li><NavLink to="/buildings">מבנים</NavLink></li>
            {hasRole('SafetyOfficer', 'FireAdmin') && <li><NavLink to="/reports">דוחות</NavLink></li>}
            {hasRole('FireAdmin') && (
              <>
                <li><NavLink to="/admin/buildings">ניהול מבנים</NavLink></li>
                <li><NavLink to="/admin/collectors">Collectors</NavLink></li>
                <li><NavLink to="/admin/points">רכזות ונקודות</NavLink></li>
                <li><NavLink to="/admin/users">משתמשים והרשאות</NavLink></li>
                <li><NavLink to="/admin/procedures">נהלים</NavLink></li>
                <li><NavLink to="/admin/settings/notifications">הגדרות התראות</NavLink></li>
                <li><NavLink to="/admin/audit">יומן פעולות</NavLink></li>
              </>
            )}
          </ul>
        </nav>
        {me && (
          <div className="user-box">
            <span>
              {me.displayName}
              <span className="muted"> ({me.roles.map((r) => ROLE_LABELS_HE[r]).join(', ')})</span>
            </span>
            <Link to="/me/notifications" className="btn btn-small">ההתראות שלי</Link>
            <button type="button" className="btn btn-small" onClick={() => void logout()}>
              התנתקות
            </button>
          </div>
        )}
      </header>
      <div className="disclaimer" role="note">
        מערכת משלימה לניטור בלבד. היא אינה מחליפה את רכזות האש, את לוחות ההפעלה, את המוקד ואת נהלי החירום.
      </div>
      {me && <SystemBanner />}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <nav aria-label="קישורי מידע">
        <ul>
          <li><NavLink to="/accessibility">הצהרת נגישות</NavLink></li>
          <li><NavLink to="/privacy">מדיניות פרטיות</NavLink></li>
          <li><NavLink to="/privacy#cookies">הגדרות פרטיות ועוגיות</NavLink></li>
        </ul>
      </nav>
    </footer>
  );
}
