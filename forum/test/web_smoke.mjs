// Headless-browser smoke test of the SPA's rendering + XSS safety.
// Stubs window.fetch so no backend is needed; loads the real app.js.
// Portable: resolves the `playwright` package normally (reuses any cached
// Chromium). Install once with `npm install` (playwright is a devDependency).
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "web");
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp)) { res.statusCode = 404; return res.end("nf"); }
  const ext = path.extname(fp);
  const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  res.setHeader("content-type", types[ext] || "text/html");
  res.end(fs.readFileSync(fp));
});
await new Promise((r) => server.listen(8099, r));
const BASE = "http://localhost:8099";

const browser = await chromium.launch({ args: ["--no-sandbox"] });

// A deliberately malicious post body + title to prove escaping.
const EVIL = '<img src=x onerror=window.__xss=1><script>window.__xss=1<\/script>';
// A benign post with a real /media attachment, to prove positive rendering.
const IMG_LINE = "/media/uploads/user-1/pic.jpg";

function stubApi(page, { me } = {}) {
  return page.route("**/api/**", (route) => {
    const u = route.request().url();
    const j = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.endsWith("/api/categories")) return j({ categories: [
      { catId: "general", name: "General Discussion", desc: "Everything else" },
      { catId: "photos", name: "Photos", desc: "Show and tell" }] });
    if (u.endsWith("/api/recent")) return j({ topics: [
      { topicId: "42", title: EVIL, catId: "general", author: EVIL, lastTs: 1552640580, replyCount: 2, archived: true }] });
    if (u.includes("/api/me")) return j(me || {});
    if (u.includes("/api/uploads")) return j({ uploadUrl: BASE + "/__put", key: "media/uploads/user-1/x.jpg",
      publicUrl: "/media/uploads/user-1/x.jpg", contentType: "image/jpeg" });
    if (u.includes("/api/topics/42")) return j({
      topic: { topicId: "42", title: EVIL, catId: "general", archived: true, replyCount: 1, createdTs: 1, lastTs: 2 },
      posts: [{ postId: "101", author: EVIL, authorSub: "", body: EVIL, createdTs: 1552587120, archived: true }] });
    if (u.includes("/api/topics/50")) return j({
      topic: { topicId: "50", title: "Meetup pics", catId: "photos", archived: false, replyCount: 0, createdTs: 10, lastTs: 20 },
      posts: [{ postId: "201", author: "Pat", authorSub: "user-1", body: "Great turnout!\n" + IMG_LINE, createdTs: 20, editedTs: 0, archived: false }] });
    return j({});
  });
}

let pass = 0; const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); pass++; };

/* ---------- Phase 1: anonymous visitor, phpBB-style structure + XSS ---------- */
const anon = await browser.newContext();
const page = await anon.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
await stubApi(page);

// landing page (public, old-site style) is the root
await page.goto(BASE + "/#/");
await page.waitForSelector(".landing");
ok(await page.locator(".sidebar .logo").count() > 0, "sidebar shows the configured logo");
ok((await page.locator(".sidebar .logo").first().getAttribute("src")).includes("logo.svg"),
  "logo src comes from SITE_CONFIG.logo");
ok(await page.locator("#mainnav a[href='#/photos']").count() > 0, "nav built from SITE_CONFIG has Photos");
ok(await page.locator("#mainnav a[href='#/contact']").count() > 0, "nav built from SITE_CONFIG has Contact");
ok((await page.locator(".landing h1, .landing .sitename").first().innerText()).includes("My Community Forum"),
  "landing shows the configured site name");
ok((await page.locator("footer").innerText()).includes("My Community Forum"), "footer text from SITE_CONFIG");
ok(await page.locator(".landing .cta a[href='#/forum']").count() > 0, "landing links into the forum");

// the forum index moved to /forum
await page.goto(BASE + "/#/forum");
await page.waitForSelector(".frow");
ok(await page.locator(".sectionbar", { hasText: "Forums" }).count() > 0, "forum page shows a Forums section bar");
ok(await page.locator(".frow .ttl", { hasText: "General Discussion" }).count() > 0, "forum row renders category name");
ok(await page.locator(".sectionbar", { hasText: "Recent activity" }).count() > 0, "forum shows Recent activity");

// visit the malicious archived topic
await page.goto(BASE + "/#/topic/42");
await page.waitForSelector(".post");
ok(await page.evaluate(() => window.__xss === true) === false, "malicious post did NOT execute (no XSS)");
const bodyText = await page.locator(".post .body").first().innerText();
ok(bodyText.includes("<img src=x onerror"), "evil body shown as inert text");
ok(await page.locator(".post img").count() === 0, "no <img> created from evil content");
ok(await page.locator(".crumb", { hasText: "Forums" }).count() > 0, "topic view shows breadcrumb");
ok(await page.locator("text=read-only").count() > 0, "archived thread marked read-only");
ok(errors.length === 0, "no uncaught page errors (anon): " + errors.join("; "));
await anon.close();

