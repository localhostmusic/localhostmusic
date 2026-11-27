import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, onCacheClear, isLibraryMutation } from "./api";
import { LoginPage } from "./auth/LoginPage";
import { PlayerProvider } from "./player/PlayerProvider";
import { PlayBar } from "./player/PlayBar";
import { PresencePrompts } from "./player/PresencePrompts";
import { NowPlaying } from "./player/NowPlaying";
import { LyricsPanel } from "./player/LyricsPanel";
import { QueuePanel } from "./player/QueuePanel";
import { MediaSession } from "./player/MediaSession";
import { StayReachable } from "./player/StayReachable";
import { KeyboardShortcuts } from "./player/KeyboardShortcuts";
import { Sidebar, navRoot, NAV, type ViewName } from "./ui/Sidebar";
import { PageTabs, tabGroupOf, TAB_GROUPS } from "./ui/PageTabs";
import { SearchBar } from "./ui/SearchBar";
import { useTypeToSearch } from "./ui/useTypeToSearch";
import { preloadAlbumColors } from "./ui/artColors";
import { CommandPalette } from "./ui/CommandPalette";
import { useGridNav } from "./ui/useGridNav";
import { MobileNav } from "./ui/MobileNav";
import { MobileTopBar } from "./ui/MobileTopBar";
import { Aurora } from "./ui/Aurora";
import { AdaptiveTheme } from "./ui/AdaptiveTheme";
import { NightcoreOverlay } from "./ui/NightcoreOverlay";
import { NetBadge } from "./ui/NetBadge";
import { UpdatePrompt } from "./ui/desktopUpdate";
import { ContextMenuHost, PLAYLISTS_CHANGED } from "./ui/ContextMenu";
import { SelectionBar, clearSelection } from "./ui/selection";
const DebugPanel = lazy(() => import("./ui/DebugPanel").then(m => ({ default: m.DebugPanel })));
import { dlog } from "./ui/debugLog";
import { startNotificationPolling } from "./ui/notifications";
import { UpdateToast } from "./ui/UpdateToast";
import { Toaster } from "./ui/Toaster";
import { toast } from "./ui/toast";
import { useSwipe } from "./ui/useSwipe";
import { ArtistsPage } from "./library/ArtistsPage";
import { ArtistPage } from "./library/ArtistPage";
const ExternalArtistPage = lazy(() => import("./library/ExternalArtistPage").then(m => ({ default: m.ExternalArtistPage })));
import { AlbumsPage } from "./library/AlbumsPage";
import { AudiobooksPage } from "./library/AudiobooksPage";
const AudiobookPage = lazy(() => import("./library/AudiobookPage").then(m => ({ default: m.AudiobookPage })));
import { RadioPage } from "./radio/RadioPage";
const PodcastsPage = lazy(() => import("./podcasts/PodcastsPage").then(m => ({ default: m.PodcastsPage })));
const PodcastChannelPage = lazy(() => import("./podcasts/PodcastChannelPage").then(m => ({ default: m.PodcastChannelPage })));
const EpisodePage = lazy(() => import("./podcasts/EpisodePage").then(m => ({ default: m.EpisodePage })));
import { AlbumPage } from "./library/AlbumPage";
import { FavoritesPage } from "./library/FavoritesPage";
import { SearchPage } from "./search/SearchPage";
import { HomePage } from "./home/HomePage";
const DiscoverPage = lazy(() => import("./discover/DiscoverPage").then(m => ({ default: m.DiscoverPage })));
import { GenresPage } from "./genres/GenresPage";
import { GenrePage } from "./genres/GenrePage";
const StatsPage = lazy(() => import("./stats/StatsPage").then(m => ({ default: m.StatsPage })));
import { DownloadsPage } from "./downloads/DownloadsPage";
const AccountPage = lazy(() => import("./account/AccountPage").then(m => ({ default: m.AccountPage })));
const LyricsContribPage = lazy(() => import("./lyrics/LyricsContribPage").then(m => ({ default: m.LyricsContribPage })));
import { PlaylistsPage } from "./playlists/PlaylistsPage";
import { PlaylistPage } from "./playlists/PlaylistPage";
const RequestsPage = lazy(() => import("./reports/RequestsPage").then(m => ({ default: m.RequestsPage })));
// Rarely-visited, heavy views load on demand instead of padding the initial bundle.
const SettingsPage = lazy(() => import("./settings/SettingsPage").then(m => ({ default: m.SettingsPage })));
const TVApp = lazy(() => import("./tv/TVApp").then(m => ({ default: m.TVApp })));
import "./App.css";

