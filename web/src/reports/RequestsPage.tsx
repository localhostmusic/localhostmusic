import { useEffect, useState } from "react";
import { api } from "../api";

export const KIND_LABELS: Record<string, string> = {
  missing_content: "Missing album / artist / song",
  missing_lyrics: "Missing lyrics",
  wrong_art: "Wrong or missing artwork",
  wrong_info: "Wrong artist / album info",
  add_album: "Album request",
  other: "Other",
};

// Human-readable detail. Album requests store JSON ({year,rgid}), so show only
// the year. Everything else is plain text.
export function reportDetailText(r: any): string {
  if (r.kind === "add_album") {
    try { const d = JSON.parse(r.detail); return d?.year ? String(d.year) : ""; } catch { return ""; }
  }
  return r.detail ?? "";
}
// Release-group id stashed in an album request's detail (for cover art).
export function reportRgid(r: any): string | null {
  if (r.kind !== "add_album") return null;
  try { return JSON.parse(r.detail)?.rgid ?? null; } catch { return null; }
}

export function RequestsPage() {
  const [kind, setKind] = useState("missing_content");
  const [subject, setSubject] = useState("");
  const [detail, setDetail] = useState("");
  const [mine, setMine] = useState<any[]>([]);
  const [msg, setMsg] = useState("");

  const load = () => api.getMyReports().then(setMine).catch(() => {});
  useEffect(() => { load(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    if (!subject.trim()) { setMsg("Please say what's missing or wrong."); return; }
    await api.createReport(kind, subject.trim(), detail.trim());
    setSubject(""); setDetail("");
    setMsg("Thanks, sent to the admin.");
    load();
  }

  return (
    <div className="page">

      <section className="card">
        <h2>Request or report something</h2>
        <p className="muted">Missing an album? No lyrics? Wrong cover or artist photo? Let the admin know.</p>
        <form onSubmit={submit} className="report-form">
          <select className="select" value={kind} onChange={e => setKind(e.target.value)}>
            {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input
            value={subject} onChange={e => setSubject(e.target.value)}
            placeholder="Artist, album or song"
          />
          <textarea
            value={detail} onChange={e => setDetail(e.target.value)}
            placeholder="Any extra detail (optional)" rows={3}
          />
          <div className="report-actions">
            <button className="btn primary" type="submit">Send request</button>
            {msg && <span className="muted">{msg}</span>}
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Your requests</h2>
        {mine.length === 0 && <p className="muted">You haven't sent any yet.</p>}
        <ul className="report-list">
          {mine.map(r => {
            const rgid = reportRgid(r);
            return (
              <li key={r.id}>
                {rgid && <img className="report-thumb" src={api.discoCoverUrl(rgid)} alt="" onError={e => (e.currentTarget.style.visibility = "hidden")} />}
                <div className="report-main">
                  <span className="report-kind">{KIND_LABELS[r.kind] ?? r.kind}</span>
                  <span className="report-subject">{r.subject}</span>
                  {reportDetailText(r) && <span className="report-detail">{reportDetailText(r)}</span>}
                </div>
                <span className={`status-badge ${r.status}`}>{r.status}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
