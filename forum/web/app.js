/* Serverless community forum — vanilla-JS SPA.
   Security note: user-supplied text is ALWAYS inserted with textContent / DOM
   nodes, never innerHTML — so no stored post can inject script into the page.
   Attachments are only ever rendered from our own /media/ paths. */
(() => {
"use strict";
const CFG = window.FORUM_CONFIG;
const app = document.getElementById("app");
const $ = (t, props = {}, kids = []) => {
  const e = document.createElement(t);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;          // safe text
    else if (k === "html") throw new Error("no innerHTML");
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) e.append(kid);
  return e;
};
const fmt = (ts) => ts ? new Date(ts * 1000).toLocaleString() : "";
const replies = (n) => `${n} ${n === 1 ? "reply" : "replies"}`;
// Social providers are wired even before their app credentials exist; set
// FORUM_CONFIG.socialProviders to [] to hide the buttons until you configure them.
const SOCIAL = Array.isArray(CFG.socialProviders) ? CFG.socialProviders : ["Google", "Facebook"];

function catIcon(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("photo")) return "📷";
  if (n.includes("recipe")) return "📖";
  if (n.includes("event") || n.includes("gather")) return "📅";
  if (n.includes("meeting")) return "📋";
  if (n.includes("newsletter")) return "📰";
  if (n.includes("food")) return "🍔";
  if (n.includes("sale")) return "🏷️";
  return "💬";
}

/* ------------------------------------------------------------ auth (PKCE) */
const store = window.sessionStorage;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(s){ return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); }
function randStr(n=64){ const a=new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a,x=>("0"+x.toString(16)).slice(-2)).join(""); }

// Direct Cognito Identity Provider API (unauthenticated flows) — lets us run the
// whole login/sign-up in-page over HTTPS. Cognito still does the real auth.
const COGNITO_REGION = (String(CFG.cognitoDomain).match(/auth\.([a-z0-9-]+)\.amazoncognito/) || [])[1] || "us-east-1";
async function cip(target, body){
  const res = await fetch(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok){
    const code = String(data.__type || "").split("#").pop() || "Error";
    throw Object.assign(new Error(data.message || code), { code });
  }
  return data;
}

const auth = {
  idToken: store.getItem("id_token") || null,
  expUntil: +store.getItem("exp") || 0,
  refreshToken: store.getItem("refresh_token") || null,
  profile: null,
  get loggedIn(){ return !!this.idToken && Date.now() < this.expUntil; },
  get sub(){ return this.profile?.sub || null; },
  get isAdmin(){ return !!this.profile?.isAdmin; },
  save(t){                                   // OAuth (social) token response
    this.saveTokens({ IdToken: t.id_token, RefreshToken: t.refresh_token });
  },
  saveTokens(a){                             // Cognito API AuthenticationResult
    if (!a.IdToken) return;
    this.idToken = a.IdToken;
    this.expUntil = JSON.parse(atob(a.IdToken.split(".")[1])).exp * 1000;
    store.setItem("id_token", a.IdToken);
    store.setItem("exp", String(this.expUntil));
    if (a.RefreshToken){ this.refreshToken = a.RefreshToken; store.setItem("refresh_token", a.RefreshToken); }
  },
  clear(){ this.idToken=null; this.expUntil=0; this.refreshToken=null; this.profile=null;
    store.removeItem("id_token"); store.removeItem("exp"); store.removeItem("refresh_token"); },
  // ---- embedded email/password flows (Cognito API) ----
  async signIn(email, password){
    const r = await cip("InitiateAuth", { ClientId: CFG.clientId, AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password } });
    if (!r.AuthenticationResult) throw new Error("Additional verification is required.");
    this.saveTokens(r.AuthenticationResult);
  },
  signUp(email, password, attrs){
    return cip("SignUp", { ClientId: CFG.clientId, Username: email, Password: password,
      UserAttributes: [{ Name: "email", Value: email }, ...(attrs || [])] });
  },
  confirmSignUp(email, code){
    return cip("ConfirmSignUp", { ClientId: CFG.clientId, Username: email, ConfirmationCode: code });
  },
  resendCode(email){ return cip("ResendConfirmationCode", { ClientId: CFG.clientId, Username: email }); },
  forgot(email){ return cip("ForgotPassword", { ClientId: CFG.clientId, Username: email }); },
  confirmForgot(email, code, password){
    return cip("ConfirmForgotPassword", { ClientId: CFG.clientId, Username: email,
      ConfirmationCode: code, Password: password });
  },
  async tryRefresh(){                          // extend the session with the refresh token
    const rt = this.refreshToken || store.getItem("refresh_token");
    if (!rt) return false;
    try {
      const r = await cip("InitiateAuth", { ClientId: CFG.clientId, AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: rt } });
      if (r.AuthenticationResult){ this.saveTokens({ ...r.AuthenticationResult, RefreshToken: rt }); return true; }
    } catch (_){ this.clear(); }
    return false;
  },
  async login(idp){ return this._go("oauth2/authorize", idp); },
  async signup(){ return this._go("signup"); },          // Cognito hosted registration page
  async _go(path, idp){
    const verifier = randStr(48);
    store.setItem("pkce_verifier", verifier);
    const challenge = b64url(await sha256(verifier));
    const u = new URL(`https://${CFG.cognitoDomain}/${path}`);
    const params = { response_type:"code", client_id:CFG.clientId, redirect_uri:CFG.redirectUri,
      scope:"openid email profile", code_challenge:challenge, code_challenge_method:"S256" };
    if (idp) params.identity_provider = idp;   // jump straight to Google/Facebook
    u.search = new URLSearchParams(params);
    location.assign(u.toString());
  },
  logout(){
    this.clear();
    const u = new URL(`https://${CFG.cognitoDomain}/logout`);
    u.search = new URLSearchParams({ client_id:CFG.clientId, logout_uri:CFG.redirectUri });
    location.assign(u.toString());
  },
  async handleRedirect(){
    const q = new URLSearchParams(location.search);
    if (!q.get("code")) return;
    const verifier = store.getItem("pkce_verifier") || "";
    const res = await fetch(`https://${CFG.cognitoDomain}/oauth2/token`, {
      method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:"authorization_code", client_id:CFG.clientId,
        code:q.get("code"), redirect_uri:CFG.redirectUri, code_verifier:verifier }),
    });
    if (res.ok){ this.save(await res.json()); }
    history.replaceState({}, "", location.pathname + location.hash);
  },
};

