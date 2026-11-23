// Small inline SVG icon set. Stroke uses currentColor so icons inherit the
// surrounding text/accent color.

type P = { size?: number };
const base = (size: number) => ({
  width: size, height: size, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
});

export const LogoMark = ({ size = 24 }: P) => (
  <svg width={size} height={size} viewBox="60 100 392 312" fill="none" stroke="currentColor"
    strokeWidth={40} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M104 176 L204 256 L104 336" /><path d="M318 340 V150 L408 180" />
    <ellipse cx="282" cy="344" rx="48" ry="38" transform="rotate(-18 282 344)" fill="currentColor" stroke="none" />
  </svg>
);
export const HomeIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
);
export const CompassIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M16 8l-2.5 5.5L8 16l2.5-5.5L16 8z" /></svg>
);
export const GenreIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1-.6-1.4V4a1 1 0 0 1 1-1h8.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>
);
export const ChartIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>
);
export const MoonIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
);
export const DownloadIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></svg>
);

export const ArtistIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5S20 17 20 21" /></svg>
);

export const LogoutIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" /><path d="M10 12H3" /><path d="m6 8-4 4 4 4" /></svg>
);

// Buffering/loading spinner. The .spin CSS animation rotates it.
export const Spinner = ({ size = 20 }: P) => (
  <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" opacity="0.9" />
  </svg>
);

export const AlbumIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.2" /></svg>
);

// Beamed pair of notes: the top-level "Music" place.
export const MusicIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M9 18V5l11-2v13" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="16" r="2.5" />
  </svg>
);

export const BookIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H11v16H5.5A1.5 1.5 0 0 0 4 20.5V4.5Z" /><path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H13v16h5.5A1.5 1.5 0 0 1 20 20.5V4.5Z" /></svg>
);

export const RadioIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="14" r="2.6" /><path d="M8.5 10.5a5 5 0 0 1 7 0" /><path d="M6 8a8.5 8.5 0 0 1 12 0" /></svg>
);

export const PodcastIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v4" /><path d="M9 21h6" /></svg>
);

export const SearchIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
);

export const PlaylistIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M4 7h11M4 12h11M4 17h7" /><circle cx="18" cy="16" r="2.5" /><path d="M20.5 16V9.5" /></svg>
);

export const PlayIcon = ({ size = 18 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z" /></svg>
);

export const PauseIcon = ({ size = 18 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none"><rect x="7" y="5" width="3.2" height="14" rx="1" /><rect x="13.8" y="5" width="3.2" height="14" rx="1" /></svg>
);

export const PrevIcon = ({ size = 18 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none"><path d="M7 6v12h2V6z" /><path d="M19 6 10 12l9 6z" /></svg>
);

export const NextIcon = ({ size = 18 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none"><path d="M15 6v12h2V6z" /><path d="M5 6l9 6-9 6z" /></svg>
);

export const TrashIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
);

export const EditIcon = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);

export const RequestIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M3 7l9 6 9-6" /><rect x="3" y="5" width="18" height="14" rx="2" /></svg>
);

export const VizIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M3 12h3l2-7 4 14 2-7 1 3h6" /></svg>
);

export const QueueIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M4 6h11M4 12h11M4 18h7" /><path d="M17 13v8l5-4z" fill="currentColor" stroke="none" /></svg>
);

export const LyricsIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M5 5h14M5 10h10M5 15h12M5 19h7" /></svg>
);

export const BellIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
);

export const GearIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

export const FullscreenIcon = ({ size = 18, exit = false }: P & { exit?: boolean }) => (
  exit
    ? <svg {...base(size)}><path d="M9 3v6H3" /><path d="M15 3v6h6" /><path d="M9 21v-6H3" /><path d="M15 21v-6h6" /></svg>
    : <svg {...base(size)}><path d="M3 9V3h6" /><path d="M21 9V3h-6" /><path d="M3 15v6h6" /><path d="M21 15v6h-6" /></svg>
);
export const ChevronDownIcon = ({ size = 22 }: P) => (
  <svg {...base(size)}><path d="m6 9 6 6 6-6" /></svg>
);

export const VolumeIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /></svg>
);

export const ShuffleIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></svg>
);

export const RepeatIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
);

export const RepeatOneIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
    <text x="12" y="14.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor" stroke="none">1</text>
  </svg>
);

// Cast / "Connect to a device": a screen with broadcast waves in the corner.
export const DevicesIcon = ({ size = 18, active = false }: P & { active?: boolean }) => (
  <svg {...base(size)}>
    <rect x="3" y="4.5" width="18" height="12" rx="2" />
    <path d="M3 19.5a4 4 0 0 1 4 4" />
    <path d="M3 16a7.5 7.5 0 0 1 7.5 7.5" opacity={active ? 1 : 0.55} />
    <circle cx="3.6" cy="23.1" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const HeartIcon = ({ size = 18, filled = false }: P & { filled?: boolean }) => (
  <svg {...base(size)} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20s-7-4.5-9.2-9C1.3 8 2.8 5 6 5c2 0 3.2 1.2 4 2.3C10.8 6.2 12 5 14 5c3.2 0 4.7 3 3.2 6-2.2 4.5-9.2 9-9.2 9z" transform="translate(-0 0)" />
  </svg>
);

export const SessionsIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <circle cx="9" cy="7.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3 3 0 0 1 0 5.6" />
    <path d="M17.5 13.6a5.5 5.5 0 0 1 3 5.4" />
  </svg>
);

export const StarIcon = ({ size = 18, filled = false }: P & { filled?: boolean }) => (
  <svg {...base(size)} fill={filled ? "currentColor" : "none"}>
    <path d="M12 3.6l2.55 5.17 5.7.83-4.13 4.02.98 5.68L12 16.6l-5.1 2.68.98-5.68L3.75 9.6l5.7-.83L12 3.6z" />
  </svg>
);
