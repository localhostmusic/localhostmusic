import { useSyncExternalStore } from "react";
import { onCacheClear, isLibraryMutation } from "../api";
let revision = 0;
const subscribers = new Set<() => void>();
onCacheClear(url => {
  if (!isLibraryMutation(url)) return;
  revision++;
  subscribers.forEach(fn => fn());
});
const subscribe = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
export function useLibraryRevision() { return useSyncExternalStore(subscribe, () => revision, () => 0); }
