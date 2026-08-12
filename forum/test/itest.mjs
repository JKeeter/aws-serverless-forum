// Integration test: runs the ACTUAL Lambda handler against a local DynamoDB
// (dynalite) with the real table schema + GSIs. No AWS account needed.
import dynalite from "dynalite";
import {
  DynamoDBClient, CreateTableCommand, waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import fs from "fs";
import assert from "assert";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 4599;
const ENDPOINT = `http://localhost:${PORT}`;
const TABLE = "forum-itest";

// 1) start local DynamoDB
const server = dynalite({ createTableMs: 0 });
await new Promise((res) => server.listen(PORT, res));
process.env.DDB_ENDPOINT = ENDPOINT;
process.env.TABLE = TABLE;
process.env.MEDIA_BUCKET = "forum-media-test";
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "x";
process.env.AWS_SECRET_ACCESS_KEY = "x";

const raw = new DynamoDBClient({ endpoint: ENDPOINT, region: "us-east-1",
  credentials: { accessKeyId: "x", secretAccessKey: "x" } });
const doc = DynamoDBDocumentClient.from(raw);

// 2) create the table exactly like template.yaml
await raw.send(new CreateTableCommand({
  TableName: TABLE,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" },
    { AttributeName: "SK", AttributeType: "S" },
    { AttributeName: "GSI1PK", AttributeType: "S" },
    { AttributeName: "GSI1SK", AttributeType: "N" },
    { AttributeName: "GSI2PK", AttributeType: "S" },
    { AttributeName: "GSI2SK", AttributeType: "N" },
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" },
    { AttributeName: "SK", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    { IndexName: "GSI1", KeySchema: [
        { AttributeName: "GSI1PK", KeyType: "HASH" },
        { AttributeName: "GSI1SK", KeyType: "RANGE" }],
      Projection: { ProjectionType: "ALL" } },
    { IndexName: "GSI2", KeySchema: [
        { AttributeName: "GSI2PK", KeyType: "HASH" },
        { AttributeName: "GSI2SK", KeyType: "RANGE" }],
      Projection: { ProjectionType: "ALL" } },
  ],
}));
await waitUntilTableExists({ client: raw, maxWaitTime: 60 }, { TableName: TABLE });

// 3) seed with a committed fixture (self-contained; no archive/build needed)
const seed = fs.readFileSync(path.join(__dirname, "seed.fixture.ndjson"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l));
for (let i = 0; i < seed.length; i += 25) {
  await doc.send(new BatchWriteCommand({
    RequestItems: { [TABLE]: seed.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) },
  }));
}

// 4) import the real handler (after env is set)
const { handler } = await import("../src/api/index.mjs");

// helpers to fake API Gateway HTTP API events
function ev(method, path, { route, params, body, user, qs } = {}) {
  return {
    routeKey: route, rawPath: path,
    requestContext: { http: { method },
      authorizer: user ? { jwt: { claims: user } } : undefined },
    pathParameters: params || {}, queryStringParameters: qs || null,
    body: body ? JSON.stringify(body) : undefined,
  };
}
const call = async (...a) => { const r = await handler(ev(...a)); return { s: r.statusCode, d: JSON.parse(r.body) }; };
const member = { sub: "user-1", email: "pat@example.com", "cognito:username": "pat", name: "Pat" };
const admin = { sub: "admin-1", email: "boss@example.com", "cognito:groups": "admins", name: "Boss" };

let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };

// ---- public reads on seeded archive ----
let r = await call("GET", "/api/categories", { route: "GET /api/categories" });
ok(r.s === 200 && r.d.categories.length === 1, "categories lists the archive");
ok(r.d.categories[0].catId === "archive", "archive category present");

r = await call("GET", "/api/categories/archive/topics",
  { route: "GET /api/categories/{catId}/topics", params: { catId: "archive" } });
ok(r.s === 200 && r.d.topics.length === 2, "archive has 2 topics");
ok(r.d.topics[0].lastTs >= r.d.topics[1].lastTs, "topics sorted newest-first");

r = await call("GET", "/api/topics/42", { route: "GET /api/topics/{topicId}", params: { topicId: "42" } });
ok(r.s === 200 && r.d.posts.length === 2, "topic 42 has 2 posts");
ok(r.d.posts[0].author === "JimB" && r.d.posts[1].author === "MikeT", "posts chronological");
ok(r.d.topic.archived === true, "seeded topic flagged archived");

