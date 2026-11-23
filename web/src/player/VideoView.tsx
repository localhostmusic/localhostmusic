import { useEffect, useRef, useState } from "react";
import { usePlayer } from "./PlayerProvider";
import { FullscreenIcon } from "../ui/icons";

// Mounts the engine's persistent <video> element into the Now Playing art area
// for a video podcast episode. The element is engine-owned: on unmount it goes
// back to the engine's offscreen holder so playback continues. Fullscreen targets
// this container.
export function VideoView() {
  const p = usePlayer();
  const ref = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const el = p.getVideoElement();
    const host = ref.current;
    if (!el || !host) return;
    host.insertBefore(el, host.firstChild); // behind the fullscreen button
    return () => { p.homeVideo(); };
  }, [p]);

  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen().catch(() => {});
  };

  return (
    <div className={`np-video${fs ? " fs" : ""}`} ref={ref} onDoubleClick={toggleFs}>
      <button className="np-video-fs" onClick={toggleFs} title={fs ? "Exit fullscreen" : "Fullscreen"}
        aria-label={fs ? "Exit fullscreen video" : "Fullscreen video"}>
        <FullscreenIcon exit={fs} />
      </button>
    </div>
  );
}
