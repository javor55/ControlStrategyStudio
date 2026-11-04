// Tiny inline icons for the left panel (stroke = currentColor, 14 px).
import type { ReactNode } from 'react';

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  chevron: (open: boolean) => (
    <Svg size={12}>
      <path d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
    </Svg>
  ),
  folder: (
    <Svg>
      <path d="M1.5 4.5v8h13v-7H7.5L6 4H1.5z" />
    </Svg>
  ),
  strategy: (
    <Svg>
      <rect x="1.5" y="3" width="5" height="4" />
      <rect x="9.5" y="9" width="5" height="4" />
      <path d="M6.5 5H8v6h1.5" />
    </Svg>
  ),
  /** SFC: two steps (the first one initial) joined by a transition bar. */
  sequence: (
    <Svg>
      <rect x="4.5" y="1" width="7" height="4.5" />
      <rect x="5.7" y="2.1" width="4.6" height="2.3" strokeWidth="0.9" />
      <path d="M8 5.5v5 M5.5 8h5" />
      <rect x="4.5" y="10.5" width="7" height="4.5" />
    </Svg>
  ),
  doc: (
    <Svg>
      <path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3 M5.5 8h5 M5.5 10.5h5" />
    </Svg>
  ),
  project: (
    <Svg>
      <path d="M2 2.5h12v11H2z M2 5.5h12 M5 8.5h6 M5 11h4" />
    </Svg>
  ),
  library: (
    <Svg>
      <path d="M2.5 2v12 M5.5 2v12 M8.5 2.5l3.5 11.2" />
    </Svg>
  ),
  type: (
    <Svg>
      <rect x="3" y="2.5" width="10" height="11" />
      <path d="M3 5.5h10 M1 8h2 M1 11h2 M13 8h2" />
    </Svg>
  ),
  composite: (
    <Svg>
      <rect x="2" y="2" width="12" height="12" />
      <rect x="4" y="5" width="3" height="3" />
      <rect x="9" y="8" width="3" height="3" />
      <path d="M7 6.5h1v3h1" />
    </Svg>
  ),
  image: (
    <Svg>
      <rect x="1.5" y="2.5" width="13" height="11" />
      <circle cx="5.5" cy="6" r="1.2" />
      <path d="M1.5 12l4-4 3 3 2-2 4 4" />
    </Svg>
  ),
  plus: (
    <Svg size={12}>
      <path d="M8 3v10 M3 8h10" />
    </Svg>
  ),
  more: (
    <Svg size={12}>
      <circle cx="3.5" cy="8" r=".6" fill="currentColor" />
      <circle cx="8" cy="8" r=".6" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".6" fill="currentColor" />
    </Svg>
  ),
  newFolder: (
    <Svg size={13}>
      <path d="M1.5 4.5v8h13v-7H7.5L6 4H1.5z M8 7.5v4 M6 9.5h4" />
    </Svg>
  ),
  newFile: (
    <Svg size={13}>
      <path d="M3.5 1.5h6l3 3v10h-9z M8 7v5 M5.5 9.5h5" />
    </Svg>
  ),
  upload: (
    <Svg size={13}>
      <path d="M8 11V2.5 M4.5 6L8 2.5 11.5 6 M2 11v3h12v-3" />
    </Svg>
  ),
  search: (
    <Svg size={13}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  ),
};
