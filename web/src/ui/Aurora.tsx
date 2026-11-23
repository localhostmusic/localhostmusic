// Ambient animated background: soft color blobs behind frosted glass. Each blob is a
// radial gradient that only animates `transform`, so it stays on the compositor.
// Colors come from the --aurora-* custom properties.
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span className="blob b1" />
      <span className="blob b2" />
      <span className="blob b3" />
      <span className="grain" />
    </div>
  );
}
