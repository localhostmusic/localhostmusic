import { test, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { PlayerProvider, usePlayer } from "./PlayerProvider";

beforeEach(() => localStorage.clear());

function Probe() {
  const p = usePlayer();
  return (
    <div>
      <span data-testid="cur">{p.current?.title ?? "none"}</span>
      <button onClick={() => p.playNow([{ id:1, title:"A" }, { id:2, title:"B" }, { id:3, title:"C" }], 0)}>play</button>
      <button onClick={() => p.next()}>next</button>
      <button onClick={() => { p.next(); p.next(); }}>next twice</button>
      <button onClick={() => p.cycleRepeat()}>repeat</button>
      <button onClick={() => { p.addToQueue({id:4,title:"D"}); p.addToQueue({id:5,title:"E"}); }}>append twice</button>
      <span data-testid="queue">{p.queue.map(t=>t.title).join("")}</span>
    </div>
  );
}

test("playNow sets current; next advances", () => {
  render(<PlayerProvider><Probe /></PlayerProvider>);
  act(() => screen.getByText("play").click());
  expect(screen.getByTestId("cur").textContent).toBe("A");
  act(() => screen.getByText("next").click());
  expect(screen.getByTestId("cur").textContent).toBe("B");
});

test("rapid next commands advance from the latest cursor", () => {
  render(<PlayerProvider><Probe /></PlayerProvider>);
  act(() => screen.getByText("play").click());
  act(() => screen.getByText("next twice").click());
  expect(screen.getByTestId("cur").textContent).toBe("C");
});
test("manual Next works while Repeat One is selected", () => {
  render(<PlayerProvider><Probe /></PlayerProvider>);
  act(() => screen.getByText("play").click());
  act(() => screen.getByText("repeat").click());
  act(() => screen.getByText("repeat").click());
  act(() => screen.getByText("next").click());
  expect(screen.getByTestId("cur").textContent).toBe("B");
});
test("back-to-back queue edits preserve both additions", () => {
  render(<PlayerProvider><Probe /></PlayerProvider>);
  act(() => screen.getByText("play").click());
  act(() => screen.getByText("append twice").click());
  expect(screen.getByTestId("queue").textContent).toBe("ABCDE");
});
