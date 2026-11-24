import { useState } from "react";
import { MusicIcon, PlaylistIcon, BookIcon, PodcastIcon, GearIcon, HeartIcon, CompassIcon, LogoMark } from "./icons";
import { MyAvatar } from "./MyAvatar";
import { NotificationsBell } from "./NotificationsBell";
import { AppVersion } from "./desktopUpdate";

export type ViewName = "home" | "artists" | "albums" | "audiobooks" | "radio" | "podcasts" | "album" | "search" | "discover" | "genres" | "genre" | "playlists" | "favorites" | "stats" | "downloads" | "requests" | "lyrics" | "settings" | "account";

// MIME a dragged track carries (see TrackRow). Drop it on a playlist to add it.
export const TRACK_DND = "application/x-lhm-track";

interface Props {
  current: ViewName | "artist" | "audiobook" | "podcast" | "podcastEpisode" | "playlist" | "discoverArtist";
  onNavigate: (v: ViewName) => void;
  isAdmin: boolean;
  username: string;
  onLogout: () => void;
  playlists: { id: number; name: string }[];
  currentPlaylistId?: number;
  onOpenPlaylist: (id: number) => void;
  onAddTrackToPlaylist: (playlistId: number, trackId: number) => void;
}

// A playlist row in the sidebar: navigates on click, and is a drop target for a
// track being dragged from a track list.
function PlaylistNavItem({ pl, active, onOpen, onDropTrack }: {
  pl: { id: number; name: string }; active: boolean;
  onOpen: (id: number) => void; onDropTrack: (playlistId: number, trackId: number) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <button
      className={`nav-item nav-sub${active ? " active" : ""}${over ? " drop-over" : ""}`}
      onClick={() => onOpen(pl.id)}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(TRACK_DND)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = Number(e.dataTransfer.getData(TRACK_DND));
        if (id) onDropTrack(pl.id, id);
      }}
    >
      <span className="nav-icon nav-pl-dot">♪</span>
      <span className="nav-label">{pl.name}</span>
    </button>
  );
}

// Five places. Artists/Albums/Genres/Radio are tabs inside Music, Requests is a tab
// inside Discover, Favorites is pinned inside Playlists, and Downloads/Listening/Lyrics
// live in the account hub. Five is also what a phone's bottom bar holds with labels, so
// MobileNav shows the same list. `short` is the label the bottom bar uses.
export const NAV: { name: ViewName; label: string; short?: string; icon: React.ReactNode }[] = [
  { name: "artists", label: "Music", icon: <MusicIcon /> },
  { name: "podcasts", label: "Podcasts", icon: <PodcastIcon /> },
  { name: "audiobooks", label: "Audiobooks", short: "Books", icon: <BookIcon /> },
  { name: "playlists", label: "Playlists", short: "Lists", icon: <PlaylistIcon /> },
  { name: "discover", label: "Discover", icon: <CompassIcon /> },
];

// Which nav root a view belongs under. Detail views (an album, an artist, a genre)
// and sibling tabs (Albums, Radio) all light up the root they hang off.
export const navRoot = (v: string): ViewName => {
  switch (v) {
    case "home": case "artists": case "albums": case "genres": case "radio":
    case "artist": case "album": case "genre":
      return "artists";                                  // Music
    case "podcasts": case "podcast": case "podcastEpisode":
      return "podcasts";
    case "audiobooks": case "audiobook":
      return "audiobooks";
    case "playlists": case "playlist": case "favorites":
      return "playlists";
    case "discover": case "discoverArtist": case "requests":
      return "discover";
    default:
      return v as ViewName;                              // settings, account, etc.
  }
};

export function Sidebar({ current, onNavigate, isAdmin, username, onLogout, playlists, currentPlaylistId, onOpenPlaylist, onAddTrackToPlaylist }: Props) {
  const active = navRoot(current);
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="logo-mark"><LogoMark /></span>
        <span className="logo-text">localhost<span className="logo-accent">music</span></span>
        <NotificationsBell align="left" />
      </div>

      <nav className="sidebar-nav">
        {/* No "Library" heading: on a self-hosted server everything is your library. */}
        {NAV.map(item => (
          <button
            key={item.name}
            className={`nav-item${active === item.name ? " active" : ""}`}
            onClick={() => onNavigate(item.name)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}

        <p className="nav-heading">Your Playlists</p>
        <div className="nav-playlists">
          {/* Liked Songs is a playlist, so it is pinned here. */}
          <button
            className={`nav-item nav-sub nav-liked${current === "favorites" ? " active" : ""}`}
            onClick={() => onNavigate("favorites")}
          >
            <span className="nav-icon nav-liked-icon"><HeartIcon size={14} /></span>
            <span className="nav-label">Liked Songs</span>
          </button>
          {playlists.map(pl => (
            <PlaylistNavItem
              key={pl.id}
              pl={pl}
              active={currentPlaylistId === pl.id}
              onOpen={onOpenPlaylist}
              onDropTrack={onAddTrackToPlaylist}
            />
          ))}
        </div>

        {isAdmin && (
          <>
            <p className="nav-heading">Admin</p>
            <button
              className={`nav-item${active === "settings" ? " active" : ""}`}
              onClick={() => onNavigate("settings")}
            >
              <span className="nav-icon"><GearIcon /></span>
              <span className="nav-label">Settings</span>
            </button>
          </>
        )}
      </nav>

      <div className="sidebar-foot">
        <button
          className={`sidebar-account${active === "account" ? " active" : ""}`}
          title="Account & preferences"
          onClick={() => onNavigate("account")}
        >
          <MyAvatar username={username} size={30} />
          <span className="sidebar-account-meta">
            <span className="sidebar-user">{username}</span>
            <span className="sidebar-account-sub">Account &amp; quality</span>
          </span>
          <span className="sidebar-account-gear"><GearIcon size={16} /></span>
        </button>
        <button className="link-btn sidebar-signout" onClick={onLogout}>Sign out</button>
        <AppVersion />
      </div>
    </aside>
  );
}
