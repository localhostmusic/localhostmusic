import { useEffect, useState } from "react";
import { DownloadIcon } from "../ui/icons";
import {
  downloadedOnly, setDownloadedOnly, onDownloadedOnlyChange,
  downloadedAlbumIds, downloadedArtistNames, onDownloadsChange,
} from "../player/downloads";

/** The library-wide "only what's on this device" filter, and what it lets through. */
export function useDownloadFilter() {
  const read = () => ({ on: downloadedOnly(), albumIds: downloadedAlbumIds(), artistNames: downloadedArtistNames() });
  const [state, setState] = useState(read);
  // Both events matter: the switch itself, and downloading/removing something
  // while a filtered page is open (which changes what the filter lets through).
  useEffect(() => {
    const refresh = () => setState(read());
    const offOnly = onDownloadedOnlyChange(refresh);
    const offDl = onDownloadsChange(refresh);
    refresh();
    return () => { offOnly(); offDl(); };
  }, []);
  return state;
}

/** Toggle chip for that filter. Every library view that honours it shows one. */
export function DownloadedFilter() {
  const { on } = useDownloadFilter();
  return (
    <div className="chip-row lib-filters">
      <button
        className={`chip chip-icon${on ? " active" : ""}`}
        aria-pressed={on}
        onClick={() => setDownloadedOnly(!on)}
        title={on ? "Showing only downloaded music. Tap to show everything" : "Show only music downloaded to this device"}
      >
        <DownloadIcon size={14} />
        Downloaded
      </button>
    </div>
  );
}
