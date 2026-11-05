// Icons of the canvas chrome (toolbar, header, tabs). Same drawing style as
// project/icons.tsx: 16-unit view box, stroke = currentColor.
import type { ReactNode } from 'react';

function Svg({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CIcon = {
  zoomIn: (
    <Svg>
      <path d="M8 3v10 M3 8h10" />
    </Svg>
  ),
  zoomOut: (
    <Svg>
      <path d="M3 8h10" />
    </Svg>
  ),
  fit: (
    <Svg>
      <path d="M2 6V2h4 M10 2h4v4 M14 10v4h-4 M6 14H2v-4" />
      <rect x="5.5" y="5.5" width="5" height="5" strokeWidth="1.1" />
    </Svg>
  ),
  caret: (
    <Svg size={10}>
      <path d="M4 6l4 4 4-4" strokeWidth="1.6" />
    </Svg>
  ),
  help: (
    <Svg>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.5" />
      <circle cx="8" cy="11.6" r=".35" fill="currentColor" />
    </Svg>
  ),
  back: (
    <Svg>
      <path d="M13 8H3 M7 4L3 8l4 4" />
    </Svg>
  ),
  note: (
    <Svg>
      <path d="M2.5 2.5h11v7l-4 4h-7z M9.5 13.5v-4h4" />
    </Svg>
  ),
  block: (
    <Svg>
      <rect x="3.5" y="3" width="9" height="10" />
      <path d="M3.5 5.8h9 M1 8.5h2.5 M12.5 8.5H15" />
    </Svg>
  ),
  step: (
    <Svg>
      <rect x="3" y="3.5" width="10" height="9" />
    </Svg>
  ),
  insert: (
    <Svg>
      <path d="M8 1.5v3 M8 11.5v3 M4.5 8h7" />
      <rect x="4.5" y="4.5" width="7" height="7" strokeDasharray="1.6 1.4" />
    </Svg>
  ),
  arrange: (
    <Svg>
      <rect x="2" y="2.5" width="5" height="4" />
      <rect x="9" y="9.5" width="5" height="4" />
      <path d="M2 11.5h4 M10 4.5h4" />
    </Svg>
  ),
  view: (
    <Svg>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  ),
  more: (
    <Svg>
      <circle cx="3.5" cy="8" r=".6" fill="currentColor" />
      <circle cx="8" cy="8" r=".6" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".6" fill="currentColor" />
    </Svg>
  ),
  plus: (
    <Svg size={12}>
      <path d="M8 3v10 M3 8h10" strokeWidth="1.6" />
    </Svg>
  ),
  close: (
    <Svg size={12}>
      <path d="M4 4l8 8 M12 4l-8 8" strokeWidth="1.6" />
    </Svg>
  ),
  doc: (
    <Svg size={13}>
      <path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3 M5.5 8h5 M5.5 10.5h5" />
    </Svg>
  ),
};
