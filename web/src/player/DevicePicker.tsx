import { useState } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "./PlayerProvider";
import { DevicesIcon } from "../ui/icons";

// "Connect to a device" control: a cast button that opens a roster of the
// user's connected devices and lets playback be transferred between them.
export function DevicePicker({ size = 18, className = "" }: { size?: number; className?: string }) {
  const p = usePlayer();
  const [open, setOpen] = useState(false);

  // Hidden until the realtime channel is up and there is more than one device.
  const playingElsewhere = !!p.activeDeviceName;
  if (!p.connected) return null;

  const others = p.devices.length > 1;

  const popover = open && createPortal(
    <>
      <div className="dp-backdrop" onClick={() => setOpen(false)} />
      <div className="dp-pop" role="menu">
        <div className="dp-head">
          <span>Connect</span>
          <button className="dp-rename" onClick={() => {
            const name = prompt("Name this device", p.devices.find(d => d.id === p.myDeviceId)?.name || "");
            if (name) p.renameDevice(name);
          }}>Rename</button>
        </div>
        {p.devices.length === 0 && <div className="dp-empty">No devices connected.</div>}
        {p.devices.map(d => {
          const isMe = d.id === p.myDeviceId;
          return (
            <button
              key={d.id}
              className={`dp-device${d.isActive ? " active" : ""}`}
              onClick={() => { p.transferTo(d.id); setOpen(false); }}
              role="menuitem"
            >
              <span className="dp-dot" />
              <span className="dp-name">
                {d.name}{isMe && <span className="dp-tag">This device</span>}
              </span>
              <span className="dp-status">
                {d.isActive ? "Playing" : isMe ? "Play here" : "Transfer"}
              </span>
            </button>
          );
        })}
      </div>
    </>,
    document.body
  );

  return (
    <>
      <button
        className={`ctl-toggle dp-btn${playingElsewhere ? " active" : ""} ${className}`}
        onClick={() => setOpen(o => !o)}
        aria-label="Connect to a device"
        aria-pressed={playingElsewhere}
        title={playingElsewhere ? `Playing on ${p.activeDeviceName}` : "Connect to a device"}
      >
        <DevicesIcon size={size} active={playingElsewhere || others} />
      </button>
      {popover}
    </>
  );
}