r = await call("GET", "/api/recent", { route: "GET /api/recent" });
ok(r.s === 200 && r.d.topics.length === 2, "recent feed works via GSI1");

// ---- auth required ----
r = await call("POST", "/api/categories/archive/topics",
  { route: "POST /api/categories/{catId}/topics", params: { catId: "archive" }, body: { title: "x", body: "y" } });
ok(r.s === 401, "posting without login is rejected");

// ---- admin creates a new (writable) category ----
r = await call("POST", "/api/categories", { route: "POST /api/categories",
  body: { name: "General Discussion" }, user: admin });
ok(r.s === 201 && r.d.catId === "general-discussion", "admin created category with slug id");

r = await call("POST", "/api/categories", { route: "POST /api/categories",
  body: { name: "General Discussion" }, user: member });
ok(r.s === 403, "non-admin cannot create category");

// ---- member creates a topic + reply ----
r = await call("POST", "/api/categories/general-discussion/topics",
  { route: "POST /api/categories/{catId}/topics", params: { catId: "general-discussion" },
    body: { title: "First post of spring", body: "Hello from the integration test." }, user: member });
ok(r.s === 201 && r.d.topicId, "member created a topic");
const newTopic = r.d.topicId;

r = await call("POST", `/api/topics/${newTopic}/posts`,
  { route: "POST /api/topics/{topicId}/posts", params: { topicId: newTopic },
    body: { body: "Sounds great, save me a bottle!" }, user: admin });
ok(r.s === 201 && r.d.postId, "second member replied");
const replyId = r.d.postId;

r = await call("GET", `/api/topics/${newTopic}`,
  { route: "GET /api/topics/{topicId}", params: { topicId: newTopic } });
ok(r.d.posts.length === 2, "new topic now has 2 posts");
ok(r.d.topic.replyCount === 1, "replyCount incremented to 1");

// listing the new category shows the new topic
r = await call("GET", "/api/categories/general-discussion/topics",
  { route: "GET /api/categories/{catId}/topics", params: { catId: "general-discussion" } });
ok(r.s === 200 && r.d.topics.length === 1 && r.d.topics[0].topicId === newTopic,
  "new topic appears in its category via GSI2");

// ---- ownership rules on delete ----
r = await call("DELETE", `/api/topics/${newTopic}/posts/${replyId}`,
  { route: "DELETE /api/topics/{topicId}/posts/{postId}",
    params: { topicId: newTopic, postId: replyId }, user: member });
ok(r.s === 403, "member cannot delete another user's post");

r = await call("DELETE", `/api/topics/${newTopic}/posts/${replyId}`,
  { route: "DELETE /api/topics/{topicId}/posts/{postId}",
    params: { topicId: newTopic, postId: replyId }, user: admin });
ok(r.s === 200, "admin can delete any post");

// archived posts protected from non-admins
r = await call("DELETE", "/api/topics/42/posts/101",
  { route: "DELETE /api/topics/{topicId}/posts/{postId}",
    params: { topicId: "42", postId: "101" }, user: member });
ok(r.s === 403, "archived post cannot be deleted by a member");

// ---- profile display-name drives future attribution ----
r = await call("PUT", "/api/me", { route: "PUT /api/me", body: { displayName: "PatTheTester" }, user: member });
ok(r.s === 200 && r.d.displayName === "PatTheTester", "profile displayName set");
r = await call("GET", "/api/me", { route: "GET /api/me", user: member });
ok(r.d.displayName === "PatTheTester", "GET /me returns saved name");
r = await call("POST", "/api/categories/general-discussion/topics",
  { route: "POST /api/categories/{catId}/topics", params: { catId: "general-discussion" },
    body: { title: "Naming test", body: "hi" }, user: member });
r = await call("GET", `/api/topics/${r.d.topicId}`,
  { route: "GET /api/topics/{topicId}", params: { topicId: r.d.topicId } });
ok(r.d.posts[0].author === "PatTheTester", "new posts attributed to profile display name");

// ---- extended profile fields + public profile + avatar ----
r = await call("PUT", "/api/me", { route: "PUT /api/me", user: member, body: {
  displayName: "PatTheTester", town: "Springfield", bio: "Test bio",
  interests: "Hiking, photography", facebook: "@pat-test", instagram: "https://instagram.com/pat",
  avatar: "/media/avatars/user-1/x.jpg" } });
