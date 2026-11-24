import { readFileSync } from "node:fs";
const U = "http://localhost:8586/";
export default async c => {
  const login = async (u, p) => {
    await c.send("Page.navigate", { url: U }); await c.sleep(2500);
    if (await c.at(".login-link", "Use another account")) { await c.tap(".login-link", "Use another account"); await c.sleep(300); }
    await c.tap("input[placeholder=Username]"); await c.type(u);
    await c.tap("input[type=password]"); await c.type(p);
    await c.tap(".login button[type=submit]"); await c.sleep(3500);
  };
  const pic = () => c.ev(`(()=>{const a=document.querySelector('.my-avatar');if(!a)return 'no avatar element';const i=a.querySelector('img');return i&&i.complete&&i.naturalWidth>0?'PICTURE '+i.getAttribute('src'):'initial "'+a.textContent+'"'})()`);
  await c.send("Network.clearBrowserCookies");
  await login("cdptest", "cdptest123");
  // give cdptest a picture (a red square), through the app's own upload route
  console.log("upload:", await c.ev(`(async()=>{const cv=document.createElement('canvas');cv.width=cv.height=64;const g=cv.getContext('2d');g.fillStyle='#d22';g.fillRect(0,0,64,64);const r=await fetch('/api/me/avatar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:cv.toDataURL('image/jpeg')})});return r.status})()`));
  await c.send("Page.navigate", { url: U }); await c.sleep(3000);
  console.log("cdptest  :", await pic());
  await c.tap("button", "Sign out"); await c.sleep(2000);
  await login("cdptest2", readFileSync(new URL("./t2.pw", import.meta.url), "utf8").trim());
  console.log("cdptest2 :", await pic(), "| signed in as", await c.ev("fetch('/api/me').then(r=>r.json()).then(u=>u.username)"));
  await c.tap("button", "Sign out"); await c.sleep(1500);
};
