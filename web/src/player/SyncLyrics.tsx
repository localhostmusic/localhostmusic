import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { usePlayer, usePlayerTime } from "./PlayerProvider";
import { Waveform } from "./Waveform";
import { PlayIcon, PauseIcon, ChevronDownIcon } from "../ui/icons";

interface Entry { text: string; t: number | null; ins?: boolean; }

// In-progress syncs are saved to localStorage per track so they can be resumed.
// Drafts older than DRAFT_MAX_AGE are dropped.
const DRAFT_KEY = (id: number) => `lhm:lyricsdraft:${id}`;
const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function lrcStamp(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}]`;
}
function fmt(t: number) {
  if (!t || !isFinite(t)) return "0:00";
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtCs(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Parse synced (LRC) lyrics into editable entries. Empty-text lines become
// instrumental markers.
function parseSyncedToEntries(lrc: string): Entry[] {
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const out: Entry[] = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(re)];
    if (!stamps.length) continue;
    const txt = raw.replace(re, "").trim();
    for (const s of stamps) {
      const t = +s[1] * 60 + +s[2] + (s[3] ? +`0.${s[3]}` : 0);
      out.push(txt ? { text: txt, t } : { text: "", t, ins: true });
    }
  }
  return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

// Tap-along tool: play the song and tap/press Space as each line begins to build
// time-synced (LRC) lyrics. Press I for an instrumental break, Backspace to undo.
export function SyncLyrics({ trackId, title, onClose, onSaved }: {
  trackId: number;
  title: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const p = usePlayer();
  const t = usePlayerTime();
  // Lock onto the track we opened with, and hold auto-advance while the tool is open.
  const [lockedId] = useState(trackId);
  const [lockedTitle] = useState(title);
  useEffect(() => { p.setHold(true); return () => p.setHold(false); }, []);
  const [phase, setPhase] = useState<"edit" | "countdown" | "sync" | "review" | "saved">("edit");
  const [count, setCount] = useState(3);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  // Post-save "publish to LRCLIB" step. publish is idle, working, done, or an
  // error message.
  const [savedSynced, setSavedSynced] = useState(false);
  const [publish, setPublish] = useState<"idle" | "working" | "done" | string>("idle");
  const [expanded, setExpanded] = useState(-1); // which review row is open
  const [existing, setExisting] = useState<Entry[] | null>(null); // parsed existing synced lyrics
  const [draft, setDraft] = useState<{ text: string; entries: Entry[]; pos: number; ts: number } | null>(null);
  const [tick, force] = useReducer((x: number) => x + 1, 0);
  const cdRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs are the source of truth so one-time key listeners never read stale state.
  const entriesRef = useRef<Entry[]>([]);
  const posRef = useRef(0);
  // True once the user edits the textarea, so the getLyrics prefill alone never
  // counts as a draft.
  const textDirtyRef = useRef(false);
  const tRef = useRef(0);
  tRef.current = t.currentTime;

  // Prefill from a saved draft, existing synced lyrics, and plain text (derived
  // from the synced lines if there is no plain).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY(lockedId));
      if (raw) {
        const d = JSON.parse(raw);
        const hasContent = (d?.entries?.length ?? 0) > 0 || d?.text?.trim();
        if (hasContent && Date.now() - (d.ts ?? 0) < DRAFT_MAX_AGE) setDraft(d);
        else localStorage.removeItem(DRAFT_KEY(lockedId));
      }
    } catch { /* ignore malformed draft */ }
    api.getLyrics(lockedId).then((d: any) => {
      if (d?.synced) {
        const e = parseSyncedToEntries(d.synced);
        if (e.length) setExisting(e);
        setText(d.plain || e.filter(x => !x.ins).map(x => x.text).join("\n"));
      } else if (d?.plain) {
        setText(d.plain);
      }
    }).catch(() => {});
  }, [lockedId]);

  // Load existing synced lyrics into the review phase for fine-tuning.
  function editExisting() {
    if (!existing) return;
    entriesRef.current = existing.map(e => ({ ...e }));
    posRef.current = entriesRef.current.length;
    setPhase("review");
    force();
  }
  // Shift every timestamp by d seconds (fix a whole song that's consistently off).
  function shiftAll(d: number) {
    for (const e of entriesRef.current) if (e.t != null) e.t = Math.max(0, e.t + d);
    force();
  }

  function start() {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    entriesRef.current = lines.map(t => ({ text: t, t: null }));
    posRef.current = 0;
    // Count down with the song paused at 0, in case vocals start right away.
    p.seek(0);
    if (p.isPlaying) p.toggle();
    setPhase("countdown");
    setCount(3);
    let n = 3;
    cdRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        if (cdRef.current) clearInterval(cdRef.current);
        setPhase("sync");
        p.seek(0);
        p.toggle(); // start playing from the paused state
        force();
      } else {
        setCount(n);
      }
    }, 1000);
  }

  useEffect(() => () => { if (cdRef.current) clearInterval(cdRef.current); }, []);

  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY(lockedId)); } catch { /* ignore */ } }
  // Rewrite the draft when the work changes. Keyed on `tick` (bumped by force()),
  // not player time, so localStorage isn't written every frame.
  useEffect(() => {
    if (phase === "saved") return;
    const hasTiming = entriesRef.current.some(e => e.t != null);
    const typedText = textDirtyRef.current && !!text.trim();
    // In the edit phase only typed text or existing timings count, not the prefill.
    if (phase === "edit" && !hasTiming && !typedText) return;
    try {
      localStorage.setItem(DRAFT_KEY(lockedId), JSON.stringify({
        text, entries: entriesRef.current, pos: posRef.current, ts: Date.now(),
      }));
    } catch { /* quota / private mode */ }
  }, [tick, phase, text, lockedId]);

  // Resume a draft: review if anything was timed, else back to edit.
  function resumeDraft() {
    if (!draft) return;
    textDirtyRef.current = true; // resumed work stays persisted
    setText(draft.text || "");
    entriesRef.current = (draft.entries || []).map(e => ({ ...e }));
    const anyTimed = entriesRef.current.some(e => e.t != null);
    posRef.current = entriesRef.current.length;
    setDraft(null);
    setPhase(anyTimed ? "review" : "edit");
    force();
  }
  function discardDraft() { clearDraft(); setDraft(null); }

  function stamp() {
    const e = entriesRef.current;
    if (posRef.current >= e.length) return;
    e[posRef.current] = { ...e[posRef.current], t: tRef.current };
    posRef.current++;
    if (posRef.current >= e.length) setPhase("review"); // all lines timed
    force();
  }
  function instrumental() {
    entriesRef.current.splice(posRef.current, 0, { text: "", t: tRef.current, ins: true });
    posRef.current++;
    force();
  }
  function undo() {
    if (posRef.current <= 0) return;
    posRef.current--;
    const e = entriesRef.current;
    const cur = e[posRef.current];
    if (cur.ins) e.splice(posRef.current, 1);
    else cur.t = null;
    // Rewind to just before this line so you can re-tap it immediately.
    const prevT = posRef.current > 0 ? (e[posRef.current - 1].t ?? 0) : 0;
    p.seek(prevT);
    force();
  }

  // Keyboard while syncing.
  useEffect(() => {
    if (phase !== "sync") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === " ") { ev.preventDefault(); stamp(); }
      else if (ev.key.toLowerCase() === "i") { ev.preventDefault(); instrumental(); }
      else if (ev.key === "Backspace") { ev.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  // Save the edited text as plain lyrics, no timing.
  function savePlain() {
    const plain = text.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
    if (!plain) return;
    setSaving(true);
    api.saveLyrics(lockedId, { plain })
      .then(() => { clearDraft(); setSavedSynced(false); setPhase("saved"); })
      .catch(() => setSaving(false));
  }

  function save() {
    const stamped = entriesRef.current.filter(e => e.t != null).sort((a, b) => (a.t! - b.t!));
    if (!stamped.length) return;
    const synced = stamped.map(e => `${lrcStamp(e.t!)}${e.text}`).join("\n");
    const plain = entriesRef.current.filter(e => !e.ins).map(e => e.text).join("\n");
    setSaving(true);
    api.saveLyrics(lockedId, { synced, plain })
      .then(() => { clearDraft(); setSavedSynced(true); setPhase("saved"); })
      .catch(() => setSaving(false));
  }

  // Publish the saved lyrics to LRCLIB. The proof-of-work runs server-side and can
  // take a few seconds.
  function publishToLrclib() {
    setPublish("working");
    api.publishLyrics(lockedId)
      .then(() => setPublish("done"))
      .catch((e) => setPublish(e?.message || "Publishing failed."));
  }

  function nudge(i: number, d: number) {
    const e = entriesRef.current;
    if (e[i].t == null) return;
    e[i].t = Math.max(0, (e[i].t as number) + d);
    force();
  }
  function preview(t: number | null) {
    if (t == null) return;
    p.seek(Math.max(0, t - 0.4));
    if (!p.isPlaying) p.toggle();
  }
  function removeEntry(i: number) {
    entriesRef.current.splice(i, 1);
    force();
  }
  // Add a line timed at the current playback position, inserted in time order.
  function addLine() {
    const t0 = Math.max(0, tRef.current);
    const e = entriesRef.current;
    let idx = e.findIndex(x => (x.t ?? Infinity) > t0);
    if (idx < 0) idx = e.length;
    e.splice(idx, 0, { text: "", t: t0 });
    setExpanded(idx);
    force();
  }
  function setLineText(i: number, v: string) {
    const e = entriesRef.current;
    if (!e[i]) return;
    e[i].text = v;
    if (v.trim()) e[i].ins = false; // typing into an instrumental marker makes it a real line
    force();
  }
  // Re-tap from a given line: keep everything before it, clear timings from it on.
  function retimeFrom(i: number) {
    const all = entriesRef.current;
    const head = all.slice(0, i);
    const tail = all.slice(i).filter(en => !en.ins).map(en => ({ ...en, t: null }));
    entriesRef.current = [...head, ...tail];
    posRef.current = head.length;
    const startT = head.length ? (head[head.length - 1].t ?? 0) : 0;
    p.seek(startT);
    setPhase("sync");
    if (!p.isPlaying) p.toggle();
    force();
  }

  const entries = entriesRef.current;
  const pos = posRef.current;

  return createPortal(
    // Portaled to <body>, but React events still bubble through the component tree,
    // so stop touches here or they reach the NowPlaying swipe/drag handlers.
    <div
      className="syncl"
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
    >
      <div className="np-scrim" />
      <div className="syncl-content">
        <button className="np-close" onClick={onClose} aria-label="Close" title="Close (your progress is saved)"><ChevronDownIcon size={26} /></button>
        {phase === "sync" && (
          <div className="syncl-progress-badge">{Math.min(pos, entries.length)}<span>/{entries.length}</span></div>
        )}
        <h2 className="syncl-title">Sync lyrics: {lockedTitle}</h2>

        {phase === "edit" && (
          <>
            {draft && (
              <div className="syncl-existing">
                <p className="muted">You have an unfinished sync for this song ({draft.entries.filter(e => e.t != null).length} lines timed).</p>
                <button className="btn primary" onClick={resumeDraft}>Resume where you left off</button>
                <button className="btn" onClick={discardDraft}>Discard & start over</button>
                <p className="muted syncl-existing-or">or start fresh below</p>
              </div>
            )}
            {existing && (
              <div className="syncl-existing">
                <p className="muted">This song already has synced lyrics ({existing.filter(e => !e.ins).length} lines).</p>
                <button className="btn primary" onClick={editExisting}>Edit existing timing</button>
                <p className="muted syncl-existing-or">or re-sync from scratch</p>
              </div>
            )}
            <p className="muted">Paste or edit the lyrics (one line each), then tap along to time them.</p>
            <textarea className="syncl-text" value={text} onChange={e => { textDirtyRef.current = true; setText(e.target.value); }} rows={12}
              placeholder={"Paste the lyrics here, one line per row…"} />
            <div className="syncl-actions">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn" onClick={savePlain} disabled={!text.trim() || saving}>Save without syncing</button>
              <button className="btn primary" onClick={start} disabled={!text.trim()}>Start syncing</button>
            </div>
          </>
        )}

        {phase === "countdown" && (
          <div className="syncl-stage"><div className="syncl-count" key={count}>{count}</div><p className="syncl-hint">Get ready…</p></div>
        )}

        {phase === "sync" && (
          <>
            {/* Stamp on pointerdown, not click, so the time is taken at press. */}
            <div className="syncl-stage" onPointerDown={(e) => { if (e.button === 0) stamp(); }} role="button" aria-label="Stamp line">
              {entries[pos - 1] && <p className="syncl-prev">{entries[pos - 1].text || "♪"}</p>}
              <p className="syncl-cur" key={pos}>{entries[pos]?.text || "♪"}</p>
              {entries[pos + 1] && <p className="syncl-next">{entries[pos + 1].text || "♪"}</p>}
              <p className="syncl-hint">
                <span className="hint-tap">Tap anywhere when this line starts</span>
                <span className="hint-keys"> · Space to stamp · I = instrumental · Backspace = undo</span>
              </p>
            </div>
            <Waveform trackId={lockedId} currentTime={t.currentTime} duration={p.duration} onSeek={p.seek} />
            <div className="syncl-bar">
              <button className="ctl-toggle" onClick={(e) => { e.stopPropagation(); p.toggle(); }} aria-label="Play/pause">
                {p.isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
              </button>
              <div className="syncl-bar-mid">
                <button className="btn" onClick={instrumental}>♪ Instrumental</button>
                <button className="btn" onClick={undo} disabled={pos === 0}>Undo</button>
                <button className="btn" onClick={onClose} title="Progress is saved, resume later">Save & exit</button>
              </div>
              <button className="btn primary" onClick={() => setPhase("review")} disabled={!entries.some(e => e.t != null)}>Review</button>
            </div>
          </>
        )}

        {phase === "review" && (
          <>
            <p className="muted">Tap a line to hear it; open it to fine-tune, re-tap, edit its text, or remove. Missing a line? Pause where it belongs, then <strong>Add a line</strong>.</p>
            <div className="syncl-offset">
              <span className="muted">Shift all</span>
              <button className="rev-btn" onClick={() => shiftAll(-0.5)}>−0.5s</button>
              <button className="rev-btn" onClick={() => shiftAll(-0.2)}>−0.2s</button>
              <button className="rev-btn" onClick={() => shiftAll(0.2)}>+0.2s</button>
              <button className="rev-btn" onClick={() => shiftAll(0.5)}>+0.5s</button>
              <button className="rev-btn add" onClick={addLine} title="Add a line at the current playback position">＋ Add a line</button>
            </div>
            <ul className="syncl-review">
              {entries.map((e, i) => (
                <li key={i} className={expanded === i ? "expanded" : ""}>
                  <button className="syncl-rev-row" onClick={() => {
                    const n = expanded === i ? -1 : i;
                    setExpanded(n);
                    if (n === i) preview(e.t);
                  }}>
                    <span className={"syncl-rev-text" + (!e.text ? " placeholder" : "")}>
                      {e.text || (e.ins ? "♪ instrumental" : "New line, open to edit")}
                    </span>
                    <span className="syncl-rev-time">{e.t != null ? fmtCs(e.t) : "-"}</span>
                    <ChevronDownIcon size={16} />
                  </button>
                  {expanded === i && (
                    <div className="syncl-rev-actions">
                      {!e.ins && (
                        <input
                          className="syncl-rev-edit"
                          value={e.text}
                          placeholder="Line text…"
                          autoFocus={!e.text}
                          onChange={ev => setLineText(i, ev.target.value)}
                        />
                      )}
                      <button className="rev-btn" onClick={() => nudge(i, -0.2)}>−0.2s</button>
                      <button className="rev-btn" onClick={() => nudge(i, 0.2)}>+0.2s</button>
                      <button className="rev-btn" onClick={() => preview(e.t)}><PlayIcon size={13} /> Play</button>
                      <button className="rev-btn" onClick={() => retimeFrom(i)}>↺ Re-tap</button>
                      <button className="rev-btn danger" onClick={() => { removeEntry(i); setExpanded(-1); }}>✕ Delete</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <Waveform trackId={lockedId} currentTime={t.currentTime} duration={p.duration} onSeek={p.seek} />
            <div className="syncl-bar">
              <div className="syncl-bar-mid">
                <button className="ctl-toggle" onClick={() => p.toggle()} aria-label="Play/pause">
                  {p.isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
                </button>
                <span className="pb-time">{fmt(t.currentTime)}</span>
                <button className="btn" onClick={onClose} title="Progress is saved, resume later">Save & exit</button>
              </div>
              <button className="btn primary" onClick={save} disabled={saving || !entries.some(e => e.t != null)}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}

        {phase === "saved" && (
          <div className="syncl-saved">
            <div className="syncl-saved-check">✓</div>
            <h3>Lyrics saved</h3>
            {publish === "done" ? (
              <>
                <p className="muted">Published to LRCLIB. Anyone, in Localhost Music or any other app, can now find these lyrics.</p>
                <div className="syncl-actions">
                  <button className="btn primary" onClick={onSaved}>Done</button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">
                  {savedSynced
                    ? <>Help others find them: publish your synced lyrics to <strong>LRCLIB</strong>, the open lyrics database. They become the next listener's automatic match.</>
                    : <>This song may not be on <strong>LRCLIB</strong> yet. Publish your lyrics (unsynced is fine) so the next person finds them automatically.</>}
                </p>
                {typeof publish === "string" && publish !== "idle" && publish !== "working" && (
                  <p className="syncl-saved-err">{publish}</p>
                )}
                <div className="syncl-actions">
                  <button className="btn" onClick={onSaved} disabled={publish === "working"}>Not now</button>
                  <button className="btn primary" onClick={publishToLrclib} disabled={publish === "working"}>
                    {publish === "working" ? "Publishing…" : "Publish to LRCLIB"}
                  </button>
                </div>
                {publish === "working" && <p className="muted syncl-saved-pow">Solving LRCLIB's proof-of-work. This can take a few seconds…</p>}
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
