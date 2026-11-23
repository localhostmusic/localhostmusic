import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import './index.css'
import App from './App.tsx'
import { registerSW } from './sw-update'
import { dlog } from './ui/debugLog'

// Measured viewport height for the standalone (home-screen) app shell. iOS PWAs
// disagree between devices about 100vh/100dvh, but window.innerHeight is right on
// all of them. Only resize/orientation update it: the layout viewport is stable
// while the keyboard is open.
{
  // On some launches iOS gives a home-screen app a viewport short by the status bar
  // (797 of 844 on a 390x844 iPhone) and leaves the bottom blank. Making the document
  // as tall as the screen fixes it (see .ios-vp-fill). position: fixed on the body does
  // not. On by default, Account > Diagnostics can turn it off.
  const setAppHeight = () => {
    const root = document.documentElement
    let h = window.innerHeight
    let fill = false
    const nav = navigator as Navigator & { standalone?: boolean }
    const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)
    let optIn = true
    try { optIn = localStorage.getItem("lhm-vpfill") !== "0" } catch { /* */ }
    if (optIn && ios && nav.standalone === true && window.innerHeight > window.innerWidth) {
      const full = Math.max(screen.height, screen.width)
      const gap = full - window.innerHeight
      if (gap > 8 && gap <= 70) { h = full; fill = true; root.style.setProperty("--vp-gap", `${gap}px`) }
    }
    root.style.setProperty("--app-height", `${h}px`)
    root.classList.toggle("ios-vp-fill", fill)
  }
  setAppHeight()
  window.addEventListener("resize", setAppHeight)
  window.addEventListener("orientationchange", setAppHeight)
  // iOS can correct the short viewport without firing `resize`, so measure again
  // at the moments it tends to settle.
  window.addEventListener("pageshow", setAppHeight)
  document.addEventListener("visibilitychange", setAppHeight)
  window.visualViewport?.addEventListener("resize", setAppHeight)
  for (const ms of [0, 150, 600, 2000]) setTimeout(setAppHeight, ms)

  // What the phone reports, for the ?debug log. The strip cannot be reproduced off-device.
  const reportViewport = (when: string) => {
    try {
      const probe = document.createElement("div")
      probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:100dvh;visibility:hidden;pointer-events:none;"
        + "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:border-box"
      document.body.appendChild(probe)
      const r = probe.getBoundingClientRect()
      const cs = getComputedStyle(probe)
      dlog(`viewport ${when} inner=${window.innerWidth}x${window.innerHeight} doc=${document.documentElement.clientHeight}`
        + ` screen=${screen.width}x${screen.height} vv=${Math.round(window.visualViewport?.height ?? -1)}`
        + ` dvh=${Math.round(r.height)} fixedBottom=${Math.round(r.bottom)} safeTop=${cs.paddingTop} safeBottom=${cs.paddingBottom}`
        + ` standalone=${(navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches}`
        + ` fill=${document.documentElement.classList.contains("ios-vp-fill")} scrollH=${document.documentElement.scrollHeight} scrollY=${Math.round(window.scrollY)}`)
      probe.remove()
    } catch { /* diagnostics only */ }
  }
  window.addEventListener("load", () => { reportViewport("load"); setTimeout(() => reportViewport("+3s"), 3000) })
  window.addEventListener("pageshow", () => reportViewport("pageshow"))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Installable + offline (app shell + audio). Shows a "Refresh" toast when a newer
// build is deployed.
registerSW()
