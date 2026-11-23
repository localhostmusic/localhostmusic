// Service-worker registration + update detection. Fires a "sw:update" window event
// when a newer build is live, so the app can show a "Refresh" toast. Two cases:
//  - a new service worker (the waiting worker),
//  - a JS/CSS-only deploy that leaves sw.js identical, detected by comparing the
//    bundle hash in a freshly fetched index.html to the one this page loaded.

let announced = false;
function announce() {
  if (announced) return;
  announced = true;
  window.dispatchEvent(new CustomEvent("sw:update"));
}

// The hashed app bundle this page is currently running.
function currentBundle(): string | null {
  const el = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
    .find(s => /\/assets\/index-[\w-]+\.js/.test(s.getAttribute("src") || ""));
  return el?.getAttribute("src") || null;
}

async function checkBundle() {
  try {
    const res = await fetch("/index.html", { cache: "no-store" });
    if (!res.ok) return;
    const deployed = (await res.text()).match(/\/assets\/index-[\w-]+\.js/)?.[0] || null;
    const cur = currentBundle();
    if (deployed && cur && deployed !== cur) announce();
  } catch { /* offline */ }
}

export function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  // When a new worker takes control (after the user opts in), reload once.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) { reloaded = true; window.location.reload(); }
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(reg => {
      const watch = (w: ServiceWorker | null) => {
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) announce();
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) announce(); // update installed in a past session
      reg.addEventListener("updatefound", () => watch(reg.installing));
      reg.update?.();

      // Re-check periodically and whenever the app returns to the foreground.
      const check = () => { reg.update?.(); checkBundle(); };
      setInterval(check, 30 * 60 * 1000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
    }).catch(() => {});
  });
}

// Apply the update: activate a waiting worker (controllerchange then reloads), or
// just reload when it is a JS-only change.
export async function applyUpdate() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg?.waiting) { reg.waiting.postMessage("skipWaiting"); return; }
  } catch { /* */ }
  window.location.reload();
}
