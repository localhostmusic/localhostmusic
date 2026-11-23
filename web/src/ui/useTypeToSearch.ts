import { useEffect, useLayoutEffect, useRef } from "react";

// Desktop type-to-search: typing anywhere that is not a text field goes into search.
// The first key opens the results view (App's onQuery pushes it); the search field then
// autofocuses and takes over. Excluded: Space (play/pause), modified keys, keys inside a
// field, touch-first devices, and anything while a modal or the full-screen player is up.
export function useTypeToSearch(query: string, onQuery: (q: string) => void, disabled: boolean) {
  const latest = useRef({ query, onQuery, disabled });
  useLayoutEffect(() => { latest.current = { query, onQuery, disabled }; });

  useEffect(() => {
    const fine = window.matchMedia?.("(pointer: fine)");
    const onKey = (e: KeyboardEvent) => {
      if (fine && !fine.matches) return;
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1 || e.key === " " || e.key === "/") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector(".syncl, .modal-backdrop, [role=dialog]")) return;
      const { query, onQuery, disabled } = latest.current;
      if (disabled) return;
      e.preventDefault();
      onQuery(query + e.key);
      // On browse pages the field is already mounted; elsewhere the search view
      // mounts it with autoFocus.
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>(".searchbar-input");
        if (!input || document.activeElement === input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
