import { useState } from "react";
import { api } from "../api";
import { deviceToken, rememberProfile, setDeviceToken } from "../auth/profiles";

// Whether this device signs the user in from their tile without a password.
export function DeviceSignIn({ username }: { username: string }) {
  const [on, setOn] = useState(() => !!deviceToken(username));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function flip() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (on) {
        const token = deviceToken(username);
        if (token) await api.dropDeviceToken(token).catch(() => {});
        setDeviceToken(username, null); setOn(false);
      } else {
        setDeviceToken(username, (await api.createDeviceToken()).token);
        rememberProfile(username); setOn(true);
      }
    } catch (e: any) { setErr(e?.message || "Could not change that."); }
    finally { setBusy(false); }
  }

  return (
    <div className="tier-row device-signin">
      <div className="tier-row-main">
        <button type="button" role="switch" aria-checked={on} aria-label="Don't ask for my password on this device"
          className={`tier-switch${on ? " on" : ""}`} disabled={busy} onClick={flip}>
          <span className="tier-switch-knob" />
        </button>
        <span className="tier-text">
          <span className="tier-label">Don't ask for my password on this device</span>
          <span className="tier-hint">
            Your tile on the sign-in page opens your account directly. Anyone who uses this device can do the same,
            so keep it for devices you trust. Changing your password turns it off everywhere.
          </span>
        </span>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
