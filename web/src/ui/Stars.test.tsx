import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { Stars } from "./Stars";

test("renders 5 stars and rates the one clicked", () => {
  const onRate = vi.fn();
  render(<Stars value={0} onRate={onRate} />);
  const stars = screen.getAllByRole("button");
  expect(stars).toHaveLength(5);
  fireEvent.click(stars[2]); // third star sets rating 3
  expect(onRate).toHaveBeenCalledWith(3);
});

test("clicking the current rating clears it (sets 0)", () => {
  const onRate = vi.fn();
  render(<Stars value={3} onRate={onRate} />);
  fireEvent.click(screen.getAllByRole("button")[2]); // click the already-set 3rd star
  expect(onRate).toHaveBeenCalledWith(0);
});
