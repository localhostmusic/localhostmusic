import { useEffect, useRef } from "react";
import { SearchIcon } from "./icons";

// The universal search field, in the page header on every browse page. Results are
// global wherever you type. The query is owned by App, not by this component or the
// view stack: a history entry per keystroke would bury the back button.
export function SearchBar({ value, onChange, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere, unless you are already typing into something.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  return (
    <div className="searchbar">
      <span className="searchbar-icon"><SearchIcon size={17} /></span>
      <input
        ref={ref}
        className="searchbar-input"
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") onChange(""); }}
        placeholder="Search your library…"
        aria-label="Search your library"
      />
      {value && (
        <button className="searchbar-clear" onClick={() => onChange("")} aria-label="Clear search">×</button>
      )}
    </div>
  );
}
