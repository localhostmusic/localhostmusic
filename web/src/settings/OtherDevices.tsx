import { useEffect, useState } from "react";
import { toast } from "../ui/toast";

// Desktop app with its built-in library: let phones, TVs and other computers on the
// same network connect to it. The shell restarts the library to change who can reach it.

interface NetworkState { enabled: boolean; port: number; addresses: string[] }
interface Bridge {
  network?: () => Promise<NetworkState | null>;
  setNetwork?: (enabled: boolean) => Promise<NetworkState | null>;
}
const desktop = (window as any).lhmDesktop as Bridge | undefined;
export const canShareOnNetwork = !!desktop?.network && !!desktop?.setNetwork;

export function OtherDevices({ userCount }: { userCount: number }) {
  const [state, setState] = useState<NetworkState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { desktop?.network?.().then(setState).catch(() => {}); }, []);
  if (!state) return null;

  async function flip() {
    if (busy || !state) return;
    setBusy(true);
    // The app reloads this page when the library has restarted.
    try { const next = await desktop!.setNetwork!(!state.enabled); if (next) setState(next); }
    catch { toast("Could not change that"); }
    finally { setBusy(false); }
  }
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("Address copied"), () => {});

  return (
    <section className="card">
      <h2>Other devices</h2>
      <p className="muted">Play this library on your phone, TV or another computer while this app is open.</p>
      <div className="tier-row other-devices-switch">
        <div className="tier-row-main">
          <button type="button" role="switch" aria-checked={state.enabled} aria-label="Let other devices on my network connect"
            className={`tier-switch${state.enabled ? " on" : ""}`} disabled={busy} onClick={flip}>
            <span className="tier-switch-knob" />
          </button>
          <span className="tier-text">
            <span className="tier-label">Let other devices on my network connect</span>
            <span className="tier-hint">
              {busy ? "Restarting the library…"
                : state.enabled ? "On. Turning it off restarts the library and disconnects the other devices."
                : "Off, only this computer can reach the library. Turning it on restarts the library, which takes a few seconds."}
            </span>
          </span>
        </div>
      </div>

      {state.enabled && (
        <div className="other-devices">
          {state.addresses.length === 0 ? (
            <p className="err">This computer does not seem to be on a network right now.</p>
          ) : (
            <>
              <p className="other-devices-lead">On the other device, open a browser or the Localhost Music app and enter:</p>
              <ul className="other-devices-list">
                {state.addresses.map(a => (
                  <li key={a}>
                    <code>{a}</code>
                    <button type="button" className="btn" onClick={() => copy(a)}>Copy</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="other-devices-notes muted">
            <li>
              {userCount <= 1
                ? <><strong>Add a user first.</strong> Create a name and password under Users below; that is what you sign in with on the other device.</>
                : "Sign in there with an account from Users below."}
            </li>
            <li>Both devices need to be on the same Wi-Fi or router, and this app has to stay open.</li>
            <li>If Windows asks whether to allow network access, choose Allow.</li>
          </ul>
        </div>
      )}
    </section>
  );
}