/* ------------------------------------------------------------ API client */
async function api(path, { method="GET", body, authd=false } = {}){
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (authd){
    if (!auth.loggedIn){ go("/login"); throw Object.assign(new Error("login required"),{status:401}); }
    headers["authorization"] = "Bearer " + auth.idToken;  // API GW JWT authorizer expects Bearer
  }
  const res = await fetch(CFG.apiBase + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

/* ------------------------------------------------------------ attachments */
const IMG_RE = /\.(jpe?g|png|gif|webp)$/i;
// Split a stored body into visible text + attachment paths (our /media/ URLs
// which the upload flow appended on their own lines).
function splitBody(body){
  const text = [], atts = [];
  for (const line of (body || "").split(/\r?\n/)){
    const t = line.trim();
    if (/^\/media\/\S+$/.test(t)) atts.push(t); else text.push(line);
  }
  return { text: text.join("\n").replace(/\n{3,}/g,"\n\n").trim(), atts };
}
function attachmentsNode(atts){
  if (!atts.length) return null;
  const box = $("div",{class:"att"});
  atts.forEach(u => box.append(
    IMG_RE.test(u) ? $("img",{src:u, alt:"attachment", loading:"lazy"})
                   : $("a",{class:"file", href:u, target:"_blank", rel:"noopener",
                           text:"📎 " + decodeURIComponent(u.split("/").pop())})));
  return box;
}
async function uploadFile(file){
  if (!file.type) throw new Error("unknown file type");
  const meta = await api("/uploads",{method:"POST", authd:true,
    body:{ contentType:file.type, filename:file.name, size:file.size }});
  const put = await fetch(meta.uploadUrl,{method:"PUT",
    headers:{ "content-type": meta.contentType }, body:file });
  if (!put.ok) throw new Error("upload failed ("+put.status+")");
  return meta.publicUrl;
}
// Upload a photo into the gallery bucket (purpose:"gallery"); returns its
// public /media/gallery/... URL to attach to an album.
async function uploadGallery(file){
  if (!file.type) throw new Error("unknown file type");
  const meta = await api("/uploads",{method:"POST", authd:true,
    body:{ contentType:file.type, filename:file.name, size:file.size, purpose:"gallery" }});
  const put = await fetch(meta.uploadUrl,{method:"PUT",
    headers:{ "content-type": file.type }, body:file });
  if (!put.ok) throw new Error("upload failed ("+put.status+")");
  return meta.publicUrl;
}
// A file picker that appends the uploaded /media/ URL onto a textarea.
function attachWidget(textarea){
  const input = $("input",{type:"file", accept:"image/*,application/pdf"});
  const status = $("span",{class:"muted"});
  input.addEventListener("change", async () => {
    const f = input.files[0]; if (!f) return;
    status.textContent = "Uploading " + f.name + "…";
    try{
      const url = await uploadFile(f);
      const cur = textarea.value.replace(/\s*$/,"");
      textarea.value = (cur ? cur + "\n" : "") + url + "\n";
      status.textContent = "Attached " + f.name;
    }catch(e){ status.textContent = "Upload failed: " + e.message; }
    input.value = "";
  });
  return $("div",{class:"attachbar"},[ $("span",{text:"Attach a photo or PDF:"}), input, status ]);
}

/* ------------------------------------------------------------ router */
const routes = [
  [/^$/,                        () => viewLanding()],
  [/^forum$/,                   () => viewForum()],
  [/^about$/,                   () => viewAbout()],
  [/^contact$/,                 () => viewContact()],
  [/^links$/,                   () => viewLinks()],
  [/^photos$/,                  () => viewPhotos()],
  [/^photos\/(.+)$/,            (m) => viewAlbum(decodeURIComponent(m[1]))],
  [/^category\/([^/]+)$/,       (m) => viewCategory(decodeURIComponent(m[1]))],
  [/^topic\/([^/]+)$/,          (m) => viewTopic(decodeURIComponent(m[1]))],
  [/^new\/([^/]+)$/,            (m) => viewNewTopic(decodeURIComponent(m[1]))],
  [/^profile$/,                 () => viewProfile()],
  [/^members$/,                 () => viewMembers()],
  [/^user\/([^/]+)$/,           (m) => viewUser(decodeURIComponent(m[1]))],
  [/^admin$/,                   () => viewAdmin()],
  [/^login$/,                   () => viewLogin()],
];
function go(hash){ location.hash = hash; }
function paintNav(){
  const cur = location.hash || "#/";
  document.querySelectorAll("#mainnav a").forEach(a => {
    const href = a.getAttribute("href");
    a.classList.toggle("active", href === "#/" ? cur === "#/" : cur.startsWith(href));
  });
}
async function render(){
  const h = location.hash.replace(/^#\/?/, "");
  paintNav();
  for (const [re, fn] of routes){ const m = h.match(re); if (m){ try{ await fn(m); }catch(e){ showErr(e); } return; } }
  go("");
}
function setBusy(){ app.replaceChildren($("p",{class:"muted",text:"Loading…"})); }
function showErr(e){ app.replaceChildren($("div",{class:"err",
  text:(e.status===401?"Please log in to do that. ":"")+(e.message||"Something went wrong.")})); }
function crumb(parts){
  const c = $("div",{class:"crumb"});
  parts.forEach((p,i) => {
    if (i) c.append(document.createTextNode(" › "));
    c.append(p.href ? $("a",{href:p.href,text:p.text}) : $("b",{text:p.text}));
  });
  return c;
}
function panel(title, action){
  return $("div",{class:"sectionbar"},[ $("span",{text:title}), action || null ]);
}

/* ------------------------------------------------------------ views */
// Public landing page. No login needed.
async function viewLanding(){
  const site = window.SITE_CONFIG || {};
  let intro = site.tagline || "";   // admins can override this on the homepage via Admin → Site Pages
  try{ const pg = await api("/pages/home"); if (pg && pg.body) intro = pg.body; }catch(_){}
  const hero = $("div",{class:"landing"},[
    $("h1",{class:"sitename",text:site.name || ""}),
    $("p",{class:"intro",text:intro}),
    $("div",{class:"cta"},[
      $("a",{class:"btn",href:"#/forum",text:"Enter the Forum →"}),
      $("a",{class:"btn ghost",href:"#/photos",text:"Photos"}),
    ]),
  ]);
  const nodes = [hero];
  // announcements (public), posted by admins — never let a failed call break the landing
  try{
    const { announcements } = await api("/announcements");
    const list = (announcements || []).slice(0, 5);
    if (list.length){
      const wrap = $("div",{class:"homefeed"});
      wrap.append(panel("Announcements"));
      const panelEl = $("div",{class:"panel"});
      list.forEach(a => panelEl.append($("div",{class:"frow"},[
        $("div",{class:"ic",text:"📣"}),
        $("div",{},[ $("b",{text:a.title||""}),
          $("div",{class:"body",text:a.body||""}) ]),
        $("div",{class:"stat",text:fmt(a.createdTs)}),
      ])));
      wrap.append(panelEl);
      nodes.push(wrap);
    }
  }catch(_){ /* announcements are a nicety; never block the landing on them */ }
  // new members welcome (members-only — profiles aren't public)
  if (auth.loggedIn){
    try{
      const { members } = await api("/members",{authd:true});
      const recent = (members || []).slice().sort((a,b)=>(b.joinTs||0)-(a.joinTs||0)).slice(0,6);
      if (recent.length){
        const wrap = $("div",{class:"homefeed"});
        wrap.append(panel("Welcome, new members", $("a",{class:"act",href:"#/members",text:"All members →"})));
        const strip = $("div",{class:"newmembers"});
        recent.forEach(m => strip.append($("a",{class:"nm",href:`#/user/${encodeURIComponent(m.sub)}`},[
          $("img",{class:"nmav",src:m.avatar||AVATAR_FALLBACK,alt:m.displayName||"",loading:"lazy"}),
          $("div",{class:"nmname",text:m.displayName||"Member"}),
          m.town ? $("div",{class:"nmtown",text:m.town}) : null,
        ])));
        wrap.append($("div",{class:"panel"},[strip]));
        nodes.push(wrap);
      }
    }catch(_){ /* never block the landing on this */ }
  }
  // a live teaser of recent forum activity (public), under the classic hero
  try{
    const {topics} = await api("/recent");
    if (topics && topics.length){
      const feed = $("div",{class:"homefeed"});
      feed.append(panel("Latest from the forum",
        $("a",{class:"act",href:"#/forum",text:"All forums →"})));
      const list = $("div",{class:"panel"});
      topics.slice(0,6).forEach(t => list.append($("div",{class:"frow"},[
        $("div",{class:"ic",text:"🧵"}),
        $("div",{},[ linkTopic(t),
          $("div",{class:"sub",text:`by ${t.author||"?"} · ${replies(t.replyCount||0)}`}) ]),
        $("div",{class:"stat",text:fmt(t.lastTs)}),
      ])));
      feed.append(list);
      nodes.push(feed);
    }
  }catch(_){ /* forum feed is a nicety; never block the landing on it */ }
  app.replaceChildren(...nodes);
}

// Default text for the editable pages — shown until an admin saves their own.
const PAGE_DEFAULTS = {
  home: { title: "", body: "" },
  about: { title: "About us",
    body: "Tell visitors about your community here.\n\nReading the site is open to "
      + "everyone. To post in the forum, register a free member account and log in."
      + "\n\nAdmins: edit this page from Admin → Site Pages." },
  contact: { title: "Contact us",
    body: "How can people reach you? Add an email or social links here.\n\nAdmins: "
      + "edit this page from Admin → Site Pages." },
};

// Turn plain text into safe DOM: bare http(s) URLs become links; everything else is a
// text node (never innerHTML), preserving the stored-XSS defense.
function textWithLinks(text){
  const frag = document.createDocumentFragment();
  (text || "").split(/(https?:\/\/[^\s]+)/g).forEach(part => {
    if (!part) return;
    if (/^https?:\/\//.test(part))
      frag.append($("a",{ href:part, target:"_blank", rel:"noopener", text:part }));
    else frag.append(document.createTextNode(part));
  });
  return frag;
}

async function viewPage(slug, crumbLabel){
  setBusy();
  const def = PAGE_DEFAULTS[slug];
  let title = def.title, body = def.body;
  try {
    const pg = await api(`/pages/${slug}`);
    if (pg && pg.body){ title = pg.title || def.title; body = pg.body; }
  } catch(_){ /* fall back to the built-in default */ }
  const bodyEl = $("div",{class:"body pagebody"});
  bodyEl.append(textWithLinks(body));
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:crumbLabel}]),
    $("div",{class:"card prose"},[ $("h2",{text:title}), bodyEl,
      slug === "about" ? $("a",{class:"btn",href:"#/forum",text:"Go to the Member Forum"}) : null ]));
}
const viewAbout = () => viewPage("about", "About Us");
const viewContact = () => viewPage("contact", "Contact Us");

