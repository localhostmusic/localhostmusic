// Node 24 defines globalThis.localStorage as an accessor that returns undefined
// without --localstorage-file, and it shadows jsdom's implementation. Install an
// in-memory Storage instead.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (globalThis[name] == null) {
    Object.defineProperty(globalThis, name, {
      value: memoryStorage(), configurable: true, writable: true, enumerable: false,
    });
  }
}
