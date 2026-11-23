import { useState } from "react";
import { api } from "../api";
import { PlaylistIcon } from "../ui/icons";

// Shows the playlist's custom cover, or falls back to a collage of its tracks'
// album art (2x2 when there are 4+ albums, single otherwise), or an icon.
export function PlaylistCover({ id, hasCover, albumIds, version, className = "" }: {
  id: number;
  hasCover: boolean;
  albumIds: number[];
  version?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (hasCover && !failed) {
    return (
      <img
        className={`pl-cover ${className}`}
        src={`${api.playlistCoverUrl(id)}${version ? `?v=${version}` : ""}`}
        alt="" onError={() => setFailed(true)}
      />
    );
  }
  const ids = albumIds.filter(a => a != null).slice(0, 4);
  if (ids.length === 0) {
    return <div className={`pl-cover placeholder ${className}`}><PlaylistIcon size={28} /></div>;
  }
  if (ids.length < 4) {
    return <img className={`pl-cover ${className}`} src={api.coverUrl(ids[0], 300)} alt="" />;
  }
  return (
    <div className={`pl-cover collage ${className}`}>
      {ids.map((a, i) => <img key={i} src={api.coverUrl(a, 160)} alt="" />)}
    </div>
  );
}