// Default links — shown until an admin edits the list.
const LINKS_DEFAULT = [
  { name: "Example link — edit this list in Admin → Links", url: "https://example.com" },
];
async function loadLinks(){
  try{ const { links } = await api("/links"); if (links && links.length) return links; }catch(_){}
  return LINKS_DEFAULT;
}
async function viewLinks(){
  setBusy();
  const links = await loadLinks();
  const list = $("div",{class:"panel"});
  links.forEach(({ name, url }) => list.append($("div",{class:"frow"},[
    $("div",{class:"ic",text:"🔗"}),
    $("div",{},[ $("a",{href:url,target:"_blank",rel:"noopener",text:name}),
      $("div",{class:"sub",text:url}) ]),
    $("div",{class:"stat"}),
  ])));
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:"Links"}]),
    panel("Links"), list);
}

/* ------------------------------------------------------------ photos */
// Albums + photos now come from the API. Photo entries are {t: thumbnail,
// f: full-res}; tolerate legacy string entries.
const thumbOf = (p) => typeof p === "string" ? p : p.t;
const fullOf  = (p) => typeof p === "string" ? p : (p.f || p.t);
async function viewPhotos(){
  setBusy();
  const { albums } = await api("/albums");
  const list = albums || [];
  const grid = $("div",{class:"albumgrid"});
  list.forEach(a => grid.append($("a",{class:"albumcard",href:`#/photos/${encodeURIComponent(a.albumId)}`},[
    $("img",{class:"cover",src:a.cover||"", alt:a.name||"", loading:"lazy"}),
    $("div",{class:"meta"},[ $("div",{class:"t",text:a.name||""}),
      $("div",{class:"c",text:`${a.count||0} photo${a.count===1?"":"s"}`}) ]),
  ])));
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:"Photos"}]),
    panel("Photo Albums"),
    list.length ? grid : $("div",{class:"empty",text:"No albums."}),
    $("p",{class:"muted",text:"Click any photo for the full-size image."}));
}
async function viewAlbum(albumId){
  setBusy();
  let data;
  try{ data = await api(`/albums/${encodeURIComponent(albumId)}/photos`); }
  catch(_){ go("/photos"); return; }
  const alb = data.album || { albumId, name: albumId, count: (data.photos||[]).length };
  const photos = data.photos || [];
  const fulls = photos.map(fullOf);
  const grid = $("div",{class:"photogrid"});
  photos.forEach((p, idx) => grid.append(
    $("img",{src:thumbOf(p), alt:alb.name||"", loading:"lazy", onclick:()=>lightbox(fulls, idx)})));
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:"Photos",href:"#/photos"},{text:alb.name||""}]),
    panel(alb.name||"", $("span",{class:"act",text:`${alb.count||photos.length} photos`})),
    photos.length ? grid : $("div",{class:"empty",text:"No photos in this album yet."}));
}
// Full-screen viewer. Pass a single URL, or an array + start index to browse the
// whole album with arrows / keyboard (←/→, Esc) / swipe.
function lightbox(items, start){
  const list = Array.isArray(items) ? items : [items];
  let i = Math.max(0, Math.min(start | 0, list.length - 1));
  const multi = list.length > 1;
  const img = $("img",{alt:"",onclick:(e)=>e.stopPropagation()});
  const counter = $("div",{class:"lbcount"});
  const show = () => { img.setAttribute("src", list[i]);
    counter.textContent = multi ? `${i + 1} / ${list.length}` : ""; };
  const step = (d, e) => { if (e) e.stopPropagation(); i = (i + d + list.length) % list.length; show(); };
  const onKey = (e) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Escape") close();
  };
  const close = () => { document.removeEventListener("keydown", onKey); box.remove(); };
  const box = $("div",{class:"lightbox",onclick:close},[
    $("span",{class:"x",text:"×","aria-label":"Close",onclick:(e)=>{e.stopPropagation();close();}}),
    multi ? $("button",{class:"lbnav prev","aria-label":"Previous photo",text:"‹",onclick:(e)=>step(-1,e)}) : null,
    img,
    multi ? $("button",{class:"lbnav next","aria-label":"Next photo",text:"›",onclick:(e)=>step(1,e)}) : null,
    counter,
  ]);
  // swipe on touch devices
  let sx = 0;
  img.addEventListener("touchstart",(e)=>{ sx = e.changedTouches[0].clientX; },{passive:true});
  img.addEventListener("touchend",(e)=>{ const dx = e.changedTouches[0].clientX - sx;
    if (multi && Math.abs(dx) > 40) step(dx < 0 ? 1 : -1); },{passive:true});
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  show();
}

async function viewForum(){
  setBusy();
  const [{categories}, {topics}] = await Promise.all([ api("/categories"), api("/recent") ]);
  const nodes = [];

  const forums = $("div",{class:"panel"});
  if (categories.length){
    categories.forEach(c => forums.append($("div",{class:"frow"},[
      $("div",{class:"ic",text:catIcon(c.name)}),
      $("div",{},[ $("a",{class:"ttl",href:`#/category/${encodeURIComponent(c.catId)}`,text:c.name}),
        c.desc ? $("div",{class:"sub",text:c.desc}) : null ]),
      $("div",{class:"stat",text:""}),
    ])));
  } else forums.append($("div",{class:"empty",text:"No categories yet."}));
  nodes.push(panel("Forums"), forums);

  if (auth.isAdmin) nodes.push(adminNewCategory());

  const recent = $("div",{class:"panel"});
  if (topics.length){
    topics.forEach(t => recent.append($("div",{class:"frow"},[
      $("div",{class:"ic",text:"🧵"}),
      $("div",{},[ linkTopic(t),
        $("div",{class:"sub",text:`by ${t.author||"?"} · ${replies(t.replyCount||0)}`}) ]),
      $("div",{class:"stat",text:fmt(t.lastTs)}),
    ])));
  } else recent.append($("div",{class:"empty",text:"No discussion yet — be the first to post!"}));
  nodes.push(panel("Recent activity"), recent);

  app.replaceChildren(...nodes);
}

function linkTopic(t){
  return $("span",{},[ $("a",{href:`#/topic/${encodeURIComponent(t.topicId)}`,text:t.title||"(untitled)"}),
    t.archived ? $("span",{class:"badge",text:"archived"}) : null ]);
}

function adminNewCategory(){
  const id=$("input",{placeholder:"id (optional, e.g. recipes)"});
  const name=$("input",{placeholder:"Category name"});
  const desc=$("input",{placeholder:"Short description"});
  return $("div",{class:"card stack"},[
    $("b",{text:"Admin · create a category"}),
    name, desc, id,
    $("button",{class:"btn sm",text:"Create category",onclick:async()=>{
      const n=name.value.trim(); if(!n){alert("Name required");return;}
      try{ await api("/categories",{method:"POST",authd:true,
        body:{name:n,desc:desc.value.trim(),catId:id.value.trim()||undefined}});
        viewHome(); }catch(e){ alert(e.message); }
    }}) ]);
}

