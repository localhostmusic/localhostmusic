import type { Track } from "./PlayerProvider";

export type Chapter = { idx: number; title: string; startMs: number; endMs: number | null };

// Chapter titles from ffprobe often already carry their own number ("01 - Paisaje
// Bretón"), so a separate index column would double it up. Strip a leading numeric
// prefix ("01 - ", "1. ", "3) ") for display; keep the original if that's all there is.
export function stripChapterNum(title: string): string {
  return title.replace(/^\s*\d{1,3}\s*[-.:)\]–—]\s*/, "").trim() || title;
}

// Index of the chapter covering `sec` (seconds into the file); -1 if none.
export function chapterIndexAt(chapters: Chapter[], sec: number): number {
  return chapters.reduce((best, c, i) => (sec * 1000 >= c.startMs ? i : best), chapters.length ? 0 : -1);
}

// What Now Playing and the play bar show. For an audiobook the title is the book
// (album) and the subtitle is the current chapter, or the author without chapters.
export function npDisplay(
  current: Track | undefined, chapters: Chapter[], sec: number, radioTitle?: string | null
): { title: string; subtitle: string; isBook: boolean } {
  if (current?.isRadio) {
    // Station name as the title, the ICY "Artist - Song" (if any) as subtitle.
    return { title: current.title ?? "", subtitle: radioTitle || "Internet radio", isBook: false };
  }
  if (current?.isAudiobook) {
    const i = chapterIndexAt(chapters, sec);
    const ch = i >= 0 ? chapters[i] : null;
    return {
      title: current.album || current.title,
      subtitle: ch ? stripChapterNum(ch.title) : (current.artist ?? ""),
      isBook: true,
    };
  }
  return { title: current?.title ?? "", subtitle: current?.artist ?? "", isBook: false };
}
