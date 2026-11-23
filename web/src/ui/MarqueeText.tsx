import { useEffect, useRef, useState } from "react";

// Single-line text that ellipsizes; when it overflows, it gets the `ov` class and
// CSS scrolls it on hover of the surrounding card/row (see .marquee-inner.ov rules).
export function MarqueeText({ text, className = "" }: { text: string; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(0);

  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current, i = innerRef.current;
      if (!w || !i) return;
      const o = i.scrollWidth - w.clientWidth;
      setOver(o > 4 ? o : 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div className={`marquee ${className}`} ref={wrapRef} title={text}>
      <span
        ref={innerRef}
        className={`marquee-inner${over > 0 ? " ov" : ""}`}
        style={over > 0 ? ({ "--dist": `-${over}px`, "--dur": `${Math.max(2.5, over / 45)}s` } as React.CSSProperties) : undefined}
      >
        {text}
      </span>
    </div>
  );
}
