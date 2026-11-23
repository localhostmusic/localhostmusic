import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useTypeToSearch } from "./useTypeToSearch";

let onQuery: ReturnType<typeof vi.fn<(q: string) => void>>;
function Host({ query = "", disabled = false }: { query?: string; disabled?: boolean }) {
  useTypeToSearch(query, onQuery, disabled);
  return <input data-testid="field" />;
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));

beforeEach(() => {
  onQuery = vi.fn<(q: string) => void>();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: fine)" }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

it("sends a printable key into the query", () => {
  render(<Host />);
  press("r");
  expect(onQuery).toHaveBeenCalledWith("r");
});

it("appends to the current query", () => {
  render(<Host query="ra" />);
  press("d");
  expect(onQuery).toHaveBeenCalledWith("rad");
});

it("leaves space, modified and non-printable keys alone", () => {
  render(<Host />);
  press(" "); press("k", { ctrlKey: true }); press("k", { metaKey: true }); press("ArrowLeft"); press("/");
  expect(onQuery).not.toHaveBeenCalled();
});

it("does nothing while typing in a field, a dialog is open, or it's disabled", () => {
  const { getByTestId, rerender } = render(<Host />);
  getByTestId("field").focus();
  press("a");
  getByTestId("field").blur();
  const dialog = document.body.appendChild(document.createElement("div"));
  dialog.setAttribute("role", "dialog");
  press("a");
  dialog.remove();
  rerender(<Host disabled />);
  press("a");
  expect(onQuery).not.toHaveBeenCalled();
});

it("is off on touch-first devices", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  render(<Host />);
  press("a");
  expect(onQuery).not.toHaveBeenCalled();
});
