// Hand-drawn icon set: 20x20, 1.5 stroke, round joins.
import type { ReactNode } from 'react';

const I = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icons = {
  switch: () => (
    <I><rect x="3" y="6.5" width="14" height="7" rx="3.5" /><circle cx="13.5" cy="10" r="2" fill="currentColor" stroke="none" /></I>
  ),
  torch: () => (
    <I><circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" /></I>
  ),
  paint: () => (
    <I><path d="M12.8 3.6 16.4 7.2 9.4 14.2 5.8 10.6z" /><path d="M5.8 10.6c-2 .4-2.6 2.2-2.6 4.6 2.4 0 4.2-.6 4.6-2.6" /></I>
  ),
  trail: () => (
    <I><path d="M3 13c2.5 0 3-6 6-6s3 6 6 6" /><circle cx="15.5" cy="13" r="1.6" fill="currentColor" stroke="none" /><circle cx="3" cy="13" r=".6" fill="currentColor" stroke="none" /></I>
  ),
  route: () => (
    <I><path d="M4 16c0-4 4-3 6-6s0-6 6-6" strokeDasharray="1.6 2.4" /><circle cx="4" cy="16" r="1.6" /><circle cx="16" cy="4" r="1.6" fill="currentColor" stroke="none" /></I>
  ),
  sweep: () => (
    <I><path d="M3 15 8 5M7.5 15l5-10M12 15l5-10" /></I>
  ),
  breathe: () => (
    <I><path d="M2.5 10c1.9-4.5 3.8-4.5 5 0s3.1 4.5 5 0 3.1-4.5 5 0" /></I>
  ),
  flicker: () => (
    <I><path d="M11 2.5 5.5 11h4l-1 6.5L14.5 9h-4z" /></I>
  ),
  dusk: () => (
    <I><path d="M14.5 12.2A6 6 0 1 1 7.8 5.5a4.8 4.8 0 0 0 6.7 6.7z" /><path d="M14 3.5v2M13 4.5h2" /></I>
  ),
  play: () => <I><path d="M6.5 4.5v11l9-5.5z" fill="currentColor" /></I>,
  pause: () => <I><path d="M6.5 4.5v11M13.5 4.5v11" strokeWidth={2.2} /></I>,
  scenes: () => (
    <I><rect x="3" y="6" width="11" height="9" rx="1.5" /><path d="M6 3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v7.5" /></I>
  ),
  plus: () => <I><path d="M10 4v12M4 10h12" /></I>,
  gear: () => (
    <I><path d="M3.5 6h7M14 6h2.5M3.5 14h2.5M9.5 14h7" /><circle cx="12.2" cy="6" r="1.7" /><circle cx="7.8" cy="14" r="1.7" /></I>
  ),
  eye: () => (
    <I><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" /><circle cx="4.5" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="6" cy="14.5" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="13.5" r="1" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="4" strokeDasharray="1.5 2" /></I>
  ),
  record: () => <I><circle cx="10" cy="10" r="4.2" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="7" /></I>,
  stop: () => <I><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" /></I>,
  expand: () => <I><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" /></I>,
  sunUp: () => (
    <I><path d="M5 14a5 5 0 0 1 10 0" /><path d="M10 3.5v2.5M3.8 7.6l1.6 1.4M16.2 7.6l-1.6 1.4M2.5 16.5h15" /></I>
  ),
  moonDown: () => <I><path d="M5 14a5 5 0 0 1 10 0" /><path d="M2.5 16.5h15" /></I>,
  download: () => <I><path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12" /></I>,
  upload: () => <I><path d="M10 13V4M6 8l4-4 4 4M4 16.5h12" /></I>,
  close: () => <I><path d="M5 5l10 10M15 5 5 15" /></I>,
  check: () => <I><path d="M4.5 10.5 8 14l7.5-8" /></I>,
  trash: () => <I><path d="M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10" /></I>,
  spark: () => (
    <I><path d="M10 3c.6 3.6 1.4 4.4 5 5-3.6.6-4.4 1.4-5 5-.6-3.6-1.4-4.4-5-5 3.6-.6 4.4-1.4 5-5z" /><path d="M15.5 13.5c.2 1.1.5 1.4 1.5 1.5-1 .2-1.3.5-1.5 1.5-.2-1-.5-1.3-1.5-1.5 1-.1 1.3-.4 1.5-1.5z" /></I>
  ),
  grid: () => <I><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></I>,
  camera: () => <I><path d="M3.5 7h3l1.5-2h4l1.5 2h3v8.5h-13z" /><circle cx="10" cy="11" r="2.5" /></I>,
  help: () => <I><circle cx="10" cy="10" r="7" /><path d="M8 8a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.4" /><circle cx="10" cy="13.8" r=".6" fill="currentColor" stroke="none" /></I>,
  key: () => <I><circle cx="7" cy="10" r="3" /><path d="M10 10h7M14.5 10v2.5M16.5 10v2" /></I>,
};

export type IconName = keyof typeof Icons;

export function Icon({ name }: { name: IconName }) {
  const C = Icons[name];
  return <C />;
}
