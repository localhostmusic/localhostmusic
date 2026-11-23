// null = whole resource; false = an unsatisfiable/unsupported range.
export function parseByteRange(range: string | undefined, size: number): [number, number] | null | false {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = NaN, end = NaN;
  if (m?.[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  else if (m?.[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  return !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end ? false : [start, end];
}