async function viewCategory(catId){
  setBusy();
  const [{categories}, {topics}] = await Promise.all([
    api("/categories"), api(`/categories/${encodeURIComponent(catId)}/topics`) ]);
  const cat = categories.find(c => c.catId === catId) || { catId, name: catId };
  const action = auth.loggedIn
    ? $("a",{class:"act",href:`#/new/${encodeURIComponent(catId)}`,text:"+ New topic"})
    : $("a",{class:"act",href:"#/login",text:"Log in to post"});
  const list = $("div",{class:"panel"});
  if (topics.length){
    topics.forEach(t => list.append($("div",{class:"frow"},[
      $("div",{class:"ic",text:"🧵"}),
      $("div",{},[ linkTopic(t),
        $("div",{class:"sub",text:`started by ${t.author||"?"} · ${replies(t.replyCount||0)}`}) ]),
      $("div",{class:"stat",text:fmt(t.lastTs)}),
    ])));
  } else list.append($("div",{class:"empty",text:"No topics in this category yet."}));
  app.replaceChildren(
    crumb([{text:"Forums",href:"#/forum"},{text:cat.name}]),
    panel(cat.name, action), list);
}

async function viewTopic(topicId){
  setBusy();
  const {topic, posts} = await api(`/topics/${encodeURIComponent(topicId)}`);
  const nodes = [
    crumb([{text:"Forums",href:"#/forum"},
           {text:topic.catId,href:`#/category/${encodeURIComponent(topic.catId)}`},
           {text:topic.title||"(untitled)"}]),
    $("h2",{},[ document.createTextNode(topic.title||"(untitled)"),
      topic.archived ? $("span",{class:"badge",text:"archived"}) : null ]),
  ];
  // logged-in members see author avatars + profile links (profiles are members-only)
  const profiles = {};
  if (auth.loggedIn){
    const subs = [...new Set(posts.map(p => p.authorSub).filter(Boolean))];
    await Promise.all(subs.map(async (s) => {
      try{ profiles[s] = await api(`/users/${encodeURIComponent(s)}`,{authd:true}); }catch(_){}
    }));
  }
  const wrap = $("div",{class:"panel"});
  posts.forEach(p => wrap.append(postNode(topicId, topic, p, profiles)));
  nodes.push(wrap);

  if (topic.archived){
    nodes.push($("p",{class:"muted",text:"This thread is archived from the original forum and is read-only."}));
  } else if (auth.loggedIn){
    const ta = $("textarea",{placeholder:"Write a reply…"});
    nodes.push($("div",{class:"card stack"},[ $("b",{text:"Post a reply"}), ta, attachWidget(ta),
      $("button",{class:"btn",text:"Post reply",onclick:async()=>{
        const body=ta.value.trim(); if(!body){alert("Write something first");return;}
        try{ await api(`/topics/${encodeURIComponent(topicId)}/posts`,{method:"POST",authd:true,body:{body}});
          viewTopic(topicId); }catch(e){ alert(e.message); }
      }}) ]));
  } else {
    nodes.push($("p",{class:"muted"},[ document.createTextNode("Please "),
      $("a",{href:"#/login",text:"log in"}), document.createTextNode(" to reply.") ]));
  }
  app.replaceChildren(...nodes);
}

function postNode(topicId, topic, p, profiles){
  const mine = auth.loggedIn && auth.sub && p.authorSub === auth.sub;
  const canEdit = auth.loggedIn && (auth.isAdmin || (mine && !p.archived));
  const canDel  = auth.loggedIn && (auth.isAdmin || (mine && !p.archived));
  const prof = (profiles && p.authorSub) ? profiles[p.authorSub] : null;
  const userHref = (auth.loggedIn && p.authorSub) ? `#/user/${encodeURIComponent(p.authorSub)}` : null;
  const node = $("div",{class:"post"});
  const side = $("div",{class:"side"});
  if (prof && prof.avatar) side.append($("a",{href:userHref},[ $("img",{class:"pav",src:prof.avatar,alt:p.author||""}) ]));
  side.append(
    userHref ? $("a",{class:"name",href:userHref,text:p.author||"?"}) : $("div",{class:"name",text:p.author||"?"}),
    $("div",{class:"role",text:p.archived?"legacy member":"member"}));
  node.append(side);
  const main = $("div",{class:"main"});
  main.append($("div",{class:"stamp"},[
    $("span",{text:"Posted "+fmt(p.createdTs)}),
    p.editedTs ? $("span",{text:"edited "+fmt(p.editedTs)}) : null ]));
  const { text, atts } = splitBody(p.body);
  const bodyEl = $("div",{class:"body",text:text});
  main.append(bodyEl);
  const attEl = attachmentsNode(atts); if (attEl) main.append(attEl);

  if (canEdit || canDel){
    const act = $("div",{class:"postact"});
    if (canEdit) act.append($("button",{class:"btn ghost sm",text:"edit",onclick:()=>
      startEdit(topicId, p, node)}));
    if (canDel) act.append($("button",{class:"btn danger sm",text:"delete",onclick:async()=>{
      if(!confirm("Delete this post?"))return;
      try{ await api(`/topics/${encodeURIComponent(topicId)}/posts/${encodeURIComponent(p.postId)}`,
        {method:"DELETE",authd:true}); viewTopic(topicId); }catch(e){ alert(e.message); }
    }}));
    main.append(act);
  }
  node.append(main);
  return node;
}

function startEdit(topicId, p, node){
  const main = node.querySelector(".main");
  const ta = $("textarea",{}); ta.value = p.body || "";
  const editor = $("div",{class:"stack"},[ ta, attachWidget(ta),
    $("div",{class:"postact"},[
      $("button",{class:"btn sm",text:"Save",onclick:async()=>{
        const body=ta.value.trim(); if(!body){alert("Post can't be empty");return;}
        try{ await api(`/topics/${encodeURIComponent(topicId)}/posts/${encodeURIComponent(p.postId)}`,
          {method:"PUT",authd:true,body:{body}}); viewTopic(topicId); }catch(e){ alert(e.message); }
      }}),
      $("button",{class:"btn ghost sm",text:"Cancel",onclick:()=>viewTopic(topicId)}),
    ]) ]);
  // replace body + attachments + actions with the editor
  main.replaceChildren(main.querySelector(".stamp"), editor);
}

async function viewNewTopic(catId){
  if (!auth.loggedIn){ go("/login"); return; }
  const title=$("input",{placeholder:"Topic title"});
  const body=$("textarea",{placeholder:"Say something…"});
  app.replaceChildren(
    crumb([{text:"Forums",href:"#/forum"},
           {text:catId,href:`#/category/${encodeURIComponent(catId)}`},
           {text:"New topic"}]),
    $("div",{class:"card stack"},[ $("b",{text:"New topic"}), title, body, attachWidget(body),
      $("button",{class:"btn",text:"Create topic",onclick:async()=>{
        const t=title.value.trim(), b=body.value.trim(); if(!t||!b){alert("Title and body required");return;}
        try{ const r=await api(`/categories/${encodeURIComponent(catId)}/topics`,
          {method:"POST",authd:true,body:{title:t,body:b}}); go(`/topic/${r.topicId}`);
        }catch(e){ alert(e.message); }
      }}) ]));
}

async function uploadAvatar(file){
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  const meta = await api("/uploads",{method:"POST",authd:true,
    body:{ contentType:file.type, filename:file.name, size:file.size, purpose:"avatar" }});
  const put = await fetch(meta.uploadUrl,{method:"PUT",headers:{"content-type":meta.contentType},body:file});
  if (!put.ok) throw new Error("upload failed ("+put.status+")");
  return meta.publicUrl;
}
const AVATAR_FALLBACK = "assets/logo.svg";

