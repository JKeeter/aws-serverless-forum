// Local dev/QA server: serves the real SPA against the REAL Lambda handler on a
// local DynamoDB (dynalite), seeded with sample categories and topics.
// Auth is faked for local use only — a "dev token" carries the Cognito claims
// the API Gateway authorizer would normally supply, so new-topic / reply / edit
// all run for real. (Real Cognito + real S3 uploads only exist once deployed.)
//
//   node test/devserver.mjs        # then open http://localhost:8100
//
import dynalite from "dynalite";
import { DynamoDBClient, CreateTableCommand, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, "..", "web");
const DDB_PORT = 4600, HTTP_PORT = 8100, TABLE = "forum-dev";

// ---- local DynamoDB ----
const ddbServer = dynalite({ createTableMs: 0 });
await new Promise((r) => ddbServer.listen(DDB_PORT, r));
process.env.DDB_ENDPOINT = `http://localhost:${DDB_PORT}`;
process.env.TABLE = TABLE;
process.env.MEDIA_BUCKET = "forum-media-dev";
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "dev";
process.env.AWS_SECRET_ACCESS_KEY = "dev";

const raw = new DynamoDBClient({ endpoint: process.env.DDB_ENDPOINT, region: "us-east-1",
  credentials: { accessKeyId: "dev", secretAccessKey: "dev" } });