interface User { id: number; username: string; isAdmin: boolean; }

// Browse pages get the shared header (search bar + tab strip). Detail views are
// excluded: they open with their own hero and back button.
const BROWSE = new Set<string>([
  "home", "artists", "albums", "genres", "radio",     // Music
  "podcasts", "audiobooks",
  "playlists", "favorites",
  "discover", "requests",
  "search",
]);

type View =
  | { name: "home" }
  | { name: "artists" }
  | { name: "artist"; id: number; artistName?: string }
  | { name: "albums" }
  | { name: "audiobooks" }
  | { name: "audiobook"; id: number }
  | { name: "radio" }
  | { name: "podcasts" }
  | { name: "podcast"; id: number }
  | { name: "podcastEpisode"; id: number }
  | { name: "album"; id: number }
  | { name: "search" }
  | { name: "discover" }
  | { name: "genres" }
  | { name: "genre"; genre: string }
  | { name: "favorites" }
  | { name: "stats" }
  | { name: "downloads" }
  | { name: "playlists" }
  | { name: "playlist"; id: number }
  | { name: "discoverArtist"; artistName: string; image?: string }
  | { name: "requests" }
  | { name: "lyrics" }
  | { name: "settings" }
  | { name: "account" };

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  // Navigation history, so you can go back/forward through the trail
  // (artists, artist, album).
  const [hist, setHist] = useState<{ stack: View[]; idx: number }>({ stack: [{ name: "home" }], idx: 0 });
  const [expanded, setExpanded] = useState(false);
  const [rightPanel, setRightPanel] = useState<"none" | "lyrics" | "queue">("none");
  const [panelClosing, setPanelClosing] = useState(false);
  const [playlists, setPlaylists] = useState<{ id: number; name: string }[]>([]);
  // Debug overlay: ?debug=1 turns it on and is remembered, ?debug=0 turns it off.
  const [debugOn] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.has("debug")) { const on = sp.get("debug") !== "0"; localStorage.setItem("lhm-debug", on ? "1" : "0"); return on; }
      return localStorage.getItem("lhm-debug") === "1";
    } catch { return false; }
  });
  // Also turn on the service worker's logging. Re-sent when a new worker takes over.
  // A worker restarted after idling stays quiet until the next reload.
  useEffect(() => {
    if (!debugOn || !("serviceWorker" in navigator)) return;
    const tell = () => navigator.serviceWorker.controller?.postMessage("debugOn");
    tell();
    navigator.serviceWorker.addEventListener("controllerchange", tell);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", tell);
  }, [debugOn]);

  const playerOpenRef = useRef(false);
  playerOpenRef.current = expanded;

  // Poll for in-app notifications once logged in (drives the bell badge).
  useEffect(() => { if (!user) return; return startNotificationPolling(); }, [user]);

  // Playlists live at the app level so the sidebar can list them as drop targets.
  // Refreshed on login, on entering the playlists view, and after any mutation.
  const refreshPlaylists = () => api.getPlaylists().then(setPlaylists).catch(() => {});
  useEffect(() => {
    window.addEventListener(PLAYLISTS_CHANGED, refreshPlaylists);
    return () => window.removeEventListener(PLAYLISTS_CHANGED, refreshPlaylists);
  }, []);

  // Keep-alive views. Hooks must stay above the early returns below.
  const [viewGen, setViewGen] = useState(0); // bumped on a mutation to remount with fresh data
  const aliveRef = useRef<View[]>([]);
  // After a mutation clears the cache, drop the kept pages and remount the current
  // one so it refetches. Form-style views (settings, requests, account) refresh
  // themselves and hold feedback text, so they stay mounted.
  useEffect(() => onCacheClear((url) => {
    if (isLibraryMutation(url)) return;
    aliveRef.current = aliveRef.current.slice(0, 1);
    const cur = aliveRef.current[0];
    if (!cur || !["settings", "requests", "account"].includes(cur.name)) setViewGen(g => g + 1);
    // Keep the sidebar's playlist list in sync with playlist changes made anywhere.
    if (url.startsWith("/api/playlists")) refreshPlaylists();
  }), []);

  // Scroll restoration: each history entry remembers its scroll position, so going
  // back returns to the same spot.
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollPos = useRef<Map<number, number>>(new Map());
  const curIdxRef = useRef(hist.idx);
  const restoringRef = useRef(false);
  const saveScroll = () => {
    const el = contentRef.current;
    if (el) scrollPos.current.set(curIdxRef.current, el.scrollTop);
  };
  // Re-apply the target across frames, since async page content may still be growing.
  const restoreScroll = (idx: number) => {
    const target = scrollPos.current.get(idx) ?? 0;
    restoringRef.current = true;
    let frames = 0;
    const tick = () => {
      if (!restoringRef.current) return;              // user took over
      const el = contentRef.current;
      if (!el) { restoringRef.current = false; return; }
      el.scrollTop = target;
      frames++;
      if (Math.abs(el.scrollTop - target) > 1 && frames < 60) requestAnimationFrame(tick);
      else restoringRef.current = false;
    };
    requestAnimationFrame(tick);
  };
  const cancelRestore = () => { restoringRef.current = false; };
  const onContentScroll = () => {
    if (restoringRef.current) return;                 // ignore our own programmatic scroll
    const el = contentRef.current;
    if (el) scrollPos.current.set(curIdxRef.current, el.scrollTop);
  };
  // Drop positions for entries at/after the new index (a forward push truncates the trail).
  const dropScrollFrom = (idx: number) => {
    for (const k of [...scrollPos.current.keys()]) if (k >= idx) scrollPos.current.delete(k);
  };

  useEffect(() => {
    const cachedUser = (() => {
      try { return JSON.parse(localStorage.getItem("lhm-user") || "null"); } catch { return null; }
    })();
    // A hanging connection never rejects. With a cached session, open on it after a
    // short grace (none when offline). A real answer arriving later still wins.
    const grace = navigator.onLine ? 3000 : 0;
    const slow = cachedUser ? setTimeout(() => setUser(u => (u === undefined ? cachedUser : u)), grace) : undefined;
    api.me()
      .then(u => { setUser(u); try { localStorage.setItem("lhm-user", JSON.stringify(u)); } catch { /* */ } })
      .catch((e: any) => {
        // No HTTP status means the server was unreachable: fall back to the last known
        // session so downloads play offline. A real 401 shows login.
        if (e?.status == null && cachedUser) { setUser(cachedUser); return; }
        setUser(null);
      })
      .finally(() => clearTimeout(slow));
    return () => clearTimeout(slow);
  }, []);

  useEffect(() => { if (user) refreshPlaylists(); }, [user]);

  // Back navigation uses the History API, so OS gestures and the in-app back button
  // share one path. Each navigation pushes an entry tagged with our stack index, and
  // popstate maps it back onto the view stack.
  useEffect(() => {
    window.history.replaceState({ navIdx: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      saveScroll();                                   // remember where we're leaving
      const st = e.state as { navIdx?: number; np?: boolean } | null;
      // The full-screen player is its own history entry: back closes it instead of
      // navigating the page beneath.
      if (playerOpenRef.current && !st?.np) setExpanded(false);
      const i = st && typeof st.navIdx === "number" ? st.navIdx : 0;
      setHist(h => (i >= 0 && i < h.stack.length ? { ...h, idx: i } : h));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // When the view index changes, restore that entry's saved scroll position.
  useLayoutEffect(() => {
    curIdxRef.current = hist.idx;
    const v = hist.stack[hist.idx];
    dlog(`nav ${v.name}${(v as any).id != null ? " #" + (v as any).id : ""} (idx ${hist.idx})`);
    restoreScroll(hist.idx);
  }, [hist.idx]);

  const view = hist.stack[hist.idx];
  // A selection belongs to the page it was made on.
  useEffect(() => { clearSelection(); }, [view]);
  const sameView = (a: View, b: View) => a.name === b.name && (a as any).id === (b as any).id;
  const push = (v: View) => {
    if (sameView(hist.stack[hist.idx], v)) return;
    saveScroll();
    const stack = [...hist.stack.slice(0, hist.idx + 1), v];
    const idx = stack.length - 1;
    dropScrollFrom(idx);
    window.history.pushState({ navIdx: idx }, "");
    setHist({ stack, idx });
  };
  const goBack = () => window.history.back();
  const navigate = (name: ViewName) => {
    if (name === "album") return; // album/artist open with an id, not via the sidebar
    push({ name } as View);
  };

  // The Music nav entry returns to the tab you were last on. The tab strip calls
  // navigate() directly.
  const lastMusicTab = useRef<ViewName>("home");
  useEffect(() => {
    if (TAB_GROUPS.music.some(t => t.name === view.name)) lastMusicTab.current = view.name as ViewName;
  }, [view.name]);
  const navigateRoot = (name: ViewName) =>
    navigate(name === "artists" ? lastMusicTab.current : name);

  // The search query lives here, not in the view stack: a history entry per keystroke
  // would bury the back button. The first character pushes the results view once, and
  // clearing the box goes back.
  const [query, setQuery] = useState("");
  const onQuery = (q: string) => {
    setQuery(q);
    if (q.trim() && view.name !== "search") push({ name: "search" });
    else if (!q.trim() && view.name === "search") goBack();
  };
  // Leaving the results by any route empties the box.
  useEffect(() => { if (view.name !== "search" && query) setQuery(""); }, [view.name]);
  useTypeToSearch(query, onQuery, expanded);
  useGridNav();
  useEffect(() => { if (user) preloadAlbumColors(); }, [user]);
  // Open the full-screen player as its own history entry, so back closes it.
  const openPlayer = () => { setExpanded(true); window.history.pushState({ navIdx: hist.idx, np: true }, ""); };
  const closePlayer = () => {
    if ((window.history.state as { np?: boolean } | null)?.np) window.history.back();
    else setExpanded(false);
  };

  // Swipe left/right pages between the top-level places. Derived from NAV so it
  // matches the bar. Only on the place pages, and only for swipes that start
  // mid-screen (edge swipes are for back/forward).
  const TABS: ViewName[] = NAV.map(n => n.name);
  const swipeTab = (dir: 1 | -1) => {
    if (!BROWSE.has(view.name)) return;   // detail views swipe back/forward, not across
    const i = TABS.indexOf(navRoot(view.name));
    if (i < 0) return;
    const n = i + dir;
    if (n >= 0 && n < TABS.length) navigateRoot(TABS[n]);
  };
  const pageSwipe = useSwipe(
    { onSwipeLeft: () => swipeTab(1), onSwipeRight: () => swipeTab(-1) },
    { threshold: 55, edgeExclude: 32 }
  );

  useEffect(() => { if (view.name === "playlists") refreshPlaylists(); }, [view.name]);

  if (user === undefined) return <div className="loading">Loading…</div>;
  if (!user) return <LoginPage onLogin={() => api.me().then(u => { setUser(u); try { localStorage.setItem("lhm-user", JSON.stringify(u)); } catch { /* */ } })} />;

  // 10-foot TV interface at /tv. Shares the player and Connect channel, so the TV
  // can be controlled from a phone.
  const tvMode = typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/tv";
  if (tvMode) {
    return (
      <PlayerProvider>
        <MediaSession />
        <Suspense fallback={null}>
          <TVApp onExit={() => {
            const b = (window as any).LhmTV;
            if (b?.exit) b.exit();                       // native TV app: close to launcher
            else { window.location.href = "/"; }          // browser: go to the normal app
          }} />
        </Suspense>
      </PlayerProvider>
    );
  }

  const closePanel = () => {
    if (rightPanel === "none" || panelClosing) return;
    setPanelClosing(true);
    window.setTimeout(() => { setRightPanel("none"); setPanelClosing(false); }, 340);
  };
  const togglePanel = (p: "lyrics" | "queue") => {
    if (panelClosing) return;
    if (rightPanel === p) closePanel();
    else setRightPanel(p);
  };

  const openArtist = (id: number, artistName: string) => push({ name: "artist", id, artistName });
  const openAlbum = (id: number) => push({ name: "album", id });
  const openAudiobook = (id: number) => push({ name: "audiobook", id });
  const openPodcast = (id: number) => push({ name: "podcast", id });
  const openEpisode = (id: number) => push({ name: "podcastEpisode", id });
  const openGenre = (genre: string) => push({ name: "genre", genre });
  // Opening the artist from the full-screen player: close it and replace its history
  // entry (the `np` one) with the artist page. closePlayer()'s async history.back()
  // followed by a push races the popstate.
  const navFromPlayer = (v: View) => {
    setExpanded(false);
    saveScroll();
    const stack = [...hist.stack.slice(0, hist.idx + 1), v];
    const idx = stack.length - 1;
    dropScrollFrom(idx);
    window.history.replaceState({ navIdx: idx }, "");
    setHist({ stack, idx });
  };
  const openArtistFromPlayer = (id: number, artistName: string) => navFromPlayer({ name: "artist", id, artistName });
  const openAlbumFromPlayer = (id: number) => navFromPlayer({ name: "album", id });
  const logout = () => api.logout().then(() => { setUser(null); try { localStorage.removeItem("lhm-user"); } catch { /* */ } });

  const showToast = (msg: string) => toast(msg);
  // Drop a dragged track onto a sidebar playlist.
  const addTrackToPlaylist = (playlistId: number, trackId: number) => {
    const pl = playlists.find(p => p.id === playlistId);
    api.addToPlaylist(playlistId, trackId)
      .then(() => showToast(`Added to ${pl?.name ?? "playlist"}`))
      .catch(() => showToast("Couldn’t add to playlist"));
  };

  // Keep-alive views: pages stay mounted across back/forward navigation, so a
  // returned-to page shows its existing DOM. Keyed by content identity, capped LRU.
  const viewKey = (v: View) =>
    `${v.name}:${(v as any).id ?? ""}:${(v as any).artistName ?? ""}:${(v as any).image ?? ""}`;
  const curKey = viewKey(view);
  // Computed during render (not in an effect) so the active page is in the mounted
  // set on its first frame.
  if (!aliveRef.current[0] || viewKey(aliveRef.current[0]) !== curKey) {
    aliveRef.current = [view, ...aliveRef.current.filter(x => viewKey(x) !== curKey)].slice(0, 8);
  }
  const alive = aliveRef.current;

  const renderView = (v: View) => {
    switch (v.name) {
      case "home": return <HomePage onOpenAlbum={openAlbum} onOpenArtist={openArtist} />;
      case "artists": return <ArtistsPage onOpenArtist={openArtist} />;
      case "artist": return <ArtistPage artistId={v.id} artistName={v.artistName} isAdmin={user.isAdmin} onOpenAlbum={openAlbum} onBack={goBack} />;
      case "albums": return <AlbumsPage onOpenAlbum={openAlbum} />;
      case "audiobooks": return <AudiobooksPage onOpenAudiobook={openAudiobook} />;
      case "audiobook": return <AudiobookPage albumId={v.id} onBack={goBack} onOpenArtist={openArtist} isAdmin={user.isAdmin} />;
      case "radio": return <RadioPage />;
      case "podcasts": return <PodcastsPage onOpen={openPodcast} />;
      case "podcast": return <PodcastChannelPage channelId={v.id} onBack={goBack} onOpenEpisode={openEpisode} />;
      case "podcastEpisode": return <EpisodePage episodeId={v.id} onBack={goBack} onOpenChannel={openPodcast} />;
      case "album": return <AlbumPage albumId={v.id} onOpenArtist={openArtist} onOpenAlbum={openAlbum} isAdmin={user.isAdmin} onBack={goBack} />;
      case "search": return <SearchPage q={query} onOpenArtist={openArtist} onOpenAlbum={openAlbum} onOpenAudiobook={openAudiobook} onOpenPodcast={openPodcast} onOpenEpisode={openEpisode} onOpenExternalArtist={(artistName, image) => push({ name: "discoverArtist", artistName, image })} />;
      case "discover": return <DiscoverPage onOpenArtist={openArtist} onOpenExternalArtist={(artistName, image) => push({ name: "discoverArtist", artistName, image })} />;
      case "genres": return <GenresPage onOpenGenre={openGenre} />;
      case "genre": return <GenrePage genre={v.genre} onOpenAlbum={openAlbum} onOpenArtist={openArtist} onBack={goBack} />;
      case "discoverArtist": return <ExternalArtistPage artistName={v.artistName} image={v.image} onBack={goBack} />;
      case "favorites": return <FavoritesPage onOpenAlbum={openAlbum} onOpenArtist={openArtist} />;
      case "stats": return <StatsPage onOpenArtist={openArtist} onOpenAlbum={openAlbum} onOpenGenre={openGenre} />;
      case "downloads": return <DownloadsPage onOpenAlbum={openAlbum} onOpenPlaylist={(id) => push({ name: "playlist", id })} />;
      case "playlists": return <PlaylistsPage onOpenPlaylist={(id) => push({ name: "playlist", id })} onOpenLiked={() => navigate("favorites")} onAddTrackToPlaylist={addTrackToPlaylist} />;
      // "‹ Playlists" means the Playlists page, also when you came from the sidebar.
      case "playlist": return <PlaylistPage playlistId={v.id} onOpenAlbum={openAlbum}
        onBack={() => (hist.stack[hist.idx - 1]?.name === "playlists" ? goBack() : navigate("playlists"))} />;
      case "requests": return <RequestsPage />;
      case "lyrics": return <LyricsContribPage onOpenAlbum={openAlbum} />;
      case "settings": return user.isAdmin ? <Suspense fallback={null}><SettingsPage /></Suspense> : null;
      case "account": return <AccountPage username={user.username} isAdmin={user.isAdmin} onNavigate={navigate} onLogout={logout} />;
      default: return null;
    }
  };

  return (
    <PlayerProvider>
      <Aurora />
      <AdaptiveTheme />
      <NightcoreOverlay />
      <MediaSession />
      <StayReachable />
      <KeyboardShortcuts playerOpen={expanded} />
      <CommandPalette
        isAdmin={user.isAdmin} disabled={expanded}
        onNavigate={navigate} onOpenAlbum={openAlbum} onOpenArtist={openArtist}
        onTogglePanel={togglePanel} onOpenPlayer={openPlayer}
      />
      <div className={`shell${rightPanel !== "none" && !panelClosing ? " panel-open" : ""}`}>
        <Sidebar
          current={view.name}
          onNavigate={navigateRoot}
          isAdmin={user.isAdmin}
          username={user.username}
          onLogout={logout}
          playlists={playlists}
          currentPlaylistId={view.name === "playlist" ? view.id : undefined}
          onOpenPlaylist={(id) => push({ name: "playlist", id })}
          onAddTrackToPlaylist={addTrackToPlaylist}
        />
        <main className="content" {...pageSwipe.handlers}>
          <MobileTopBar
            title={({ home: "Music", artists: "Music", albums: "Music", genres: "Music", radio: "Music", artist: "Music", album: "Music", genre: "Music", audiobooks: "Audiobooks", audiobook: "Audiobooks", podcasts: "Podcasts", podcast: "Podcasts", podcastEpisode: "Podcasts", search: "Search", discover: "Discover", discoverArtist: "Discover", requests: "Discover", favorites: "Liked Songs", playlists: "Playlists", playlist: "Playlists", stats: "Your Listening", downloads: "Downloads", lyrics: "Your Lyrics", settings: "Settings", account: "Account" } as Record<string, string>)[view.name] ?? "Localhost Music"}
            username={user.username} onOpenAccount={navigate}
          />

          {/* Shared header: search field on every browse page, plus the tab strip for places
              that have one. Outside .content-inner so it does not scroll away. */}
          {BROWSE.has(view.name) && (() => {
            const group = tabGroupOf(view.name);
            return (
              <div className="content-top">
                <div className="content-top-row">
                  {group && <h1 className="page-title">{group === "music" ? "Music" : "Discover"}</h1>}
                  <SearchBar value={query} onChange={onQuery} autoFocus={view.name === "search"} />
                </div>
                {group && <PageTabs group={group} current={view.name} onNavigate={navigate} />}
              </div>
            );
          })()}

          <div className="content-inner" ref={contentRef} onScroll={onContentScroll} onTouchStart={cancelRestore} onWheel={cancelRestore}>
            {alive.map(v => {
              const k = viewKey(v);
              return (
                <div key={`${viewGen}:${k}`} className="view-slot" style={k === curKey ? undefined : { display: "none" }}>
                  {renderView(v)}
                </div>
              );
            })}
          </div>
        </main>
        {rightPanel === "lyrics" && <LyricsPanel closing={panelClosing} onClose={closePanel} />}
        {rightPanel === "queue" && <QueuePanel closing={panelClosing} onClose={closePanel} />}
        <PlayBar
          onExpand={openPlayer}
          rightPanel={rightPanel}
          onToggleLyrics={() => togglePanel("lyrics")}
          onToggleQueue={() => togglePanel("queue")}
        />
        <MobileNav current={view.name} onNavigate={navigateRoot} />
        {/* Inside .shell: the toast stack uses the phone geometry vars
            (--nav-h/--pb-h/--float-gap/--nav-bottom), which are scoped to .shell. */}
        <Toaster />
        <UpdatePrompt />
        <ContextMenuHost isAdmin={user.isAdmin} />
        <SelectionBar />
      </div>
      {expanded && <NowPlaying onClose={closePlayer} onOpenArtist={openArtistFromPlayer} onOpenAlbum={openAlbumFromPlayer} />}
      <NetBadge />
      <UpdateToast />
      <PresencePrompts />
      {debugOn && <Suspense fallback={null}><DebugPanel /></Suspense>}
    </PlayerProvider>
  );
}
