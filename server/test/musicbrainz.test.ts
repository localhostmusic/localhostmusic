import { test, expect, vi, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { resolveArtistMbid, artistNameKeys, nameKey, mbidByName } from "../src/lib/musicbrainz.js";

// Stub the MusicBrainz endpoints resolveArtistMbid touches: the artist search and
// each candidate's release-group browse. `artists` is returned in the order given,
// so a test can put the wrong candidate first and check the re-ranking.
function mockMb(artists: any[], releasesByMbid: Record<string, string[]>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/artist/?query=")) {
      return { ok: true, json: async () => ({ artists }) };
    }
    const mbid = u.match(/release-group\?artist=([^&]+)/)?.[1] ?? "";
    const titles = releasesByMbid[mbid] ?? [];
    return {
      ok: true,
      json: async () => ({
        "release-groups": titles.map((t, i) => ({
          id: `${mbid}-rg${i}`, title: t, "primary-type": "Album",
          "secondary-types": [], "first-release-date": "1979-01-01",
        })),
        "release-group-count": titles.length,
      }),
    };
  });
}

afterEach(() => vi.unstubAllGlobals());

const db = () => openDb(":memory:");

const artist = (id: string, name: string, score: number, aliases: string[] = []) =>
  ({ id, name, score, aliases: aliases.map(n => ({ name: n })) });

// The library tags the album artist "Shingetsu", but MusicBrainz files the band
// under 新月 with "Shingetsu" only as an alias.
test("prefers the artist carrying the name as an alias over a same-named stranger", async () => {
  const db = openDb(":memory:");
  mockMb(
    [artist("ensemble", "Shingetsu Ensemble", 100), artist("shingetsu", "新月", 100, ["Shingetsu"])],
    { ensemble: [], shingetsu: ["新月", "Night Collector", "From A Distant Star"] }
  );
  expect(await resolveArtistMbid(db, new Set(["shingetsu"]), "Shingetsu")).toBe("shingetsu");
  db.close();
});

// MusicBrainz scores "Wisp X" 100 for a query of "Wisp" and the real Wisp 74, so
// MB's order alone picks the wrong artist.
test("an exact name beats a higher-scored fuzzy match", async () => {
  const db = openDb(":memory:");
  mockMb([artist("wispx", "Wisp X", 100), artist("wisp", "Wisp", 74)], {});
  expect(await resolveArtistMbid(db, new Set(), "Wisp")).toBe("wisp");
  db.close();
});

// Owning the album is stronger evidence than any name match.
test("owned-album overlap outranks an exact name match", async () => {
  const db = openDb(":memory:");
  mockMb(
    [artist("wrong", "Wisp", 100), artist("right", "Wisp", 90)],
    { wrong: ["Something Else"], right: ["The Shimmering Hour"] }
  );
  expect(await resolveArtistMbid(db, new Set(["the shimmering hour"]), "Wisp")).toBe("right");
  db.close();
});

// With no overlap and no exact hit, having a discography at all breaks the tie.
test("a candidate with releases beats one with none", async () => {
  const db = openDb(":memory:");
  mockMb(
    [artist("empty", "Some Band Ensemble", 90), artist("real", "Some Band Project", 90)],
    { empty: [], real: ["An Album"] }
  );
  expect(await resolveArtistMbid(db, new Set(["unrelated"]), "Some Band")).toBe("real");
  db.close();
});

// norm() strips every non-Latin character, so a CJK name normalizes to "" and
// would otherwise compare equal to every other CJK name.
test("does not treat two different non-Latin names as the same name", async () => {
  const db = openDb(":memory:");
  mockMb([artist("other", "新緑", 100), artist("target", "新月", 80)], {});
  expect(await resolveArtistMbid(db, new Set(), "新月")).toBe("target");
  db.close();
});

test("returns the only candidate, and null when there are none", async () => {
  const db = openDb(":memory:");
  mockMb([artist("solo", "Solo", 100)], {});
  expect(await resolveArtistMbid(db, new Set(["whatever"]), "Solo")).toBe("solo");
  mockMb([], {});
  expect(await resolveArtistMbid(db, new Set(), "Nobody")).toBeNull();
  db.close();
});

// Release groups have no aliases in MusicBrainz, so an album titled 新月 can only
// be tied to a library album titled "Shingetsu" through the artist's alias list.
test("artistNameKeys collects the name, sort-name and aliases", async () => {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ name: "新月", "sort-name": "Shingetsu", aliases: [{ name: "Shingetsu" }, { name: "SHINGETSU" }] }),
  }));
  const keys = await artistNameKeys("mbid-shingetsu");
  expect(keys.has("shingetsu")).toBe(true);
  expect(keys.has("新月")).toBe(true);
  vi.unstubAllGlobals();
});

test("artistNameKeys yields an empty set when MusicBrainz fails, rather than throwing", async () => {
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
  await expect(artistNameKeys("mbid-broken")).resolves.toEqual(new Set());
  vi.unstubAllGlobals();
});

test("nameKey keeps distinct non-Latin names distinct", () => {
  expect(nameKey("新月")).not.toBe(nameKey("新緑"));
  expect(nameKey("  The Suburbs ")).toBe(nameKey("the suburbs"));
});

// MusicBrainz scores "Napalm Death" 100 for a query of "Death" and the real
// Death 99, so the top hit can't be taken blind.
test("mbidByName requires the name to actually match, not just rank first", async () => {
  mockMb([artist("napalm", "Napalm Death", 100), artist("death", "Death", 99)], {});
  expect(await mbidByName("Death")).toBe("death");
});

// With nothing to disambiguate against, a wrong id is worse than none.
test("mbidByName returns null rather than guess when nothing matches", async () => {
  mockMb([artist("napalm", "Napalm Death", 100), artist("cab", "Death Cab for Cutie", 91)], {});
  expect(await mbidByName("Death")).toBeNull();
});

test("mbidByName accepts an alias match", async () => {
  mockMb([artist("other", "Something Else", 100), artist("target", "新月", 80, ["Shingetsu"])], {});
  expect(await mbidByName("Shingetsu")).toBe("target");
});

// Alias search adds many partial matches, so the artist actually called "Death"
// ranks below several others. Names must be checked before slicing to the top few.
test("finds an exact match buried below higher-scored partial matches", async () => {
  mockMb([
    artist("shroud", "death’s dynamic shroud", 100),
    artist("ss", "Death SS", 96),
    artist("cab", "Death Cab for Cutie", 92),
    artist("angel", "Death Angel", 91),
    artist("sonic", "Sonic Youth", 87),
    artist("real", "Death", 80),
  ], { real: ["Human", "Symbolic"], shroud: [], ss: [], cab: [], angel: [], sonic: [] });
  expect(await resolveArtistMbid(db(), new Set(["human"]), "Death")).toBe("real");
});

// It must still work with no owned albums to compare against.
test("prefers a genuine name match even with nothing owned to compare", async () => {
  mockMb([artist("cab", "Death Cab for Cutie", 100), artist("real", "Death", 70)], {});
  expect(await resolveArtistMbid(db(), new Set(), "Death")).toBe("real");
});
