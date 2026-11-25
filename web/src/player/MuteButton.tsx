import { usePlayer } from "./PlayerProvider";
import { VolumeIcon, VolumeMuteIcon } from "../ui/icons";

// The volume to go back to when unmuting. Shared by the button and the M key.
let beforeMute = 0.8;

export function toggleMute(p: { volume: number; setVolume(v: number): void }): boolean {
  if (p.volume > 0) { beforeMute = p.volume; p.setVolume(0); return true; }
  p.setVolume(beforeMute || 0.8);
  return false;
}

// The speaker icon beside a volume slider: click to mute, click again to restore.
export function MuteButton({ size = 18 }: { size?: number }) {
  const p = usePlayer();
  const muted = p.volume === 0;
  return (
    <button type="button" className={`mute-btn${muted ? " muted" : ""}`} onClick={() => toggleMute(p)}
      aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} title={muted ? "Unmute" : "Mute"}>
      {muted ? <VolumeMuteIcon size={size} /> : <VolumeIcon size={size} />}
    </button>
  );
}