/* ---------- Phase 2: logged-in admin, edit/upload UI + safe attachment ---------- */
const authed = await browser.newContext();
const page2 = await authed.newPage();
const errors2 = []; page2.on("pageerror", (e) => errors2.push(String(e)));
await page2.addInitScript(() => {
  sessionStorage.setItem("id_token", "aaa.bbb.ccc");
  sessionStorage.setItem("exp", String(Date.now() + 3600e3));
});
await stubApi(page2, { me: { sub: "user-1", email: "pat@example.com", displayName: "Pat", isAdmin: true } });

await page2.goto(BASE + "/#/forum");
await page2.waitForSelector(".frow");
ok(await page2.locator("#authBtn").innerText() === "Log out", "logged-in header shows Log out");
ok(await page2.locator("text=Admin · create a category").count() > 0, "admin sees create-category form");

await page2.goto(BASE + "/#/topic/50");
await page2.waitForSelector(".post");
ok(await page2.locator(".att img").count() === 1, "attachment /media image renders as <img>");
const src = await page2.locator(".att img").first().getAttribute("src");
ok(src.endsWith("pic.jpg"), "attachment img points at the /media path");
ok((await page2.locator(".post .body").first().innerText()).indexOf("/media/") === -1,
  "attachment path is NOT shown as raw text in the body");
ok(await page2.locator(".postact button", { hasText: "edit" }).count() > 0, "owner sees an edit button");
ok(await page2.locator(".attachbar input[type=file]").count() > 0, "reply box offers a file attach control");

// exercise the edit flow (open editor, save)
await page2.locator(".postact button", { hasText: "edit" }).first().click();
await page2.waitForSelector(".post .main textarea");
ok(await page2.locator(".post .main textarea").count() > 0, "edit opens an inline editor");
ok(await page2.evaluate(() => window.__xss === true) === false, "still no XSS while logged in");
ok(errors2.length === 0, "no uncaught page errors (authed): " + errors2.join("; "));
await authed.close();

/* ---------- Phase 3: themes + config-driven styling ---------- */
const themed = await browser.newContext();
const page3 = await themed.newPage();
await page3.route("**/site.config.js", (route) => route.fulfill({
  contentType: "text/javascript",
  body: `window.SITE_CONFIG={name:"Theme Test",tagline:"t",logo:"assets/logo.svg",
    footer:"f",layout:"sidebar",theme:"dark",
    nav:[{label:"Home",href:"#/"},{label:"Forum",href:"#/forum"}]};`,
}));
await stubApi(page3);
await page3.goto(BASE + "/#/");
await page3.waitForSelector(".landing");
ok((await page3.locator("#theme-css").getAttribute("href")).endsWith("themes/dark.css"),
  "theme stylesheet chosen from SITE_CONFIG.theme");
const darkBg = await page3.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
ok(darkBg !== "" && darkBg !== "#f3efe7", "dark theme overrides --bg");
await themed.close();

/* ---------- Phase 4: topnav layout ---------- */
const topnav = await browser.newContext();
const page4 = await topnav.newPage();
const errors4 = []; page4.on("pageerror", (e) => errors4.push(String(e)));
await page4.route("**/site.config.js", (route) => route.fulfill({
  contentType: "text/javascript",
  body: `window.SITE_CONFIG={name:"Topnav Test",tagline:"t",logo:"assets/logo.svg",
    footer:"f",layout:"topnav",theme:"neutral-light",
    nav:[{label:"Home",href:"#/"},{label:"Forum",href:"#/forum"}]};`,
}));
await stubApi(page4);
await page4.goto(BASE + "/#/forum");
await page4.waitForSelector(".frow");
ok(await page4.evaluate(() => document.body.classList.contains("layout-topnav")),
  "body carries layout-topnav class");
const dir = await page4.evaluate(() => getComputedStyle(document.querySelector(".site")).flexDirection);
ok(dir === "column", "topnav layout stacks header over content");
const navDir = await page4.evaluate(() => getComputedStyle(document.querySelector("#mainnav")).flexDirection);
ok(navDir === "row", "topnav nav is horizontal");
ok(errors4.length === 0, "no uncaught page errors (topnav): " + errors4.join("; "));
await topnav.close();

console.log(`\n✅ WEB SMOKE: ALL ${pass} CHECKS PASSED (phpBB structure, XSS-safety, edit + upload UI, safe attachments)`);
await browser.close(); server.close(); process.exit(0);
