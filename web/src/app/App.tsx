import type { ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { IconActivities, IconDevices, IconHistory, IconSettings, IconToday, Mark } from './icons';
import { Link, navigate, useMeta, usePath } from './router';
import { boot, useApp } from './store';
import { Spinner, SyncLine } from './ui';
import { Landing } from './screens/Landing';
import { Recover, SignIn, SignUp, Unlock } from './screens/Auth';
import { Welcome } from './screens/Welcome';
import { Today } from './screens/Today';
import { CheckInFlow } from './screens/CheckIn';
import { CheckInDetail, History } from './screens/History';
import { Activities, ActivityRun, SessionRun } from './screens/Activities';
import { Devices } from './screens/Devices';
import { Settings } from './screens/Settings';
import { NotFound } from './screens/NotFound';

const PulseLab = lazy(() => import('./screens/PulseLab').then((m) => ({ default: m.PulseLab })));
const HowItWorks = lazy(() => import('./screens/HowItWorks').then((m) => ({ default: m.HowItWorks })));

const TABS = [
  { href: '/', label: 'Today', Icon: IconToday },
  { href: '/history', label: 'History', Icon: IconHistory },
  { href: '/activities', label: 'Activities', Icon: IconActivities },
  { href: '/devices', label: 'Devices', Icon: IconDevices },
  { href: '/settings', label: 'Settings', Icon: IconSettings },
];
const tabOf = (path: string) => (path === '/' ? '/' : TABS.find((t) => t.href !== '/' && path.startsWith(t.href))?.href ?? null);

function Toast() {
  const { toast } = useApp();
  return <div class="toast-region" role="status" aria-live="polite">{toast && <p class="toast" key={toast.id}>{toast.text}</p>}</div>;
}

/** Signed in: bottom tabs on phones, a left rail from 900 px. */
function TabShell({ path, children }: { path: string; children: ComponentChildren }) {
  const s = useApp();
  const active = tabOf(path);
  const me = s.auth.state === 'in' ? s.auth.me : null;
  return (
    <div class="shell">
      <a class="skip" href="#main">Skip to content</a>
      <aside class="rail" aria-label="SafeSpace">
        <Link href="/" class="brand"><Mark /><span>SafeSpace</span></Link>
        <nav aria-label="Main">
          <ul>
            {TABS.map(({ href, label, Icon }) => (
              <li><Link href={href} class="rail-link" aria-current={active === href ? 'page' : undefined}><Icon />{label}</Link></li>
            ))}
          </ul>
        </nav>
        <div class="rail-foot">
          <SyncLine s={s.sync} signedIn={!!me} />
          {me && <p class="rail-user">{me.user.email}</p>}
        </div>
      </aside>
      <main id="main" class="main" tabIndex={-1}>{children}</main>
      <nav class="tabbar" aria-label="Main">
        {TABS.map(({ href, label, Icon }) => (
          <Link href={href} class="tab" aria-current={active === href ? 'page' : undefined}><Icon /><span>{label}</span></Link>
        ))}
      </nav>
      <Toast />
    </div>
  );
}

/** Signed out, and full-screen flows: a slim top bar and one column. */
export function PublicShell({ children, wide = false, bar = true }: { children: ComponentChildren; wide?: boolean; bar?: boolean }) {
  const s = useApp();
  return (
    <div class={`public ${wide ? 'wide' : ''}`}>
      <a class="skip" href="#main">Skip to content</a>
      {bar && (
        <header class="topbar">
          <Link href="/" class="brand"><Mark /><span>SafeSpace</span></Link>
          <nav aria-label="Account" class="topbar-nav">
            <Link href="/how-it-works" class="hide-sm">How it works</Link>
            {s.auth.state === 'in' ? <Link href="/" class="btn small secondary">Open app</Link>
              : location.pathname === '/signin' ? <Link href="/signup" class="btn small secondary">Create an account</Link>
              : <Link href="/signin" class="btn small secondary">Sign in</Link>}
          </nav>
        </header>
      )}
      <main id="main" class="public-main" tabIndex={-1}>{children}</main>
      <Toast />
    </div>
  );
}

function Loading() {
  return <div class="splash"><Mark size={36} /><Spinner /></div>;
}

const TITLES: Record<string, string> = {
  '/': 'SafeSpace: a stress check-in you can take with your phone',
  '/signin': 'Sign in · SafeSpace', '/signup': 'Create an account · SafeSpace', '/recover': 'Recover your account · SafeSpace',
  '/welcome': 'Welcome · SafeSpace', '/check-in': 'Check-in · SafeSpace', '/baseline': 'Baseline reading · SafeSpace',
  '/history': 'History · SafeSpace', '/activities': 'Activities · SafeSpace', '/devices': 'Devices · SafeSpace',
  '/settings': 'Settings · SafeSpace', '/lab/pulse': 'Pulse accuracy check · SafeSpace', '/how-it-works': 'How SafeSpace works: four signals, one pen each',
};

export function App() {
  const path = usePath();
  const s = useApp();
  useEffect(() => { void boot(); }, []);
  const known = TITLES[path] ?? (path.startsWith('/history/') ? 'Check-in · SafeSpace' : path.startsWith('/activities/') ? 'Activity · SafeSpace' : 'Not found · SafeSpace');
  useMeta(s.auth.state === 'in' && path === '/' ? 'Today · SafeSpace' : known, path);

  const auth = s.auth.state;
  if (path === '/how-it-works') return <Suspense fallback={<Loading />}><HowItWorks /></Suspense>;
  if (path === '/lab/pulse') return <Suspense fallback={<Loading />}><PulseLab /></Suspense>;
  if (auth === 'loading') return <Loading />;
  if (auth === 'locked') return <PublicShell><Unlock /></PublicShell>;

  const inApp = auth === 'in';
  const needIn = (el: ComponentChildren) => {
    if (inApp) return el;
    queueMicrotask(() => navigate(`/signin?next=${encodeURIComponent(path)}`, { replace: true }));
    return <Loading />;
  };

  switch (true) {
    case path === '/':
      return inApp ? <TabShell path={path}><Today /></TabShell> : <PublicShell wide><Landing /></PublicShell>;
    case path === '/signin': return inApp ? redirect('/') : <PublicShell><SignIn /></PublicShell>;
    case path === '/signup': return inApp && !s.recoveryKey ? redirect('/') : <PublicShell><SignUp /></PublicShell>;
    case path === '/recover': return inApp ? redirect('/') : <PublicShell><Recover /></PublicShell>;
    case path === '/welcome': return needIn(<PublicShell bar={false}><Welcome /></PublicShell>);
    case path === '/check-in': return <div class="flow-shell"><main id="main"><CheckInFlow mode="checkin" /></main><Toast /></div>;
    case path === '/baseline': return needIn(<div class="flow-shell"><main id="main"><CheckInFlow mode="baseline" /></main><Toast /></div>);
    case path === '/history': return needIn(<TabShell path={path}><History /></TabShell>);
    case path.startsWith('/history/'): return needIn(<TabShell path={path}><CheckInDetail id={decodeURIComponent(path.slice(9))} /></TabShell>);
    case path === '/activities':
      return inApp ? <TabShell path={path}><Activities /></TabShell> : <PublicShell><Activities /></PublicShell>;
    case path === '/activities/session':
      return <div class="flow-shell"><main id="main"><SessionRun /></main><Toast /></div>;
    case path.startsWith('/activities/'):
      return <div class="flow-shell"><main id="main"><ActivityRun id={path.slice(12)} /></main><Toast /></div>;
    case path === '/devices':
      return inApp ? <TabShell path={path}><Devices /></TabShell> : <PublicShell><Devices /></PublicShell>;
    case path === '/settings': return needIn(<TabShell path={path}><Settings /></TabShell>);
    default:
      return inApp ? <TabShell path={path}><NotFound /></TabShell> : <PublicShell><NotFound /></PublicShell>;
  }
}

function redirect(to: string) {
  queueMicrotask(() => navigate(to, { replace: true }));
  return <Loading />;
}
