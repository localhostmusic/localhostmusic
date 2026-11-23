import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PlayerProvider } from "../player/PlayerProvider";
import { AlbumPage } from "./AlbumPage";
import { api } from "../api";

beforeEach(() => {
  vi.spyOn(api, "getAlbum").mockResolvedValue({
    id: 1, title: "Album 1", tracks: [{ id: 10, title: "Song A" }, { id: 11, title: "Song B" }],
  } as any);
});

test("renders album tracks", async () => {
  render(<PlayerProvider><AlbumPage albumId={1} /></PlayerProvider>);
  await waitFor(() => expect(screen.getByText("Song A")).toBeTruthy());
  expect(screen.getByText("Song B")).toBeTruthy();
});