ok(r.s === 200 && r.d.facebook === "https://facebook.com/pat-test", "bare @handle expands to a facebook URL");
ok(r.d.instagram === "https://instagram.com/pat", "full social URL kept as-is");
r = await call("GET", "/api/me", { route: "GET /api/me", user: member });
ok(r.d.town === "Springfield" && r.d.bio === "Test bio" && r.d.interests === "Hiking, photography", "profile fields saved + returned");
ok(r.d.avatar === "/media/avatars/user-1/x.jpg", "avatar (a /media path) stored");
// member profiles are visible to logged-in members only
r = await call("GET", "/api/users/user-1", { route: "GET /api/users/{sub}", params: { sub: "user-1" } });
ok(r.s === 401, "profiles are NOT public (401 without login)");
r = await call("GET", "/api/users/user-1", { route: "GET /api/users/{sub}", params: { sub: "user-1" }, user: member });
ok(r.s === 200 && r.d.displayName === "PatTheTester" && r.d.town === "Springfield" && r.d.email === undefined,
  "logged-in member sees a profile's fields, not email");
r = await call("GET", "/api/users/nobody", { route: "GET /api/users/{sub}", params: { sub: "nobody" }, user: member });
ok(r.s === 404, "unknown member profile 404s");
// a non-media avatar URL is rejected (note: a save writes ALL fields, so send them)
r = await call("PUT", "/api/me", { route: "PUT /api/me", user: member,
  body: { displayName: "PatTheTester", avatar: "https://evil.example/x.jpg" } });
ok(r.d.avatar === "", "avatar outside our media bucket is dropped");
// a domain-form social value (no scheme) gets https:// — not double-prefixed onto the base
r = await call("PUT", "/api/me", { route: "PUT /api/me", user: member,
  body: { displayName: "PatTheTester", instagram: "instagram.com/pat" } });
ok(r.d.instagram === "https://instagram.com/pat", "domain-form social value gets https:// cleanly");
// members directory lists everyone who's saved a profile (members only)
await call("PUT", "/api/me", { route: "PUT /api/me", user: admin, body: { displayName: "Boss" } });
r = await call("GET", "/api/members", { route: "GET /api/members" });
ok(r.s === 401, "members directory is NOT public (401 without login)");
r = await call("GET", "/api/members", { route: "GET /api/members", user: member });
ok(r.s === 200 && Array.isArray(r.d.members), "logged-in member sees the directory list");
ok(r.d.members.some((m) => m.sub === "user-1") && r.d.members.some((m) => m.sub === "admin-1"),
  "members with saved profiles appear in the directory");
ok(r.d.members.every((m, k, a) => k === 0 || a[k - 1].displayName.localeCompare(m.displayName) <= 0),
  "members sorted by display name");
// admin roster (contact info) — auth-gated + admin-only (200 path hits Cognito; tested live)
r = await call("GET", "/api/roster", { route: "GET /api/roster" });
ok(r.s === 401, "roster requires login");
r = await call("GET", "/api/roster", { route: "GET /api/roster", user: member });
ok(r.s === 403, "roster is admin-only (member forbidden)");
// avatar upload presign (image), and a non-image rejected
r = await call("POST", "/api/uploads", { route: "POST /api/uploads", user: member,
  body: { contentType: "image/png", filename: "me.png", purpose: "avatar", size: 2048 } });
ok(r.s === 200 && r.d.publicUrl.startsWith("/media/avatars/user-1/"), "avatar presign lands under the user's avatar prefix");
r = await call("POST", "/api/uploads", { route: "POST /api/uploads", user: member,
  body: { contentType: "application/pdf", filename: "me.pdf", purpose: "avatar", size: 2048 } });
ok(r.s === 400, "a non-image avatar upload is rejected");

// ---- validation ----
r = await call("POST", "/api/categories/general-discussion/topics",
  { route: "POST /api/categories/{catId}/topics", params: { catId: "general-discussion" },
    body: { title: "", body: "" }, user: member });
ok(r.s === 400, "empty topic rejected");

// ---- edit post (PUT) ownership + rules ----
const member2 = { sub: "user-2", email: "sam@example.com", "cognito:username": "sam", name: "Sam" };
// member creates a fresh topic to own its first post
r = await call("POST", "/api/categories/general-discussion/topics",
  { route: "POST /api/categories/{catId}/topics", params: { catId: "general-discussion" },
    body: { title: "Edit me", body: "original body" }, user: member });
