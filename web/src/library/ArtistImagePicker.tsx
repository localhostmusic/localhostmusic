import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ChevronDownIcon } from "../ui/icons";

type Cand = { url: string; thumb: string; source: string; kind: string; label?: string };

// Pick an artist photo from candidates (fanart.tv banners and thumbs, several
// Deezer matches) or upload one. Admin only.
export function ArtistImagePicker({ artistId, artistName, onClose, onPicked }: {
  artistId: number;
  artistName: string;
  onClose: () => void;
  onPicked: () => void;
}) {
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [busy, setBusy] = useState(""); // the candidate url being applied, "upload", or "url"
  const [err, setErr] = useState("");
  const [urlIn, setUrlIn] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.artistImageCandidates(artistId)
      .then((d: any) => setCands(d.candidates ?? []))
      .catch(() => { setCands([]); setErr("Couldn't load photos."); });
  }, [artistId]);

  async function pick(c: Cand) {
    setBusy(c.url); setErr("");
    try { await api.pickArtistImage(artistId, c.url, c.source); onPicked(); onClose(); }
    catch { setErr("Couldn't set that photo."); setBusy(""); }
  }
  async function setFromUrl() {
    const url = urlIn.trim();
    if (!/^https?:\/\//i.test(url)) return;
    setBusy("url"); setErr("");
    try { await api.pickArtistImage(artistId, url, "url"); onPicked(); onClose(); }
    catch { setErr("Couldn't fetch that image URL."); setBusy(""); }
  }
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    setBusy("upload"); setErr("");
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string); r.onerror = rej;
        r.readAsDataURL(file);
      });
      await api.uploadArtistImage(artistId, dataUrl); onPicked(); onClose();
    } catch { setErr("Upload failed."); setBusy(""); }
  }

  return (
    <div className="imgpick-scrim" onClick={onClose}>
      <div className="imgpick" onClick={e => e.stopPropagation()}>
        <header className="imgpick-head">
          <h3>Choose a photo for {artistName}</h3>
          <button className="lyrics-panel-close" onClick={onClose} aria-label="Close"><ChevronDownIcon size={18} /></button>
        </header>

        {cands === null ? (
          <p className="muted imgpick-msg">Finding photos…</p>
        ) : cands.length === 0 ? (
          <p className="muted imgpick-msg">No photos found from fanart.tv or Deezer.</p>
        ) : (
          <div className="imgpick-grid">
            {cands.map((c, i) => (
              <button key={i} className={`imgpick-cell${c.kind === "banner" ? " wide" : ""}`} onClick={() => pick(c)} disabled={!!busy}>
                <img src={c.thumb} alt="" loading="lazy"
                  onError={e => { const b = e.currentTarget.closest("button"); if (b) b.style.display = "none"; }} />
                <span className="imgpick-src">
                  {c.source}{c.label && c.label.toLowerCase() !== artistName.toLowerCase() ? ` · ${c.label}` : ""}
                </span>
                {busy === c.url && <span className="imgpick-applying">Setting…</span>}
              </button>
            ))}
          </div>
        )}

        {err && <p className="scrobble-err imgpick-msg">{err}</p>}

        <div className="imgpick-foot">
          <div className="imgpick-url">
            <input className="scrobble-input" placeholder="Paste an image URL (jpg/png)" value={urlIn}
              onChange={e => setUrlIn(e.target.value)} disabled={!!busy} autoComplete="off" spellCheck={false} />
            <button className="btn" onClick={setFromUrl} disabled={!!busy || !/^https?:\/\//i.test(urlIn.trim())}>
              {busy === "url" ? "Setting…" : "Set"}
            </button>
          </div>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={!!busy}>
            {busy === "upload" ? "Uploading…" : "Upload your own"}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={upload} />
        </div>
      </div>
    </div>
  );
}
