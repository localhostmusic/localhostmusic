import { test, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlayerProvider, usePlayer } from "./PlayerProvider";

// Nightcore is desktop-only, and the gate has to hold in state, not just by hiding
// the button: the mode persists in localStorage, so a phone with a stored "on"
// would otherwise start at rate != 1 with no control to turn it off.

function setPointer(touch: boolean) {
  // jsdom has no matchMedia; nightcoreSupported()/useIsMobile() key off this exact query.
  window.matchMedia = ((q: string) => ({
    matches: touch && /hover: none|pointer: coarse/.test(q),
    media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function Probe() {
  const p = usePlayer();
  return (
    <div>
      <span data-testid="on">{String(p.nightcore)}</span>
      <span data-testid="avail">{String(p.nightcoreAvailable)}</span>
      <span data-testid="rate">{p.effectiveRate}</span>
    </div>
  );
}

beforeEach(() => localStorage.setItem("lhm_nightcore", "1")); // "on" from a previous session
afterEach(() => localStorage.clear());

test("touch device ignores a persisted nightcore=on and stays at 1x", () => {
  setPointer(true);
  render(<PlayerProvider><Probe /></PlayerProvider>);
  expect(screen.getByTestId("avail").textContent).toBe("false"); // control is hidden
  expect(screen.getByTestId("on").textContent).toBe("false");    // and it is not left on
  expect(screen.getByTestId("rate").textContent).toBe("1");
  expect(localStorage.getItem("lhm_nightcore")).toBe("1");    // desktop's preference untouched
});

test("desktop honours a persisted nightcore=on and plays at the vibe rate", () => {
  setPointer(false);
  localStorage.setItem("lhm_nightcore_vibe", "1.25");
  render(<PlayerProvider><Probe /></PlayerProvider>);
  expect(screen.getByTestId("avail").textContent).toBe("true");
  expect(screen.getByTestId("on").textContent).toBe("true");
  expect(screen.getByTestId("rate").textContent).toBe("1.25");
});