const editTopic = r.d.topicId, editPost = r.d.postId;

r = await call("PUT", `/api/topics/${editTopic}/posts/${editPost}`,
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: editTopic, postId: editPost }, body: { body: "edited body" }, user: member });
ok(r.s === 200, "author can edit own post");
r = await call("GET", `/api/topics/${editTopic}`,
  { route: "GET /api/topics/{topicId}", params: { topicId: editTopic } });
ok(r.d.posts[0].body === "edited body", "edited body persisted");
ok(r.d.posts[0].editedTs > 0, "edit stamps editedTs");

r = await call("PUT", `/api/topics/${editTopic}/posts/${editPost}`,
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: editTopic, postId: editPost }, body: { body: "hijacked" }, user: member2 });
ok(r.s === 403, "non-owner member cannot edit another's post");

r = await call("PUT", `/api/topics/${editTopic}/posts/${editPost}`,
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: editTopic, postId: editPost }, body: { body: "moderated" }, user: admin });
ok(r.s === 200, "admin can edit any post");

r = await call("PUT", `/api/topics/${editTopic}/posts/${editPost}`,
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: editTopic, postId: editPost }, body: { body: "" }, user: member });
ok(r.s === 400, "empty edit rejected");

r = await call("PUT", `/api/topics/${editTopic}/posts/nope`,
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: editTopic, postId: "nope" }, body: { body: "x" }, user: member });
ok(r.s === 404, "editing missing post 404s");

// archived posts: member blocked, admin allowed
r = await call("PUT", "/api/topics/42/posts/101",
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: "42", postId: "101" }, body: { body: "x" }, user: member });
ok(r.s === 403, "member cannot edit an archived post");
r = await call("PUT", "/api/topics/42/posts/101",
  { route: "PUT /api/topics/{topicId}/posts/{postId}",
    params: { topicId: "42", postId: "101" }, body: { body: "corrected by mod" }, user: admin });
ok(r.s === 200, "admin can edit an archived post");

// ---- uploads (presigned S3 PUT) ----
r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { contentType: "image/jpeg", filename: "pic.jpg", size: 2048 } });
ok(r.s === 401, "anonymous cannot request an upload URL");

r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { contentType: "image/jpeg", filename: "pic.jpg", size: 2048 }, user: member });
ok(r.s === 200 && typeof r.d.uploadUrl === "string" && r.d.uploadUrl.startsWith("https://"),
  "logged-in member gets a presigned upload URL");
ok(r.d.publicUrl && r.d.publicUrl.startsWith("/media/uploads/user-1/"),
  "publicUrl namespaced under the user and served via /media");
ok(r.d.key && r.d.key.endsWith(".jpg"), "key keeps a safe extension from content-type");

r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { contentType: "application/x-msdownload", filename: "evil.exe", size: 2048 }, user: member });
ok(r.s === 400, "disallowed content-type rejected");

r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { filename: "nope" }, user: member });
ok(r.s === 400, "missing content-type rejected");

// size must be declared so it can be signed into the URL (S3 then enforces it)
r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { contentType: "image/jpeg", filename: "p.jpg" }, user: member });
ok(r.s === 400, "upload without a declared size is rejected");

r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { contentType: "image/jpeg", filename: "p.jpg", size: -1 }, user: member });
ok(r.s === 400, "negative size rejected");

r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads",
    body: { contentType: "image/jpeg", filename: "huge.jpg", size: 500 * 1024 * 1024 }, user: member });
ok(r.s === 413, "oversized upload rejected before a URL is issued");

r = await call("POST", "/api/uploads",
  { route: "POST /api/uploads", body: { contentType: "image/jpeg", filename: "p.jpg", size: 1024 }, user: member });
ok(r.s === 200 && r.d.maxBytes > 0, "presign response advertises the size cap");

// ---- admin announcements ----
r = await call("POST", "/api/announcements",
  { route: "POST /api/announcements", body: { title: "Meeting Tuesday", body: "7pm at the pub" }, user: member });
ok(r.s === 403, "member cannot create an announcement");

r = await call("POST", "/api/announcements",
  { route: "POST /api/announcements", body: { title: "Meeting Tuesday", body: "7pm at the pub" }, user: admin });