async function viewProfile(){
  if (!auth.loggedIn){ go("/login"); return; }
  setBusy();
  const me = await api("/me",{authd:true}); auth.profile = me;
  let avatar = me.avatar || "";
  const avImg = $("img",{class:"avatar-lg",src:avatar||AVATAR_FALLBACK,alt:"Your profile picture"});
  const file = $("input",{type:"file",accept:"image/*"});
  const upStatus = $("span",{class:"muted"});
  file.addEventListener("change", async()=>{
    const f=file.files[0]; if(!f)return;
    upStatus.textContent="Uploading "+f.name+"…";
    try{ avatar = await uploadAvatar(f); avImg.setAttribute("src",avatar+"?"+Date.now());
      upStatus.textContent="Looks good — click “Save profile” to keep it."; }
    catch(e){ upStatus.textContent="Upload failed: "+e.message; }
    file.value="";
  });
  const name  = $("input",{value:me.displayName||"",placeholder:"Display name"});
  const bio   = $("input",{value:me.bio||"",placeholder:"A line about yourself"});
  const town  = $("input",{value:me.town||"",placeholder:"e.g. Duxbury, MA"});
  const beers = $("textarea",{placeholder:"Things you're into",style:"min-height:70px"}); beers.value=me.interests||"";
  const fb    = $("input",{value:me.facebook||"",placeholder:"facebook.com/you  —or—  @you"});
  const ig    = $("input",{value:me.instagram||"",placeholder:"instagram.com/you  —or—  @you"});
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:"Your profile"}]),
    $("h2",{text:"Your profile"}),
    $("div",{class:"card stack"},[
      $("div",{class:"muted",text:`Signed in as ${me.email}`+(me.isAdmin?" (admin)":"")}),
      $("div",{class:"avatar-edit"},[ avImg,
        $("div",{class:"stack",style:"flex:1;min-width:180px"},[
          $("label",{text:"Profile picture"}),
          $("div",{class:"attachbar"},[ file, upStatus ]),
          $("button",{class:"btn ghost sm",text:"Remove picture",onclick:()=>{
            avatar=""; avImg.setAttribute("src",AVATAR_FALLBACK); upStatus.textContent="Removed — click “Save profile.”"; }}),
        ]) ]),
      $("label",{text:"Display name (shown on your posts)"}), name,
      $("label",{text:"A short title or sentence about you"}), bio,
      $("label",{text:"Town you live in"}), town,
      $("label",{text:"Interests"}), beers,
      $("label",{text:"Facebook"}), fb,
      $("label",{text:"Instagram"}), ig,
      $("div",{class:"row"},[
        $("button",{class:"btn",text:"Save profile",onclick:async()=>{
          const displayName=name.value.trim(); if(!displayName){alert("A display name is required.");return;}
          try{ const saved = await api("/me",{method:"PUT",authd:true,body:{
              displayName, bio:bio.value.trim(), town:town.value.trim(), interests:beers.value.trim(),
              facebook:fb.value.trim(), instagram:ig.value.trim(), avatar }});
            auth.profile = { ...auth.profile, ...saved }; paintAuthUI();
            upStatus.textContent="Saved ✓"; alert("Profile saved.");
          }catch(e){ alert(e.message); }
        }}),
        $("a",{class:"btn ghost",href:`#/user/${encodeURIComponent(me.sub)}`,text:"View my public profile"}),
      ]),
    ]));
}

// Members directory — everyone who's set up a profile. Members only.
async function viewMembers(){
  if (!auth.loggedIn){ go("/login"); return; }
  setBusy();
  let members = [];
  try{ members = (await api("/members",{authd:true})).members || []; }catch(_){}
  const grid = $("div",{class:"membergrid"});
  members.forEach(m => grid.append(
    $("a",{class:"membercard",href:`#/user/${encodeURIComponent(m.sub)}`},[
      $("img",{class:"mav",src:m.avatar||AVATAR_FALLBACK,alt:m.displayName||"",loading:"lazy"}),
      $("div",{class:"minfo"},[
        $("div",{class:"mname",text:m.displayName||"Member"}),
        m.bio ? $("div",{class:"mbio",text:m.bio}) : null,
        m.town ? $("div",{class:"mtown",text:"📍 "+m.town}) : null,
      ]),
    ])));
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:"Members"}]),
    panel("Members", $("span",{class:"act",text:`${members.length} member${members.length===1?"":"s"}`})),
    members.length ? grid
      : $("div",{class:"card"},[ $("p",{class:"muted",text:"No member profiles yet. "
          + "Log in and set up your profile to be the first!"}) ]));
}

// Member profile (read-only), visible to logged-in members, linked from post authors.
async function viewUser(sub){
  if (!auth.loggedIn){ go("/login"); return; }
  setBusy();
  let u;
  try{ u = await api(`/users/${encodeURIComponent(sub)}`,{authd:true}); }
  catch(_){
    app.replaceChildren(crumb([{text:"Home",href:"#/"},{text:"Member"}]),
      $("div",{class:"card"},[ $("p",{class:"muted",text:"This member hasn't set up a profile yet."}) ]));
    return;
  }
  const info = $("div",{class:"stack",style:"flex:1;min-width:180px"});
  info.append($("h2",{text:u.displayName||"Member"}));
  if (u.bio) info.append($("p",{class:"userbio",text:u.bio}));
  const facts = $("div",{class:"userfacts"});
  if (u.town) facts.append($("div",{},[ $("span",{class:"k",text:"Town"}), $("span",{text:u.town}) ]));
  if (u.interests) facts.append($("div",{},[ $("span",{class:"k",text:"Interests"}), $("span",{text:u.interests}) ]));
  if (u.town || u.interests) info.append(facts);
  const social = $("div",{class:"usersocial"});
  if (u.facebook) social.append($("a",{href:u.facebook,target:"_blank",rel:"noopener",text:"Facebook"}));
  if (u.instagram) social.append($("a",{href:u.instagram,target:"_blank",rel:"noopener",text:"Instagram"}));
  if (u.facebook || u.instagram) info.append(social);
  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:u.displayName||"Member"}]),
    $("div",{class:"card userprofile"},[
      $("img",{class:"avatar-lg",src:u.avatar||AVATAR_FALLBACK,alt:u.displayName||""}),
      info,
    ]));
}

