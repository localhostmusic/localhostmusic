// Fills in download links from the latest GitHub release, and the changelog page.
const REPO = "localhostmusic/localhostmusic";
const RELEASES = `https://github.com/${REPO}/releases`;

function platform() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (/android|iphone|ipad/.test(navigator.userAgent.toLowerCase())) return "mobile";
  if (p.includes("win")) return "windows";
  if (p.includes("linux") || p.includes("x11")) return "linux";
  if (p.includes("mac")) return "mac";
  return "other";
}

const size = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const pick = (assets, test) => assets.find((a) => test(a.name));

async function downloads() {
  const targets = document.querySelectorAll("[data-download]");
  if (!targets.length) return;
  const os = platform();
  // Works without the API too: every link already points at the releases page.
  const hero = document.querySelector("[data-download='auto']");
  const label = { windows: "Download for Windows", linux: "Download for Linux" }[os];
  if (hero && label) hero.querySelector("b").textContent = label;
  if (hero && (os === "mac" || os === "mobile")) {
    const note = document.querySelector("[data-os-note]");
    if (note) note.textContent = os === "mac"
      ? "There is no macOS build yet. On a Mac you can run the server and use it in the browser."
      : "The desktop app is for Windows and Linux. Open this page on your computer to download it.";
  }
  let rel;
  try { rel = await (await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)).json(); } catch { return; }
  if (!rel?.assets) return;
  const files = {
    windows: pick(rel.assets, (n) => /Setup.*\.exe$/.test(n)),
    portable: pick(rel.assets, (n) => /portable\.exe$/.test(n)),
    appimage: pick(rel.assets, (n) => n.endsWith(".AppImage")),
    deb: pick(rel.assets, (n) => n.endsWith(".deb")),
  };
  files.linux = files.appimage;
  files.auto = files[os] ?? null;
  for (const el of targets) {
    const file = files[el.dataset.download];
    if (!file) continue;
    el.href = file.browser_download_url;
    const meta = el.querySelector("[data-meta]");
    if (meta) meta.textContent = `Version ${rel.tag_name.replace(/^v/, "")} · ${size(file.size)}`;
  }
  for (const el of document.querySelectorAll("[data-version]")) el.textContent = rel.tag_name.replace(/^v/, "");
}

// Release notes are written in a small subset of Markdown. Escape first, then format.
function notes(md) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  let html = "", list = false;
  const close = () => { if (list) { html += "</ul>"; list = false; } };
  for (const raw of (md || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    if (line.startsWith("## ")) { close(); html += `<h3>${inline(line.slice(3))}</h3>`; }
    else if (/^[-*] /.test(line)) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(line.slice(2))}</li>`; }
    else { close(); html += `<p>${inline(line)}</p>`; }
  }
  close();
  return html;
}

async function changelog() {
  const box = document.querySelector("[data-changelog]");
  if (!box) return;
  try {
    const list = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`)).json();
    if (!Array.isArray(list) || !list.length) throw new Error("empty");
    box.innerHTML = list.filter((r) => !r.draft).map((r, i) => `
      <article class="release">
        <header>
          <h2>${r.tag_name.replace(/^v/, "")}</h2>
          <time datetime="${r.published_at}">${new Date(r.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</time>
          ${i === 0 ? '<span class="latest">Latest</span>' : ""}
        </header>
        ${notes(r.body) || "<p>Fixes and small improvements.</p>"}
      </article>`).join("");
  } catch {
    box.innerHTML = `<p>The list could not be loaded. See the <a href="${RELEASES}">releases on GitHub</a>.</p>`;
  }
}

downloads();
changelog();
