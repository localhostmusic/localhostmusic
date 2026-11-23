import type { ViewName } from "./Sidebar";

// The tab strip under a place's title. Each tab is a real view, not internal state
// of a container: App.tsx keeps mounted views alive keyed by view name and restores
// scroll per key, so every tab keeps its own scroll position and data.
export const TAB_GROUPS: Record<string, { name: ViewName; label: string }[]> = {
  music: [
    { name: "home", label: "Home" },
    { name: "artists", label: "Artists" },
    { name: "albums", label: "Albums" },
    { name: "genres", label: "Genres" },
    { name: "radio", label: "Radio" },
  ],
  discover: [
    { name: "discover", label: "Discover" },
    { name: "requests", label: "Requests" },
  ],
};

/** The group a view belongs to, or undefined if it isn't tabbed. */
export function tabGroupOf(view: string): keyof typeof TAB_GROUPS | undefined {
  if (TAB_GROUPS.music.some(t => t.name === view)) return "music";
  if (TAB_GROUPS.discover.some(t => t.name === view)) return "discover";
  return undefined;
}

export function PageTabs({ group, current, onNavigate }: {
  group: keyof typeof TAB_GROUPS;
  current: string;
  onNavigate: (v: ViewName) => void;
}) {
  return (
    <div className="page-tabs" role="tablist">
      {TAB_GROUPS[group].map(t => (
        <button
          key={t.name}
          role="tab"
          aria-selected={current === t.name}
          className={`page-tab${current === t.name ? " active" : ""}`}
          onClick={() => onNavigate(t.name)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