ok(r.s === 201 && r.d.id, "admin created an announcement");
const annId = r.d.id;

r = await call("POST", "/api/announcements",
  { route: "POST /api/announcements", body: { title: "", body: "" }, user: admin });
ok(r.s === 400, "empty announcement rejected");

r = await call("GET", "/api/announcements", { route: "GET /api/announcements" });
ok(r.s === 200 && r.d.announcements.some((a) => a.id === annId && a.title === "Meeting Tuesday"),
  "GET announcements lists the new one");

r = await call("PUT", `/api/announcements/${annId}`,
  { route: "PUT /api/announcements/{id}", params: { id: annId },
    body: { title: "Meeting Wednesday", body: "8pm at the pub" }, user: admin });
ok(r.s === 200 && r.d.id === annId, "admin edited the announcement");

r = await call("PUT", `/api/announcements/${annId}`,
  { route: "PUT /api/announcements/{id}", params: { id: annId },
    body: { title: "x", body: "y" }, user: member });
ok(r.s === 403, "member cannot edit an announcement");

r = await call("PUT", "/api/announcements/nope",
  { route: "PUT /api/announcements/{id}", params: { id: "nope" },
    body: { title: "x", body: "y" }, user: admin });
ok(r.s === 404, "editing a missing announcement 404s");

r = await call("GET", "/api/announcements", { route: "GET /api/announcements" });
ok(r.d.announcements.find((a) => a.id === annId).title === "Meeting Wednesday",
  "announcement edit persisted");

r = await call("DELETE", `/api/announcements/${annId}`,
  { route: "DELETE /api/announcements/{id}", params: { id: annId }, user: member });
ok(r.s === 403, "member cannot delete an announcement");

r = await call("DELETE", `/api/announcements/${annId}`,
  { route: "DELETE /api/announcements/{id}", params: { id: annId }, user: admin });
ok(r.s === 200 && r.d.deleted === annId, "admin deleted the announcement");

r = await call("GET", "/api/announcements", { route: "GET /api/announcements" });
ok(!r.d.announcements.some((a) => a.id === annId), "deleted announcement gone from list");

// ---- admin gallery albums + photos ----
r = await call("POST", "/api/albums",
  { route: "POST /api/albums", body: { name: "Summer Fest" }, user: member });
ok(r.s === 403, "member cannot create an album");

r = await call("POST", "/api/albums",
  { route: "POST /api/albums", body: { name: "Summer Fest" }, user: admin });
ok(r.s === 201 && r.d.albumId && r.d.name === "Summer Fest", "admin created an album");
const albumId = r.d.albumId;

r = await call("GET", "/api/albums", { route: "GET /api/albums" });
ok(r.s === 200 && r.d.albums.some((a) => a.albumId === albumId && a.count === 0),
  "GET albums lists the new album with count 0");

r = await call("POST", `/api/albums/${albumId}/photos`,
  { route: "POST /api/albums/{albumId}/photos", params: { albumId },
    body: { url: "/media/gallery/x.jpg", caption: "the keg" }, user: member });
ok(r.s === 403, "member cannot add a photo");

r = await call("POST", `/api/albums/${albumId}/photos`,
  { route: "POST /api/albums/{albumId}/photos", params: { albumId },
    body: { url: "http://evil.example/x.jpg" }, user: admin });
ok(r.s === 400, "photo url outside /media rejected");

r = await call("POST", `/api/albums/${albumId}/photos`,
  { route: "POST /api/albums/{albumId}/photos", params: { albumId },
    body: { url: "/media/gallery/x.jpg", caption: "the keg" }, user: admin });
ok(r.s === 201 && r.d.photoId, "admin added a photo");
const photoId = r.d.photoId;

r = await call("GET", `/api/albums/${albumId}/photos`,
  { route: "GET /api/albums/{albumId}/photos", params: { albumId } });
ok(r.s === 200 && r.d.album.count === 1 && r.d.photos.length === 1, "album now has 1 photo");
ok(r.d.photos[0].t === "/media/gallery/x.jpg" && r.d.photos[0].f === "/media/gallery/x.jpg",
  "photo returns thumb (t) and full (f)");

r = await call("GET", "/api/albums", { route: "GET /api/albums" });
ok(r.d.albums.find((a) => a.albumId === albumId).cover === "/media/gallery/x.jpg",
  "first photo set the album cover");

