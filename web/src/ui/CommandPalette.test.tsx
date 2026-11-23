import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

const player = vi.hoisted(() => ({ isPlaying: false, toggle: vi.fn(), next: vi.fn(), prev: vi.fn(), playNow: vi.fn() }));
vi.mock("../player/PlayerProvider", () => ({ usePlayer: () => player }));
vi.mock("../api", () => ({ api: { search: vi.fn(() => new Promise(() => {})), getFavorites: vi.fn(), coverUrl: () => "", artistImageUrl: () => "" } }));

// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();
afterEach(() => cleanup());

const props = (over: Partial<Parameters<typeof CommandPalette>[0]> = {}) => ({
  isAdmin: false, onNavigate: vi.fn(), onOpenAlbum: vi.fn(), onOpenArtist: vi.fn(),
  onTogglePanel: vi.fn(), onOpenPlayer: vi.fn(), ...over,
});
const openBar = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })); });

it("opens on Ctrl+K, filters actions, and runs the highlighted one", () => {
  const p = props();
  const { container } = render(<CommandPalette {...p} />);
  expect(container.querySelector(".cmdk")).toBeNull();
  openBar();
  const input = container.querySelector<HTMLInputElement>(".cmdk-input")!;
  fireEvent.change(input, { target: { value: "liked" } });
  expect([...container.querySelectorAll(".cmdk-label")].map(e => e.textContent)).toEqual(["Liked Songs", "Shuffle Liked Songs"]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(p.onNavigate).toHaveBeenCalledWith("favorites");
  expect(container.querySelector(".cmdk")).toBeNull();
});

it("arrow keys move the selection; Escape closes", () => {
  const p = props();
  const { container } = render(<CommandPalette {...p} />);
  openBar();
  const input = container.querySelector<HTMLInputElement>(".cmdk-input")!;
  fireEvent.change(input, { target: { value: "track" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(player.prev).toHaveBeenCalled(); // "Next track", then "Previous track"
  openBar();
  fireEvent.keyDown(container.querySelector(".cmdk-input")!, { key: "Escape" });
  expect(container.querySelector(".cmdk")).toBeNull();
});

it("uses the latest callbacks, not the ones from first render", () => {
  const first = vi.fn(), latest = vi.fn();
  const { container, rerender } = render(<CommandPalette {...props({ onNavigate: first })} />);
  rerender(<CommandPalette {...props({ onNavigate: latest })} />);
  openBar();
  const input = container.querySelector<HTMLInputElement>(".cmdk-input")!;
  fireEvent.change(input, { target: { value: "home" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(latest).toHaveBeenCalledWith("home");
  expect(first).not.toHaveBeenCalled();
});

it("stays closed while disabled (full-screen player open)", () => {
  const { container } = render(<CommandPalette {...props({ disabled: true })} />);
  openBar();
  expect(container.querySelector(".cmdk")).toBeNull();
});
