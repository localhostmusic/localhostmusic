import { test, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MyAvatar } from "./MyAvatar";

test("each user gets their own picture address, and a failed one is retried for the next user", () => {
  const { container, rerender } = render(<MyAvatar username="admin" />);
  const first = container.querySelector("img")!.getAttribute("src")!;
  expect(first).toContain("u=admin");

  // bob has no picture: the image fails and his initial shows.
  rerender(<MyAvatar username="bob" />);
  const bob = container.querySelector("img")!;
  expect(bob.getAttribute("src")).not.toBe(first);
  expect(bob.getAttribute("src")).toContain("u=bob");
  fireEvent.error(bob);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("B");

  // Back to admin: the picture is tried again instead of staying on the initial.
  rerender(<MyAvatar username="admin" />);
  expect(container.querySelector("img")!.getAttribute("src")).toBe(first);
});