/* ------------------------------------------------------------ admin CMS */
// Admin content management: announcements + photo albums. Admins only.
async function viewAdmin(){
  if (!auth.isAdmin){ showErr({ message:"You need to be an admin to view this page." }); return; }
  setBusy();

  /* ---------- Announcements ---------- */
  const annList = $("div",{class:"adminlist"});
  async function loadAnn(){
    let items = [];
    try{ items = (await api("/announcements")).announcements || []; }catch(_){}
    annList.replaceChildren(...(items.length
      ? items.map(annRow)
      : [ $("div",{class:"empty",text:"No announcements yet."}) ]));
  }
  function annRow(a){
    const row = $("div",{class:"adminrow"});
    function view(){
      row.replaceChildren(...[
        $("div",{class:"t",text:a.title||""}),
        $("div",{class:"meta",text:`Posted ${fmt(a.createdTs)}`+(a.author?` · by ${a.author}`:"")}),
        $("div",{class:"body",text:a.body||""}),
        $("div",{class:"rowact"},[
          $("button",{class:"btn ghost sm",text:"Edit",onclick:edit}),
          $("button",{class:"btn danger sm",text:"Delete",onclick:async()=>{
            if(!confirm("Delete this announcement?"))return;
            try{ await api(`/announcements/${encodeURIComponent(a.id)}`,{method:"DELETE",authd:true}); loadAnn(); }
            catch(e){ alert(e.message); }
          }}),
        ]),
      ]);
    }
    function edit(){
      const title = $("input",{value:a.title||"",placeholder:"Title"});
      const body = $("textarea",{placeholder:"Announcement text"}); body.value = a.body||"";
      row.replaceChildren($("div",{class:"stack"},[
        $("label",{text:"Title"}), title,
        $("label",{text:"Message"}), body,
        $("div",{class:"rowact"},[
          $("button",{class:"btn sm",text:"Save",onclick:async()=>{
            const t=title.value.trim(), b=body.value.trim();
            if(!t||!b){alert("Title and message are required.");return;}
            try{ await api(`/announcements/${encodeURIComponent(a.id)}`,{method:"PUT",authd:true,body:{title:t,body:b}});
              a.title=t; a.body=b; view(); }catch(e){ alert(e.message); }
          }}),
          $("button",{class:"btn ghost sm",text:"Cancel",onclick:view}),
        ]),
      ]));
    }
    view();
    return row;
  }
  const annTitle = $("input",{placeholder:"Announcement title"});
  const annBody = $("textarea",{placeholder:"Write your announcement…"});
  const annBox = $("div",{class:"panel",style:"padding:14px 16px"},[
    $("div",{class:"stack"},[
      $("b",{text:"Post a new announcement"}),
      $("label",{text:"Title"}), annTitle,
      $("label",{text:"Message"}), annBody,
      $("button",{class:"btn",text:"Post announcement",onclick:async()=>{
        const t=annTitle.value.trim(), b=annBody.value.trim();
        if(!t||!b){alert("Please enter a title and a message.");return;}
        try{ await api("/announcements",{method:"POST",authd:true,body:{title:t,body:b}});
          annTitle.value=""; annBody.value=""; loadAnn(); }catch(e){ alert(e.message); }
      }}),
    ]),
    annList,
  ]);

  /* ---------- Photo albums ---------- */
  const albList = $("div",{class:"adminlist"});
  async function loadAlbums(){
    let albums = [];
    try{ albums = (await api("/albums")).albums || []; }catch(_){}
    albList.replaceChildren(...(albums.length
      ? albums.map(albRow)
      : [ $("div",{class:"empty",text:"No albums yet."}) ]));
  }
  function photoCell(al, p, refresh){
    const cell = $("div",{class:"pcell"});
    cell.append(
      $("img",{src:thumbOf(p), alt:p.caption||al.name||"", loading:"lazy", onclick:()=>lightbox(fullOf(p))}),
      $("button",{class:"del",text:"Delete",onclick:async()=>{
        if(!confirm("Delete this photo?"))return;
        try{ await api(`/albums/${encodeURIComponent(al.albumId)}/photos/${encodeURIComponent(p.photoId)}`,
          {method:"DELETE",authd:true}); refresh(); }catch(e){ alert(e.message); }
      }}),
      p.caption ? $("div",{class:"cap",text:p.caption}) : null);
    return cell;
  }
  function albRow(al){
    const row = $("div",{class:"adminrow"});
    const grid = $("div",{class:"photogrid"});
    let loaded = false;
    async function loadGrid(){
      let photos = [];
      try{ photos = (await api(`/albums/${encodeURIComponent(al.albumId)}/photos`)).photos || []; }catch(_){}
      grid.replaceChildren(...(photos.length
        ? photos.map(p => photoCell(al, p, loadGrid))
        : [ $("div",{class:"empty",text:"No photos yet — add one below."}) ]));
    }
    const fileInput = $("input",{type:"file",accept:"image/*"});
    const upStatus = $("span",{class:"muted"});
    fileInput.addEventListener("change", async()=>{
      const f = fileInput.files[0]; if(!f)return;
      upStatus.textContent = "Uploading "+f.name+"…";
      try{
        const url = await uploadGallery(f);
        await api(`/albums/${encodeURIComponent(al.albumId)}/photos`,{method:"POST",authd:true,body:{url}});
        upStatus.textContent = "Added "+f.name;
        loadGrid();
      }catch(e){ upStatus.textContent = "Upload failed: "+e.message; }
      fileInput.value = "";
    });
    const manage = $("div",{class:"manage",style:"display:none"},[
      grid,
      $("div",{class:"attachbar"},[ $("span",{text:"Add a photo:"}), fileInput, upStatus ]),
    ]);
    const toggle = $("a",{href:"#",text:"Manage photos",onclick:(e)=>{
      e.preventDefault();
      const open = manage.style.display === "none";
      manage.style.display = open ? "" : "none";
      toggle.textContent = open ? "Hide photos" : "Manage photos";
      if (open && !loaded){ loaded = true; loadGrid(); }
    }});
    row.append(
      $("div",{class:"t",text:al.name||""}),
      $("div",{class:"meta",text:`${al.count||0} photo`+(al.count===1?"":"s")}),
      $("div",{class:"rowact"},[
        toggle,
        $("button",{class:"btn danger sm",text:"Delete album",onclick:async()=>{
          if(!confirm(`Delete the album "${al.name}" and all of its photos?`))return;
          try{ await api(`/albums/${encodeURIComponent(al.albumId)}`,{method:"DELETE",authd:true}); loadAlbums(); }
          catch(e){ alert(e.message); }
        }}),
      ]),
      manage);
    return row;
  }
  const albName = $("input",{placeholder:"Album name (e.g. Summer Picnic 2026)"});
  const albBox = $("div",{class:"panel",style:"padding:14px 16px"},[
    $("div",{class:"stack"},[
      $("b",{text:"Create a new album"}),
      $("label",{text:"Album name"}), albName,
      $("button",{class:"btn",text:"Create album",onclick:async()=>{
        const n=albName.value.trim(); if(!n){alert("Please enter an album name.");return;}
        try{ await api("/albums",{method:"POST",authd:true,body:{name:n}}); albName.value=""; loadAlbums(); }
        catch(e){ alert(e.message); }
      }}),
    ]),
    albList,
  ]);

  /* ---------- Editable pages (Home intro / About / Contact) ---------- */
  function pageEditor(slug, label, bodyOnly){
    const heading = $("input",{placeholder:"Page heading"});
    const body = $("textarea",{placeholder:"Plain text; web links (https://…) become clickable.",
      style:"min-height:150px"});
    const status = $("span",{class:"muted"});
    (async()=>{
      const def = PAGE_DEFAULTS[slug] || {};
      try{ const pg = await api(`/pages/${slug}`);
        heading.value = pg.title || def.title || "";
        body.value = pg.body || def.body || "";
      }catch(_){ heading.value = def.title || ""; body.value = def.body || ""; }
    })();
    return $("div",{class:"panel",style:"padding:14px 16px"},[
      $("div",{class:"stack"},[
        $("b",{text:bodyOnly ? label : `Edit the “${label}” page`}),
        bodyOnly ? null : $("label",{text:"Heading"}),
        bodyOnly ? null : heading,
        $("label",{text:bodyOnly ? "Text" : "Content"}), body,
        $("div",{class:"rowact"},[
          $("button",{class:"btn",text:"Save",onclick:async()=>{
            const t=heading.value.trim(), b=body.value.trim();
            if(!b){ alert("Please enter some text."); return; }
            status.textContent="Saving…";
            try{ await api(`/pages/${slug}`,{method:"PUT",authd:true,body:{title:t,body:b}});
              status.textContent="Saved ✓"; }
            catch(e){ status.textContent="Error: "+e.message; }
          }}),
          status,
        ]),
      ]),
    ]);
  }

  /* ---------- Editable Links list ---------- */
  function linksEditor(){
    const rows = $("div",{class:"stack"});
    const status = $("span",{class:"muted"});
    function addRow(name, url){
      const nm = $("input",{value:name||"",placeholder:"Link name",style:"flex:1;min-width:140px"});
      const u = $("input",{value:url||"",placeholder:"https://…",style:"flex:1.4;min-width:160px"});
      const row = $("div",{class:"linkrow"},[ nm, u,
        $("button",{class:"btn danger sm",text:"✕",title:"remove",onclick:()=>row.remove()}) ]);
      row._get = () => ({ name: nm.value.trim(), url: u.value.trim() });
      rows.append(row);
    }
    (async()=>{ (await loadLinks()).forEach(l => addRow(l.name, l.url)); })();
    return $("div",{class:"panel",style:"padding:14px 16px"},[
      $("div",{class:"stack"},[
        $("b",{text:"Edit the Links list"}),
        $("div",{class:"muted",text:"Each link needs a name and a full web address (https://…)."}),
        rows,
        $("div",{class:"rowact"},[
          $("button",{class:"btn ghost sm",text:"+ Add link",onclick:()=>addRow("","")}),
          $("button",{class:"btn",text:"Save links",onclick:async()=>{
            const links = [...rows.querySelectorAll(".linkrow")].map(r=>r._get())
              .filter(l=>l.name && /^https?:\/\//i.test(l.url));
            status.textContent="Saving…";
            try{ const r = await api("/links",{method:"PUT",authd:true,body:{links}});
              status.textContent=`Saved ${r.count} link${r.count===1?"":"s"} ✓`; }
            catch(e){ status.textContent="Error: "+e.message; }
          }}),
          status,
        ]),
      ]),
    ]);
  }

  /* ---------- Member roster (private contact info) ---------- */
  const rosterBox = $("div",{class:"panel",style:"padding:14px 16px"});
  async function loadRoster(){
    rosterBox.replaceChildren($("p",{class:"muted",text:"Loading member roster…"}));
    let members = [];
    try{ members = (await api("/roster",{authd:true})).members || []; }
    catch(e){ rosterBox.replaceChildren($("p",{class:"err",text:"Couldn't load the roster: "+e.message})); return; }
    if (!members.length){ rosterBox.replaceChildren($("div",{class:"empty",text:"No members yet."})); return; }
    const rows = members.map(m => $("tr",{},[
      $("td",{text:m.name||"—"}),
      $("td",{}, m.email ? [ $("a",{href:"mailto:"+m.email,text:m.email}) ] : [document.createTextNode("—")]),
      $("td",{}, m.phone ? [ $("a",{href:"tel:"+m.phone,text:m.phone}) ] : [document.createTextNode("—")]),
      $("td",{text:m.status==="CONFIRMED"?"active":(m.status||"").toLowerCase().replace(/_/g," ")}),
    ]));
    const table = $("table",{class:"roster"},[
      $("thead",{},[ $("tr",{}, ["Name","Email","Phone","Status"].map(h=>$("th",{text:h}))) ]),
      $("tbody",{}, rows),
    ]);
    rosterBox.replaceChildren(
      $("p",{class:"muted",text:`${members.length} member${members.length===1?"":"s"} · contact details are visible to admins only.`}),
      $("div",{style:"overflow-x:auto"},[ table ]));
  }

  app.replaceChildren(
    crumb([{text:"Home",href:"#/"},{text:"Admin"}]),
    $("p",{class:"muted",text:"Post announcements, edit the homepage intro, the "
      + "About/Contact pages and the Links list, manage the photo albums, and view the member roster."}),
    panel("Announcements"), annBox,
    panel("Homepage & Pages"),
    $("div",{class:"stack"},[
      pageEditor("home","Homepage intro text", true),
      pageEditor("about","About Us"),
      pageEditor("contact","Contact Us"),
      linksEditor(),
    ]),
    panel("Photo Albums"), albBox,
    panel("Member Roster", $("span",{class:"act",text:"admins only"})), rosterBox);
  loadAnn(); loadAlbums(); loadRoster();
}

// Password rules (mirror the Cognito pool policy). Shown up front; ticked live.
const PW_RULES = [
  ["At least 7 characters", (p) => p.length >= 7],
  ["A lowercase letter",    (p) => /[a-z]/.test(p)],
  ["A number",              (p) => /[0-9]/.test(p)],
  ["A special character",   (p) => /[^A-Za-z0-9]/.test(p)],
];
const passwordOK = (p) => PW_RULES.every(([, t]) => t(p));
// Cognito requires phone_number in E.164 (+15085551234). Accept common US formats.
function normalizePhone(v){
  const s = (v || "").replace(/[\s()\-.]/g, "");
  if (/^\+\d{10,15}$/.test(s)) return s;                 // already E.164
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;                  // US 10-digit
  if (d.length === 11 && d[0] === "1") return "+" + d;   // 1 + 10-digit
  return "";                                             // not valid
}
function pwChecklist(){
  const rows = PW_RULES.map(([label]) => $("li",{class:"pwrule"},[
    $("span",{class:"ck",text:"○"}), $("span",{text:label}) ]));
  const el = $("ul",{class:"pwrules"}, rows);
  el.check = (p) => PW_RULES.forEach(([, test], i) => {
    const ok = test(p);
    rows[i].classList.toggle("met", ok);
    rows[i].querySelector(".ck").textContent = ok ? "✓" : "○";
  });
  el.check("");
  return el;
}
function authErr(e){
  return ({
    NotAuthorizedException: "Incorrect email or password.",
    UserNotFoundException: "No account found for that email.",
    UsernameExistsException: "An account with that email already exists — try logging in.",
    CodeMismatchException: "That code isn't right — double-check and try again.",
    ExpiredCodeException: "That code has expired. Request a new one.",
    InvalidPasswordException: "Password doesn't meet the requirements.",
    InvalidParameterException: "Please check the details and try again.",
    LimitExceededException: "Too many attempts — please wait a bit and try again.",
    TooManyRequestsException: "Too many attempts — please wait a bit and try again.",
  })[e.code] || e.message || "Something went wrong.";
}

// Fully embedded login/sign-up/verify/reset — Cognito API over HTTPS, styled to the site.
function viewLogin(){
  if (auth.loggedIn){ go(""); return; }
  const state = { email: "", password: "" };
  const card = $("div",{class:"card stack"});
  app.replaceChildren(crumb([{text:"Home",href:"#/"},{text:"Log in"}]), card);
  const errBox = () => $("div",{class:"err",style:"display:none"});
  const show = (box, msg) => { box.textContent = msg; box.style.display = ""; };
  const backHome = () => $("a",{class:"btn ghost",href:"#/",text:"← Back to Home"});

  function signIn(){
    const err = errBox();
    const email = $("input",{type:"email",placeholder:"Email",value:state.email,autocomplete:"email"});
    const pw = $("input",{type:"password",placeholder:"Password",autocomplete:"current-password"});
    const go_ = async () => {
      err.style.display="none";
      state.email = email.value.trim(); state.password = pw.value;
      if (!state.email || !state.password) return show(err, "Enter your email and password.");
      try {
        await auth.signIn(state.email, state.password);
        auth.profile = await api("/me",{authd:true}); go("");
      } catch(e){
        if (e.code === "UserNotConfirmedException"){ try{ await auth.resendCode(state.email); }catch(_){}; return verify(); }
        show(err, authErr(e));
      }
    };
    pw.addEventListener("keydown",(e)=>{ if(e.key==="Enter") go_(); });
    const social = $("div",{class:"social"});
    SOCIAL.forEach(idp => social.append($("button",{class:"btn",text:`Continue with ${idp}`,onclick:()=>auth.login(idp)})));
    card.replaceChildren(...[
      $("h2",{text:"Log in"}),
      $("p",{class:"muted",text:"Reading the forum is open to everyone — log in to post, reply, and upload photos."}),
      err, $("label",{text:"Email"}), email, $("label",{text:"Password"}), pw,
      $("button",{class:"btn",text:"Log in",onclick:go_}),
      $("div",{class:"authlinks"},[
        $("a",{href:"#",text:"Forgot your password?",onclick:(e)=>{e.preventDefault();state.email=email.value.trim();forgot();}}),
        $("a",{href:"#",text:"Create new login",onclick:(e)=>{e.preventDefault();state.email=email.value.trim();signUp();}}),
      ]),
      SOCIAL.length ? $("div",{class:"muted",text:"or"}) : null,
      SOCIAL.length ? social : null,
      backHome(),
    ].filter(Boolean));
    email.focus();
  }

  function signUp(){
    const err = errBox();
    const first = $("input",{placeholder:"First name",autocomplete:"given-name"});
    const last  = $("input",{placeholder:"Last name",autocomplete:"family-name"});
    const email = $("input",{type:"email",placeholder:"Email",value:state.email,autocomplete:"email"});
    const phone = $("input",{type:"tel",placeholder:"e.g. 508-555-1234",autocomplete:"tel"});
    const pw = $("input",{type:"password",placeholder:"Choose a password",autocomplete:"new-password"});
    const pw2 = $("input",{type:"password",placeholder:"Confirm password",autocomplete:"new-password"});
    const rules = pwChecklist();
    pw.addEventListener("input",()=>rules.check(pw.value));
    const go_ = async () => {
      err.style.display="none";
      const fn = first.value.trim(), ln = last.value.trim();
      state.email = email.value.trim();
      if (!fn || !ln) return show(err, "Please enter your first and last name.");
      if (!state.email) return show(err, "Please enter your email.");
      const ph = normalizePhone(phone.value);
      if (!ph) return show(err, "Please enter a valid phone number, e.g. 508-555-1234.");
      if (!passwordOK(pw.value)) return show(err, "Your password doesn't meet the requirements below.");
      if (pw.value !== pw2.value) return show(err, "The two passwords don't match.");
      state.password = pw.value;
      try {
        await auth.signUp(state.email, state.password, [
          { Name:"given_name", Value:fn }, { Name:"family_name", Value:ln },
          { Name:"name", Value:`${fn} ${ln}` }, { Name:"phone_number", Value:ph } ]);
        verify();
      } catch(e){ show(err, authErr(e)); }
    };
    card.replaceChildren(
      $("h2",{text:"Create your login"}),
      $("p",{class:"muted",text:"Register a free member account. All fields are required."}),
      err,
      $("div",{class:"row2"},[
        $("div",{},[ $("label",{text:"First name"}), first ]),
        $("div",{},[ $("label",{text:"Last name"}), last ]) ]),
      $("label",{text:"Email"}), email,
      $("label",{text:"Phone number"}), phone,
      $("label",{text:"Password"}), pw,
      $("div",{class:"muted",text:"Your password must have:"}), rules,
      $("label",{text:"Confirm password"}), pw2,
      $("button",{class:"btn",text:"Create account",onclick:go_}),
      $("div",{class:"authlinks"},[
        $("a",{href:"#",text:"← Already have a login? Log in",onclick:(e)=>{e.preventDefault();state.email=email.value.trim();signIn();}}),
      ]),
      backHome());
    first.focus();
  }

  function verify(){
    const err = errBox();
    const code = $("input",{placeholder:"Confirmation code",inputmode:"numeric",autocomplete:"one-time-code"});
    const go_ = async () => {
      err.style.display="none";
      if (!code.value.trim()) return show(err, "Enter the code from your email.");
      try {
        await auth.confirmSignUp(state.email, code.value.trim());
        if (state.password){ await auth.signIn(state.email, state.password);
          auth.profile = await api("/me",{authd:true}); go(""); }
        else signIn();
      } catch(e){ show(err, authErr(e)); }
    };
    card.replaceChildren(
      $("h2",{text:"Confirm your email"}),
      $("p",{class:"muted"},[document.createTextNode("We emailed a confirmation code to "),
        $("b",{text:state.email}), document.createTextNode(". Enter it below to finish.")]),
      err, $("label",{text:"Confirmation code"}), code,
      $("button",{class:"btn",text:"Confirm",onclick:go_}),
      $("div",{class:"authlinks"},[
        $("a",{href:"#",text:"Resend code",onclick:async(e)=>{e.preventDefault();
          try{ await auth.resendCode(state.email); show(err,"A new code is on the way."); }catch(x){ show(err,authErr(x)); }}}),
        $("a",{href:"#",text:"Back to log in",onclick:(e)=>{e.preventDefault();signIn();}}),
      ]));
    code.focus();
  }

  function forgot(){
    const err = errBox();
    const email = $("input",{type:"email",placeholder:"Email",value:state.email,autocomplete:"email"});
    const go_ = async () => {
      err.style.display="none";
      state.email = email.value.trim();
      if (!state.email) return show(err, "Enter your email.");
      try { await auth.forgot(state.email); reset(); }
      catch(e){ show(err, authErr(e)); }
    };
    card.replaceChildren(
      $("h2",{text:"Reset your password"}),
      $("p",{class:"muted",text:"Enter your email and we'll send you a reset code."}),
      err, $("label",{text:"Email"}), email,
      $("button",{class:"btn",text:"Send reset code",onclick:go_}),
      $("div",{class:"authlinks"},[
        $("a",{href:"#",text:"← Back to log in",onclick:(e)=>{e.preventDefault();signIn();}}),
      ]));
    email.focus();
  }

  function reset(){
    const err = errBox();
    const code = $("input",{placeholder:"Reset code",inputmode:"numeric",autocomplete:"one-time-code"});
    const pw = $("input",{type:"password",placeholder:"New password",autocomplete:"new-password"});
    const rules = pwChecklist();
    pw.addEventListener("input",()=>rules.check(pw.value));
    const go_ = async () => {
      err.style.display="none";
      if (!code.value.trim()) return show(err, "Enter the reset code from your email.");
      if (!passwordOK(pw.value)) return show(err, "Your password doesn't meet the requirements below.");
      try {
        await auth.confirmForgot(state.email, code.value.trim(), pw.value);
        await auth.signIn(state.email, pw.value);
        auth.profile = await api("/me",{authd:true}); go("");
      } catch(e){ show(err, authErr(e)); }
    };
    card.replaceChildren(
      $("h2",{text:"Set a new password"}),
      $("p",{class:"muted"},[document.createTextNode("Enter the code we emailed to "),
        $("b",{text:state.email}), document.createTextNode(" and choose a new password.")]),
      err, $("label",{text:"Reset code"}), code,
      $("label",{text:"New password"}), pw,
      $("div",{class:"muted",text:"Your password must have:"}), rules,
      $("button",{class:"btn",text:"Reset password",onclick:go_}),
      $("div",{class:"authlinks"},[
        $("a",{href:"#",text:"← Back to log in",onclick:(e)=>{e.preventDefault();signIn();}}),
      ]));
    code.focus();
  }

  signIn();
}

/* ------------------------------------------------------------ chrome */
function paintChrome(){
  const c = window.SITE_CONFIG || {};
  const img = document.getElementById("brandImg");
  img.src = c.logo || "assets/logo.svg"; img.alt = c.name || "logo";
  const nav = document.getElementById("mainnav");
  // A hand-edited site.config.js is the most likely thing to be malformed, and
  // paintChrome runs before anything renders — a bad entry must not blank the
  // whole site. Skip unusable items instead of emitting "undefined" links.
  const items = Array.isArray(c.nav) ? c.nav : [];
  if (!Array.isArray(c.nav) && c.nav != null)
    console.warn("SITE_CONFIG.nav must be an array; ignoring it.");
  nav.replaceChildren(...items.reduce((out, i) => {
    if (i && typeof i.href === "string" && typeof i.label === "string" && i.label)
      out.push($("a",{href:i.href,text:i.label}));
    else console.warn("SITE_CONFIG.nav: skipping entry without {label, href}:", i);
    return out;
  }, []));
  const adminA = $("a",{href:"#/admin",text:"Admin"}); adminA.id="adminNav"; adminA.style.display="none";
  nav.append(adminA);
  document.getElementById("siteFooter").textContent = c.footer || c.name || "";
}

function paintAuthUI(){
  const btn=document.getElementById("authBtn");
  const who=document.getElementById("who");
  const prof=document.getElementById("profileBtn");
  const adminNav=document.getElementById("adminNav");
  if (adminNav) adminNav.style.display = auth.isAdmin ? "" : "none";
  if (auth.loggedIn){
    btn.textContent="Log out"; btn.onclick=()=>auth.logout();
    prof.style.display=""; prof.onclick=()=>go("/profile");
    who.textContent = auth.profile?.displayName ? `Hi, ${auth.profile.displayName}`
      + (auth.isAdmin?" (admin)":"") : "";
  } else {
    btn.textContent="Log in"; btn.onclick=()=>go("/login");
    prof.style.display="none"; who.textContent="";
  }
}

async function boot(){
  paintChrome();
  try{ await auth.handleRedirect(); }catch(_){}
  if (!auth.loggedIn && auth.refreshToken){ await auth.tryRefresh(); }
  if (auth.loggedIn){ try{ auth.profile = await api("/me",{authd:true}); }catch(_){ auth.clear(); } }
  paintAuthUI();
  window.addEventListener("hashchange", async ()=>{ await render(); paintAuthUI(); });
  if (!location.hash) location.hash="#/";
  await render(); paintAuthUI();
}
boot();
})();
