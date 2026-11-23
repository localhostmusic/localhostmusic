import { useState, useEffect } from "react";
import { api } from "../api";
import { nameTint } from "../ui/artColors";

// Shows the artist photo if one exists, falling back to a gradient monogram.
// `version` busts the cache after an image is fetched/uploaded.
export function ArtistAvatar({ id, name, large, version }: {
  id: number;
  name?: string;
  large?: boolean;
  version?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [id, version]);

  const cls = `artist-avatar${large ? " lg" : ""}`;
  const monogram = (name || "?").slice(0, 1).toUpperCase();

  if (failed) return <span className={cls}>{monogram}</span>;
  return (
    <img
      className={`${cls} img`}
      // The tint shows through until the photo paints (an <img>'s background is
      // visible while it loads). No opacity fade here: it would hide the tint too.
      style={{ backgroundColor: nameTint(name) }}
      src={`${api.artistImageUrl(id, 300)}${version ? `&v=${version}` : ""}`}
      alt=""
      loading="lazy" decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
