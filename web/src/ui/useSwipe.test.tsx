import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useSwipe } from "./useSwipe";

afterEach(() => cleanup());

function Page({ left, down }: { left: () => void; down: () => void }) {
  const { handlers } = useSwipe({ onSwipeLeft: left, onSwipeDown: down });
  return (
    <main {...handlers}>
      <div data-testid="rail" style={{ overflowX: "auto" }}><span data-testid="card">card</span></div>
      <p data-testid="text">text</p>
    </main>
  );
}
const swipe = (el: Element, dx: number, dy: number) => {
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 200 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 200 + dy }] });
};

it("a horizontal swipe on the page flips pages", () => {
  const left = vi.fn();
  const { getByTestId } = render(<Page left={left} down={vi.fn()} />);
  swipe(getByTestId("text"), -120, 5);
  expect(left).toHaveBeenCalledOnce();
});

it("a horizontal swipe inside a sideways-scrolling rail scrolls the rail, not the page", () => {
  const left = vi.fn(), down = vi.fn();
  const { getByTestId } = render(<Page left={left} down={down} />);
  const rail = getByTestId("rail");
  Object.defineProperty(rail, "scrollWidth", { value: 900 });
  Object.defineProperty(rail, "clientWidth", { value: 390 });
  swipe(getByTestId("card"), -120, 5);
  expect(left).not.toHaveBeenCalled();
  swipe(getByTestId("card"), 3, 120); // vertical gestures still work from inside a rail
  expect(down).toHaveBeenCalledOnce();
});

it("a rail with nothing to scroll doesn't block the page swipe", () => {
  const left = vi.fn();
  const { getByTestId } = render(<Page left={left} down={vi.fn()} />);
  swipe(getByTestId("card"), -120, 5);
  expect(left).toHaveBeenCalledOnce();
});
