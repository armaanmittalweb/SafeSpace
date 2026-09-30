// Line icons drawn for SafeSpace: 24-unit grid, 1.6 stroke, round joins, currentColor.
import type { JSX, SVGAttributes } from 'preact';

type P = { size?: number } & SVGAttributes<SVGSVGElement>;
const Svg = ({ size = 24, children, ...rest }: P & { children: JSX.Element | JSX.Element[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" {...rest}>{children}</svg>
);

export const IconToday = (p: P) => <Svg {...p}><path d="M2.5 13h4l2-5.5 3.5 10 2.5-7 1.5 2.5h5.5" /></Svg>;
export const IconHistory = (p: P) => <Svg {...p}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" /><path d="M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 16.5h2M11 16.5h2" /></Svg>;
export const IconActivities = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></Svg>;
export const IconDevices = (p: P) => <Svg {...p}><rect x="7" y="6.5" width="10" height="11" rx="2.5" /><path d="M9 6.5 9.6 3h4.8l.6 3.5M9 17.5l.6 3.5h4.8l.6-3.5" /><path d="M9.5 12h1.2l.8-1.8 1.2 3.4.8-1.6h1" /></Svg>;
export const IconSettings = (p: P) => <Svg {...p}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>;
export const IconBack = (p: P) => <Svg {...p}><path d="M14.5 5.5 8 12l6.5 6.5" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconChevron = (p: P) => <Svg {...p}><path d="M9.5 5.5 16 12l-6.5 6.5" /></Svg>;
export const IconCamera = (p: P) => <Svg {...p}><rect x="3" y="6.5" width="18" height="13" rx="2.5" /><path d="M8.5 6.5 10 4h4l1.5 2.5" /><circle cx="12" cy="13" r="3.5" /></Svg>;
export const IconStrap = (p: P) => <Svg {...p}><path d="M2.5 12c3-2.5 6-3.5 9.5-3.5s6.5 1 9.5 3.5" /><rect x="8.5" y="9.5" width="7" height="5" rx="1.5" /><path d="M2.5 12c3 2.5 6 3.5 9.5 3.5" opacity=".5" /></Svg>;
export const IconFile = (p: P) => <Svg {...p}><path d="M6.5 3h7l4 4v14h-11z" /><path d="M13.5 3v4h4M9 12.5h6M9 16h6" /></Svg>;
export const IconFeel = (p: P) => <Svg {...p}><path d="M4 18h16" /><path d="M6 18v-3M9.5 18v-6M13 18v-9M16.5 18v-5" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const IconCloud = (p: P) => <Svg {...p}><path d="M7 18.5h10a4 4 0 0 0 .5-8A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z" /></Svg>;
export const IconOffline = (p: P) => <Svg {...p}><path d="M7 18.5h10a4 4 0 0 0 .5-8A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z" /><path d="M4 4l16 16" /></Svg>;
export const IconDownload = (p: P) => <Svg {...p}><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></Svg>;
export const IconKey = (p: P) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2" /></Svg>;
export const IconLock = (p: P) => <Svg {...p}><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" /></Svg>;
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconInfo = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.2" /></Svg>;

/** The SafeSpace mark: a pen trace across a ruled line (as in the favicon). */
export const Mark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="7" fill="var(--ink)" />
    <path d="M4 16h24" stroke="var(--bg)" stroke-opacity=".3" />
    <path d="M4 20 9 19l3-6 4 9 3-12 3 7 3-2h3" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
);
