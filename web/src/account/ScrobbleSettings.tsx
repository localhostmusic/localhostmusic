import { useEffect, useState } from "react";
import { api } from "../api";

type Accounts = { lastfmAvailable: boolean; accounts: { provider: string; username?: string }[] };

// Tell the Scrobbler to re-check whether anything is connected.
const notifyChanged = () => window.dispatchEvent(new Event("lhm-scrobble-changed"));

export function ScrobbleSettings() {
  const [data, setData] = useState<Accounts | null>(null);
  const [lbToken, setLbToken] = useState("");
  const [pending, setPending] = useState(""); // which action is in flight ("" = idle)
  const [err, setErr] = useState("");
  const [lfmPending, setLfmPending] = useState<{ token: string } | null>(null);

  const load = () => api.scrobbleAccounts().then(setData).catch(() => {});
  useEffect(() => { load(); }, []);

  const connected = (p: string) => data?.accounts.find(a => a.provider === p);
  const busy = !!pending;

  async function connectLB() {
    const token = lbToken.trim();
    if (!token) return;
    setPending("lb"); setErr("");
    try { await api.connectListenBrainz(token); setLbToken(""); await load(); notifyChanged(); }
    catch { setErr("Couldn't connect. Double-check the token."); }
    finally { setPending(""); }
  }
  async function disconnect(p: string) {
    setPending("dc:" + p); setErr("");
    try { await api.disconnectScrobble(p); await load(); notifyChanged(); } finally { setPending(""); }
  }
  async function startLastfm() {
    setPending("lfm"); setErr("");
    try {
      const r: any = await api.lastfmConnect();
      setLfmPending({ token: r.token });
      window.open(r.authUrl, "_blank", "noopener");
    } catch { setErr("Couldn't reach Last.fm."); }
    finally { setPending(""); }
  }
  async function completeLastfm() {
    if (!lfmPending) return;
    setPending("lfmc"); setErr("");
    try { await api.lastfmComplete(lfmPending.token); setLfmPending(null); await load(); notifyChanged(); }
    catch { setErr("Not authorized yet. Approve Localhost Music in the Last.fm tab, then try again."); }
    finally { setPending(""); }
  }

  if (!data) return <p className="account-section-sub">Loading…</p>;
  const lb = connected("listenbrainz");
  const lfm = connected("lastfm");

  return (
    <div className="scrobble">
      <p className="account-section-sub">
        Optional. Report the songs you play to a listening-history service. Nothing is sent unless you connect an account below.
      </p>

      <div className="scrobble-svc">
        <div className="scrobble-svc-head">
          <strong>ListenBrainz</strong>
          {lb && <span className="scrobble-on">Connected{lb.username ? ` · ${lb.username}` : ""}</span>}
        </div>
        {lb ? (
          <button className="btn" disabled={busy} onClick={() => disconnect("listenbrainz")}>
            {pending === "dc:listenbrainz" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : (
          <>
            <div className="scrobble-connect">
              <input className="scrobble-input" placeholder="Your ListenBrainz user token" value={lbToken}
                onChange={e => setLbToken(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
              <button className="btn primary" disabled={busy || !lbToken.trim()} onClick={connectLB}>
                {pending === "lb" ? "Connecting…" : "Connect"}
              </button>
            </div>
            <p className="account-section-sub scrobble-hint">
              Find your token at <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener noreferrer">listenbrainz.org/settings</a>.
            </p>
          </>
        )}
      </div>

      <div className="scrobble-svc">
        <div className="scrobble-svc-head">
          <strong>Last.fm</strong>
          {lfm && <span className="scrobble-on">Connected{lfm.username ? ` · ${lfm.username}` : ""}</span>}
        </div>
        {!data.lastfmAvailable ? (
          <p className="account-section-sub">Not enabled on this server.</p>
        ) : lfm ? (
          <button className="btn" disabled={busy} onClick={() => disconnect("lastfm")}>
            {pending === "dc:lastfm" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : lfmPending ? (
          <div className="scrobble-connect">
            <span className="account-section-sub">Approve Localhost Music in the Last.fm tab, then:</span>
            <button className="btn primary" disabled={busy} onClick={completeLastfm}>
              {pending === "lfmc" ? "Finishing…" : "I’ve approved, finish"}
            </button>
          </div>
        ) : (
          <button className="btn primary" disabled={busy} onClick={startLastfm}>
            {pending === "lfm" ? "Opening Last.fm…" : "Connect Last.fm"}
          </button>
        )}
      </div>

      {err && <p className="scrobble-err">{err}</p>}
    </div>
  );
}
