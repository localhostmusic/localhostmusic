import { useState } from "react";
import { StarIcon } from "./icons";

// A 5-star rating control. `value` is the current rating (0-5); clicking star N
// sets it to N, or clears it (0) if N is already the value. Hover previews.
export function Stars({ value, onRate, size = 15 }: {
  value: number;
  onRate: (n: number) => void;
  size?: number;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <span className="stars" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star-btn${n <= shown ? " on" : ""}`}
          onMouseEnter={() => setHover(n)}
          onClick={(e) => { e.stopPropagation(); onRate(n === value ? 0 : n); }}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          title={`${n} star${n > 1 ? "s" : ""}`}
        >
          <StarIcon size={size} filled={n <= shown} />
        </button>
      ))}
    </span>
  );
}
