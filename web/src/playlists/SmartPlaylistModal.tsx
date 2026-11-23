import { useState } from "react";
import { api } from "../api";

type Rule = { field: string; op: string; value: any };
type Kind = "num" | "rating" | "bool" | "text" | "days";

const FIELDS: { key: string; label: string; ops: string[]; kind: Kind }[] = [
  { key: "rating", label: "Rating", ops: [">=", "<=", "="], kind: "rating" },
  { key: "plays", label: "Play count", ops: [">=", "<=", "="], kind: "num" },
  { key: "favorite", label: "Favorite", ops: ["is"], kind: "bool" },
  { key: "genre", label: "Genre", ops: ["is", "contains", "isnot"], kind: "text" },
  { key: "artist", label: "Artist", ops: ["is", "contains"], kind: "text" },
  { key: "addedWithinDays", label: "Added in last", ops: ["days"], kind: "days" },
  { key: "notPlayedInDays", label: "Not played in", ops: ["days"], kind: "days" },
  { key: "playedWithinDays", label: "Played in last", ops: ["days"], kind: "days" },
];
const meta = (k: string) => FIELDS.find(f => f.key === k) || FIELDS[0];
const OP_LABEL: Record<string, string> = { ">=": "≥", "<=": "≤", "=": "=", is: "is", contains: "contains", isnot: "is not", days: "" };
const SORTS: [string, string][] = [["added", "Date added"], ["plays", "Most played"], ["rating", "Rating"], ["artist", "Artist"], ["title", "Title"], ["random", "Random"]];
const defaultValue = (kind: Kind) => kind === "bool" ? true : kind === "text" ? "" : kind === "rating" ? 4 : kind === "days" ? 30 : 1;

export function SmartPlaylistModal({ existing, onClose, onSaved }: {
  existing?: { id: number; name: string; rules: any };
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const [name, setName] = useState(existing?.name || "");
  const [match, setMatch] = useState<"all" | "any">(existing?.rules?.match === "any" ? "any" : "all");
  const [rules, setRules] = useState<Rule[]>(existing?.rules?.rules?.length ? existing.rules.rules : [{ field: "rating", op: ">=", value: 4 }]);
  const [sort, setSort] = useState<string>(existing?.rules?.sort || "added");
  const [limit, setLimit] = useState<number>(existing?.rules?.limit || 100);
  const [refresh, setRefresh] = useState<string>(existing?.rules?.refresh || "daily");
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<Rule>) => setRules(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const changeField = (i: number, key: string) => { const m = meta(key); patch(i, { field: key, op: m.ops[0], value: defaultValue(m.kind) }); };

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    const spec = { match, rules, sort, limit: Math.min(2000, Math.max(1, Number(limit) || 100)), refresh };
    try {
      if (existing) { await api.updatePlaylist(existing.id, { rules: spec }); onSaved(existing.id); }
      else { const r: any = await api.createPlaylist(name.trim(), spec); onSaved(r.id); }
    } catch { /* */ } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal smart-modal" onClick={e => e.stopPropagation()}>
        <h2>{existing ? "Edit smart playlist" : "New smart playlist"}</h2>
        <label className="smart-name"><span>Name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. 5★ Metal" autoFocus /></label>
        <div className="smart-match">
          Match <select value={match} onChange={e => setMatch(e.target.value as any)}><option value="all">all</option><option value="any">any</option></select> of these rules:
        </div>
        <div className="smart-rules">
          {rules.map((r, i) => {
            const m = meta(r.field);
            return (
              <div className="smart-rule" key={i}>
                <select value={r.field} onChange={e => changeField(i, e.target.value)}>
                  {FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                {m.ops.length > 1 && (
                  <select value={r.op} onChange={e => patch(i, { op: e.target.value })}>
                    {m.ops.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
                  </select>
                )}
                {m.kind === "rating"
                  ? <select value={r.value} onChange={e => patch(i, { value: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}★</option>)}</select>
                  : m.kind === "bool"
                  ? <select value={String(r.value)} onChange={e => patch(i, { value: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select>
                  : m.kind === "text"
                  ? <input value={r.value} onChange={e => patch(i, { value: e.target.value })} placeholder={r.field === "genre" ? "e.g. Metal" : "e.g. Arch Enemy"} />
                  : <input type="number" value={r.value} onChange={e => patch(i, { value: Number(e.target.value) })} />}
                {m.kind === "days" && <span className="smart-suffix">days</span>}
                {rules.length > 1 && <button className="smart-rm" onClick={() => setRules(rs => rs.filter((_, j) => j !== i))} aria-label="Remove rule">✕</button>}
              </div>
            );
          })}
          <button className="link-btn smart-add" onClick={() => setRules(rs => [...rs, { field: "artist", op: "is", value: "" }])}>+ Add rule</button>
        </div>
        <div className="smart-foot-row">
          <label>Sort by <select value={sort} onChange={e => setSort(e.target.value)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>Limit <input type="number" min={1} max={2000} value={limit} onChange={e => setLimit(Number(e.target.value))} className="smart-limit" /></label>
          <label>Update <select value={refresh} onChange={e => setRefresh(e.target.value)}>
            <option value="open">Every open</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="manual">Manual only</option>
          </select></label>
        </div>
        <p className="smart-hint">A smart playlist snapshots on this cadence so playing from it doesn't reshuffle it as you go. Refresh anytime from the playlist.</p>
        <div className="modal-actions">
          <button className="link-btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>{busy ? "Saving…" : existing ? "Save" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}