r = await call("GET", "/api/albums/missing/photos",
  { route: "GET /api/albums/{albumId}/photos", params: { albumId: "missing" } });
ok(r.s === 404, "photos of a missing album 404");

r = await call("DELETE", `/api/albums/${albumId}/photos/${photoId}`,
  { route: "DELETE /api/albums/{albumId}/photos/{photoId}", params: { albumId, photoId }, user: admin });
ok(r.s === 200 && r.d.deleted === photoId, "admin deleted the photo");

r = await call("GET", `/api/albums/${albumId}/photos`,
  { route: "GET /api/albums/{albumId}/photos", params: { albumId } });
ok(r.d.album.count === 0 && r.d.photos.length === 0, "photo delete decremented count");

r = await call("DELETE", `/api/albums/${albumId}`,
  { route: "DELETE /api/albums/{albumId}", params: { albumId }, user: admin });
ok(r.s === 200 && r.d.deleted === albumId, "admin deleted the album");

r = await call("GET", "/api/albums", { route: "GET /api/albums" });
ok(!r.d.albums.some((a) => a.albumId === albumId), "deleted album gone from list");

// ---- editable pages (About / Contact) ----
r = await call("GET", "/api/pages/about", { route: "GET /api/pages/{slug}", params: { slug: "about" } });
ok(r.s === 200 && r.d.body === "", "unset page returns empty (client shows default)");
r = await call("GET", "/api/pages/nope", { route: "GET /api/pages/{slug}", params: { slug: "nope" } });
ok(r.s === 404, "unknown page slug rejected");
r = await call("PUT", "/api/pages/about",
  { route: "PUT /api/pages/{slug}", params: { slug: "about" }, body: { title: "About the club", body: "We meet monthly." } });
ok(r.s === 401, "editing a page without login is rejected");
r = await call("PUT", "/api/pages/about",
  { route: "PUT /api/pages/{slug}", params: { slug: "about" }, body: { title: "About", body: "text" }, user: member });
ok(r.s === 403, "non-admin cannot edit a page");
r = await call("PUT", "/api/pages/about",
  { route: "PUT /api/pages/{slug}", params: { slug: "about" },
    body: { title: "About our group", body: "We are a community group. https://example.com" }, user: admin });
ok(r.s === 200, "admin saved the About page");
r = await call("PUT", "/api/pages/contact",
  { route: "PUT /api/pages/{slug}", params: { slug: "contact" }, body: { title: "", body: "" }, user: admin });
ok(r.s === 400, "empty page body rejected");
r = await call("GET", "/api/pages/about", { route: "GET /api/pages/{slug}", params: { slug: "about" } });
ok(r.d.title === "About our group" && r.d.body.includes("community group"), "saved About page reads back");

// home intro is a page too
r = await call("PUT", "/api/pages/home",
  { route: "PUT /api/pages/{slug}", params: { slug: "home" }, body: { title: "", body: "Welcome to the club." }, user: admin });
ok(r.s === 200, "admin can edit the homepage intro (home page)");

// ---- editable Links list ----
r = await call("GET", "/api/links", { route: "GET /api/links" });
ok(r.s === 200 && Array.isArray(r.d.links) && r.d.links.length === 0, "links empty until set");
r = await call("PUT", "/api/links",
  { route: "PUT /api/links", body: { links: [{ name: "Example", url: "https://example.com" }] } });
ok(r.s === 401, "editing links without login rejected");
r = await call("PUT", "/api/links",
  { route: "PUT /api/links", body: { links: [] }, user: member });
ok(r.s === 403, "non-admin cannot edit links");
r = await call("PUT", "/api/links",
  { route: "PUT /api/links", user: admin, body: { links: [
    { name: "Example", url: "https://example.com" },
    { name: "bad", url: "javascript:alert(1)" },   // dropped: not http(s)
    { name: "", url: "https://x.com" },             // dropped: no name
    { name: "Docs", url: "https://docs.example.com" },
  ] } });
ok(r.s === 200 && r.d.count === 2, "admin saved links; unsafe/blank rows dropped");
r = await call("GET", "/api/links", { route: "GET /api/links" });
ok(r.d.links.length === 2 && r.d.links.every((l) => /^https:\/\//.test(l.url)),
  "links read back, only safe http(s) URLs stored");

console.log(`\n✅ ALL ${pass} INTEGRATION CHECKS PASSED`);
server.close();
process.exit(0);
