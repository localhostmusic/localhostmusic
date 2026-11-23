import { NAV, navRoot, type ViewName } from "./Sidebar";

// Bottom tab bar on phones (the sidebar is hidden there). Renders the same five
// places as the sidebar, derived from NAV, with labels.
export function MobileNav({ current, onNavigate }: { current: string; onNavigate: (v: ViewName) => void }) {
  const active = navRoot(current);
  return (
    <nav className="mobile-nav">
      {NAV.map(t => (
        <button
          key={t.name}
          className={`mnav-item${active === t.name ? " active" : ""}`}
          onClick={() => onNavigate(t.name)}
          aria-label={t.label}
          aria-current={active === t.name ? "page" : undefined}
        >
          {t.icon}
          <span>{t.short ?? t.label}</span>
        </button>
      ))}
    </nav>
  );
}