const doc = DynamoDBDocumentClient.from(raw);
await raw.send(new CreateTableCommand({
  TableName: TABLE, BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" },
    { AttributeName: "GSI1PK", AttributeType: "S" }, { AttributeName: "GSI1SK", AttributeType: "N" },
    { AttributeName: "GSI2PK", AttributeType: "S" }, { AttributeName: "GSI2SK", AttributeType: "N" }],
  KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
  GlobalSecondaryIndexes: [
    { IndexName: "GSI1", KeySchema: [{ AttributeName: "GSI1PK", KeyType: "HASH" }, { AttributeName: "GSI1SK", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } },
    { IndexName: "GSI2", KeySchema: [{ AttributeName: "GSI2PK", KeyType: "HASH" }, { AttributeName: "GSI2SK", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }],
}));
await waitUntilTableExists({ client: raw, maxWaitTime: 60 }, { TableName: TABLE });

// ---- seed: sample forum structure + a little sample content ----
const CATS = [
  ["general", "General Discussion", "News and general chatter"],
  ["introductions", "Introductions", "Say hello and meet other members"],
  ["events", "Events / Gatherings", "Meetups, outings, festivals"],
  ["meetings", "Monthly Meetings", "Agendas and minutes"],
  ["photos", "Photos", "Pictures from events"],
  ["offtopic", "Off-Topic", "Anything else"],
  ["howto", "Help & How-To", "Questions and guides"],
  ["newsletters", "Newsletters", "Group newsletters"],
  ["showandtell", "Show and Tell", "Share what you made"],
  ["forsale", "For Sale", "Gear for sale or trade"],
];
const items = [];
CATS.forEach(([id, name, desc], i) => items.push({
  PK: `CAT#${id}`, SK: "META", type: "category", catId: id, name, desc, order: (i + 1) * 10,
  GSI1PK: "CATLIST", GSI1SK: (i + 1) * 10 }));
function topic(id, cat, title, author, posts, archived, baseTs) {
  const epochs = posts.map((_, k) => baseTs + k * 60);
  const last = epochs[epochs.length - 1];
  items.push({ PK: `TOPIC#${id}`, SK: "META", type: "topic", topicId: id, title,
    author: posts[0].a, authorSub: posts[0].s || "", catId: cat, archived,
    replyCount: posts.length - 1, createdTs: baseTs, lastTs: last,
    GSI1PK: "FORUM", GSI1SK: last, GSI2PK: `CAT#${cat}`, GSI2SK: last });
  posts.forEach((p, k) => items.push({
    PK: `TOPIC#${id}`, SK: `POST#${String(epochs[k]).padStart(12, "0")}#${id}-${k + 1}`,
    type: "post", postId: `${id}-${k + 1}`, topicId: id, author: p.a, authorSub: p.s || "",
    body: p.b, createdTs: epochs[k], archived }));
}
topic("t-welcome", "general", "Welcome to the forum", "Admin",
  [{ a: "Admin", b: "Introduce yourself and have a look around." },
   { a: "Pat", b: "Glad to be here!" }], true, 1500000000);
topic("t-picnic", "events", "Summer picnic planning", "Deb",
  [{ a: "Deb", b: "Who's bringing the grill this year? Post ideas here." }], false, 1700000000);
topic("t-project", "showandtell", "My weekend project", "Sam",
  [{ a: "Sam", b: "Finished it last night — photos below." }], false, 1700100000);

// If a generated import seed exists, load THAT instead of the demo data above —
// lets you preview an imported legacy forum locally.
const SEED = path.resolve(__dirname, "..", "build", "seed.ndjson");
let seedItems = items;
if (fs.existsSync(SEED)) {
  seedItems = fs.readFileSync(SEED, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`Loaded import seed: ${seedItems.length} items from build/seed.ndjson`);
}
for (let i = 0; i < seedItems.length; i += 25)
  await doc.send(new BatchWriteCommand({ RequestItems: { [TABLE]: seedItems.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }));

// ---- import the real handler ----
const { handler } = await import("../src/api/index.mjs");

// Fake the API Gateway JWT authorizer: a dev bearer token of the form
// "dev.<base64url(JSON claims)>.x" is decoded into the same claims shape Cognito
// would provide. Never use this server on a public network.
function claimsFromAuth(h) {
  if (!h) return undefined;
  const m = /^Bearer\s+dev\.([^.]+)\./.exec(h);
  if (!m) return undefined;
  try { return JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { return undefined; }
}

function readBody(req) {
  return new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); });
}

// Route templates (the {param} shapes API Gateway uses). First match wins.
const ROUTE_TEMPLATES = [
  "/api/categories", "/api/categories/{catId}/topics", "/api/topics/{topicId}",
  "/api/topics/{topicId}/posts", "/api/topics/{topicId}/posts/{postId}",
  "/api/recent", "/api/uploads", "/api/me",
  "/api/announcements", "/api/announcements/{id}",
  "/api/albums", "/api/albums/{albumId}", "/api/albums/{albumId}/photos",
  "/api/albums/{albumId}/photos/{photoId}",
  "/api/pages/{slug}", "/api/links", "/api/members", "/api/roster", "/api/users/{sub}",
];
function matchRoute(method, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  for (const tmpl of ROUTE_TEMPLATES) {
    const tp = tmpl.split("/").filter(Boolean);
    if (tp.length !== parts.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < tp.length; i++) {
      if (tp[i].startsWith("{")) params[tp[i].slice(1, -1)] = decodeURIComponent(parts[i]);
      else if (tp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: `${method} ${tmpl}`, params };
  }
  return { route: `${method} ${pathname}`, params: {} };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");   // always serve fresh files in dev
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const body = await readBody(req);
    const claims = claimsFromAuth(req.headers.authorization);
    // Match the path against the route templates (mirrors API Gateway) so
    // parameterized routes like /api/users/{sub} resolve to the right routeKey.
    const { route, params } = matchRoute(req.method, url.pathname);
    const event = { routeKey: route, rawPath: url.pathname, pathParameters: params,
      queryStringParameters: Object.fromEntries(url.searchParams),
      requestContext: { http: { method: req.method }, authorizer: claims ? { jwt: { claims } } : undefined },
      body: body || undefined };
    const out = await handler(event);
    res.writeHead(out.statusCode, out.headers); return res.end(out.body);
  }
  const MIME = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css",
    ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf" };
  const serve = (fp) => {
    res.setHeader("content-type", MIME[path.extname(fp).toLowerCase()] || "application/octet-stream");
    res.end(fs.readFileSync(fp));
  };

  // static app files
  let p = decodeURIComponent(url.pathname); if (p === "/") p = "/index.html";
  const fp = path.join(WEB, p);
  if (!fp.startsWith(WEB) || !fs.existsSync(fp)) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("content-type", MIME[path.extname(fp).toLowerCase()] || "text/html");
  res.end(fs.readFileSync(fp));
});
server.listen(HTTP_PORT, () => {
  console.log(`\nDev forum:  http://localhost:${HTTP_PORT}`);
  console.log(`Seeded ${CATS.length} categories + sample topics.`);
  console.log(`Dev login (paste in console, then reload):`);
  console.log(`  sessionStorage.id_token='dev.'+btoa(JSON.stringify({sub:'dev-admin',email:'you@example.com',name:'You',"cognito:groups":"admins"}))+'.x'; sessionStorage.exp=String(Date.now()+36e5)\n`);
});
