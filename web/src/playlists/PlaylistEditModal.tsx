import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { PlaylistCover } from "./PlaylistCover";

const readDataUrl = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result as string);
  r.onerror = rej;
  r.readAsDataURL(f);
});

export function PlaylistEditModal({ playlist, albumIds, onClose, onSaved }: {
  playlist: any;
  albumIds: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(playlist.name || "");
  const [description, setDescription] = useState(playlist.description || "");
  const [dedicated, setDedicated] = useState(playlist.dedicated_to || "");
  const [mood, setMood] = useState(playlist.mood || "");
  const [coverData, setCoverData] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setCoverData(await readDataUrl(f));
    e.target.value = "";
  }

  async function save() {
    if (!name.trim()) { setErr("Name is required."); return; }
    setSaving(true); setErr("");
    try {
      await api.updatePlaylist(playlist.id, { name: name.trim(), description, dedicated_to: dedicated, mood });
      if (coverData) await api.uploadPlaylistCover(playlist.id, coverData);
      onSaved();
    } catch { setErr("Couldn't save. Try again."); setSaving(false); }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Edit playlist</h2>
          <button className="link-btn" onClick={onClose}>Close</button>
        </header>

        <div className="pl-edit">
          <div className="pl-edit-cover">
            {coverData
              ? <img className="pl-cover lg" src={coverData} alt="" />
              : <PlaylistCover id={playlist.id} hasCover={!!playlist.cover_path} albumIds={albumIds} className="lg" />}
            <button className="btn" onClick={() => fileRef.current?.click()}>Choose image</button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
            <p className="muted pl-edit-hint">No image uses a collage of the album art.</p>
          </div>

          <div className="pl-edit-fields">
            <label>Name<input value={name} onChange={e => setName(e.target.value)} placeholder="My playlist" /></label>
            <label>Dedicated to<input value={dedicated} onChange={e => setDedicated(e.target.value)} placeholder="e.g. late-night drives" /></label>
            <label>Mood<input value={mood} onChange={e => setMood(e.target.value)} placeholder="e.g. chill, energetic" /></label>
            <label>Description<textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder="What's this playlist about?" /></label>
          </div>
        </div>

        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
