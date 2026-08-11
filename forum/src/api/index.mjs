// Serverless community forum API (single Lambda, HTTP API routes).
// Node 20, AWS SDK v3 (bundled in the Lambda runtime).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand,
  UpdateCommand, DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";

const TABLE = process.env.TABLE;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET;
const USER_POOL_ID = process.env.USER_POOL_ID;
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

// Attachments members may upload (logged-in only). Extension is derived from the
// content-type here — the client never picks the stored filename, so a ".exe"
// can't be smuggled in and the media bucket only ever holds these types.
const UPLOAD_TYPES = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "application/pdf": "pdf",
};
// DDB_ENDPOINT is unset in production (defaults to real DynamoDB); it lets the
// integration test point the same code at a local DynamoDB.
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ endpoint: process.env.DDB_ENDPOINT || undefined }),
  { marshallOptions: { removeUndefinedValues: true } },
);

// ----------------------------------------------------------------- helpers
const now = () => Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(12, "0");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Minimal, strict sanitizer: we store user text as-is but NEVER emit HTML.
// Rendering is done client-side as plain text / safe markdown, so the stored
// value is length-limited and control-char stripped here.
function cleanText(s, max) {
  if (typeof s !== "string") return "";
  // strip null + most control chars except newline/tab
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return s.slice(0, max);
}

// Identity from the Cognito JWT that API Gateway already validated.
function claims(event) {
  const c = event.requestContext?.authorizer?.jwt?.claims;
  if (!c) return null;
  const groups = (c["cognito:groups"] || "").toString();
  return {
    sub: c.sub,
    email: c.email,
    // Prefer a real name (social login) then the email local-part. NEVER fall back
    // to cognito:username — for email-alias pools that's an opaque UUID.
    name: c.name || (c.email || "").split("@")[0] || "member",
    isAdmin: groups.includes("admins"),
  };
}

async function loadProfileName(sub, fallback) {
  try {
    const r = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { PK: `USER#${sub}`, SK: "PROFILE" },
    }));
    return r.Item?.displayName || fallback;
  } catch { return fallback; }
}

// Gate for admin-only handlers. Returns a 403 response to return, or null to proceed.
function requireAdmin(user) {
  return user.isAdmin ? null : json(403, { error: "admin only" });
}

// Build a stable, human-readable album id from its name plus a short random suffix
// (so two albums can share a name without colliding).
function albumSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base}-${randomUUID().slice(0, 6)}`;
}

// ----------------------------------------------------------------- routes
async function getCategories() {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "CATLIST" },
  }));
  const cats = (r.Items || [])
    .map((i) => ({ catId: i.catId, name: i.name, desc: i.desc, order: i.order || 100 }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return json(200, { categories: cats });
}

async function getTopics(catId, qs) {
  const limit = Math.min(parseInt(qs?.limit || "30", 10) || 30, 100);
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI2",
    KeyConditionExpression: "GSI2PK = :p",
    ExpressionAttributeValues: { ":p": `CAT#${catId}` },
    ScanIndexForward: false, // newest activity first
    Limit: limit,
  }));
  const topics = (r.Items || []).map((i) => ({
    topicId: i.topicId, title: i.title, author: i.author,
    replyCount: i.replyCount || 0, lastTs: i.lastTs, archived: !!i.archived,
  }));
  return json(200, { catId, topics });
}

async function getTopic(topicId) {
  const meta = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `TOPIC#${topicId}`, SK: "META" },
  }));
  if (!meta.Item) return json(404, { error: "not found" });
  const posts = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
    ExpressionAttributeValues: { ":pk": `TOPIC#${topicId}`, ":pre": "POST#" },
    ScanIndexForward: true, // chronological
  }));
  return json(200, {
    topic: {
      topicId, title: meta.Item.title, author: meta.Item.author,
      catId: meta.Item.catId, archived: !!meta.Item.archived,
      replyCount: meta.Item.replyCount || 0,
      createdTs: meta.Item.createdTs, lastTs: meta.Item.lastTs,
    },
    posts: (posts.Items || []).map((p) => ({
      postId: p.postId, author: p.author, authorSub: p.authorSub || "",
      body: p.body, createdTs: p.createdTs, editedTs: p.editedTs || 0,
      archived: !!p.archived,
    })),
  });
}

async function getRecent(qs) {
  const limit = Math.min(parseInt(qs?.limit || "20", 10) || 20, 50);
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "FORUM" },
    ScanIndexForward: false, Limit: limit,
  }));
  return json(200, {
    topics: (r.Items || []).map((i) => ({
      topicId: i.topicId, title: i.title, catId: i.catId,
      author: i.author, lastTs: i.lastTs, replyCount: i.replyCount || 0,
      archived: !!i.archived,
    })),
  });
}

async function createCategory(event, user) {
  if (!user.isAdmin) return json(403, { error: "admin only" });
  const b = JSON.parse(event.body || "{}");
  const name = cleanText(b.name, 60).trim();
  if (!name) return json(400, { error: "name required" });
  const catId = (b.catId ? cleanText(b.catId, 40) : name)
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    || randomUUID().slice(0, 8);
  const order = Number.isFinite(b.order) ? b.order : 100;
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, Item: {
        PK: `CAT#${catId}`, SK: "META", type: "category",
        catId, name, desc: cleanText(b.desc || "", 200), order,
        GSI1PK: "CATLIST", GSI1SK: order,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException")
      return json(409, { error: "category already exists", catId });
    throw e;
  }
  return json(201, { catId, name });
}

async function createTopic(catId, event, user) {
  const b = JSON.parse(event.body || "{}");
  const title = cleanText(b.title, 200).trim();
  const body = cleanText(b.body, 20000).trim();
  if (!title || !body) return json(400, { error: "title and body required" });
  // category must exist
  const cat = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `CAT#${catId}`, SK: "META" },
  }));
  if (!cat.Item) return json(404, { error: "category not found" });

  const topicId = randomUUID();
  const ts = now();
  const author = await loadProfileName(user.sub, user.name);
  const postId = randomUUID();

  // topic meta (+ GSI1 recent feed, + GSI2 per-category listing)
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `TOPIC#${topicId}`, SK: "META", type: "topic",
      topicId, title, author, authorSub: user.sub, catId,
      archived: false, replyCount: 0, createdTs: ts, lastTs: ts,
      GSI1PK: "FORUM", GSI1SK: ts, GSI2PK: `CAT#${catId}`, GSI2SK: ts,
    },
  }));
  // first post
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `TOPIC#${topicId}`, SK: `POST#${pad(ts)}#${postId}`, type: "post",
      postId, topicId, author, authorSub: user.sub, body,
      createdTs: ts, archived: false,
    },
  }));
  return json(201, { topicId, postId });
}

async function createPost(topicId, event, user) {
  const b = JSON.parse(event.body || "{}");
  const body = cleanText(b.body, 20000).trim();
  if (!body) return json(400, { error: "body required" });
  const meta = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `TOPIC#${topicId}`, SK: "META" },
  }));
  if (!meta.Item) return json(404, { error: "topic not found" });

  const ts = now();
  const postId = randomUUID();
  const author = await loadProfileName(user.sub, user.name);
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `TOPIC#${topicId}`, SK: `POST#${pad(ts)}#${postId}`, type: "post",
      postId, topicId, author, authorSub: user.sub, body,
      createdTs: ts, archived: false,
    },
  }));
  // bump topic activity + reply count + move up both feeds
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `TOPIC#${topicId}`, SK: "META" },
    UpdateExpression:
      "SET lastTs = :ts, GSI1SK = :ts, GSI2SK = :ts ADD replyCount :one",
    ExpressionAttributeValues: { ":ts": ts, ":one": 1 },
  }));
  return json(201, { postId });
}

async function deletePost(topicId, postId, user) {
  // find the post (need its SK, which contains the timestamp)
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
    ExpressionAttributeValues: { ":pk": `TOPIC#${topicId}`, ":pre": "POST#" },
  }));
  const post = (q.Items || []).find((p) => p.postId === postId);
  if (!post) return json(404, { error: "post not found" });
  if (!user.isAdmin && post.authorSub !== user.sub)
    return json(403, { error: "not your post" });
  if (post.archived && !user.isAdmin)
    return json(403, { error: "archived post" });
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { PK: post.PK, SK: post.SK },
  }));
  return json(200, { deleted: postId });
}

async function editPost(topicId, postId, event, user) {
  const b = JSON.parse(event.body || "{}");
  const body = cleanText(b.body, 20000).trim();
  if (!body) return json(400, { error: "body required" });
  // locate the post (its SK carries the timestamp, so we scan the topic)
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
    ExpressionAttributeValues: { ":pk": `TOPIC#${topicId}`, ":pre": "POST#" },
  }));
  const post = (q.Items || []).find((p) => p.postId === postId);
  if (!post) return json(404, { error: "post not found" });
  if (!user.isAdmin && post.authorSub !== user.sub)
    return json(403, { error: "not your post" });
  if (post.archived && !user.isAdmin)
    return json(403, { error: "archived post" });
  const ts = now();
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: post.PK, SK: post.SK },
    UpdateExpression: "SET body = :b, editedTs = :t",
    ExpressionAttributeValues: { ":b": body, ":t": ts },
  }));
  return json(200, { postId, editedTs: ts });
}

// Hand a logged-in member a short-lived presigned PUT so their browser uploads
// straight to S3 (the Lambda never streams file bytes). Type is allowlisted and
// the object lands under the caller's own prefix.
async function createUpload(event, user) {
  const b = JSON.parse(event.body || "{}");
  const ct = (b.contentType || "").toLowerCase();
  const ext = UPLOAD_TYPES[ct];
  if (!ext) return json(400, { error: "unsupported content type" });
  let key;
  if (b.purpose === "gallery") {           // admin gallery photo
    if (!user.isAdmin) return json(403, { error: "admin only" });
    key = `media/gallery/${randomUUID()}.${ext}`;
  } else if (b.purpose === "avatar") {     // the member's own profile picture
    if (!ct.startsWith("image/")) return json(400, { error: "avatar must be an image" });
    key = `media/avatars/${user.sub}/${randomUUID()}.${ext}`;
  } else {                                  // member forum attachment
    key = `media/uploads/${user.sub}/${randomUUID()}.${ext}`;
  }
  const uploadUrl = await getSignedUrl(
    s3, new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, ContentType: ct }),
    { expiresIn: 300 },
  );
  return json(200, { uploadUrl, key, publicUrl: `/${key}`, contentType: ct });
}

// Turn a pasted profile/social value into a safe URL: keep full http(s) URLs,
// add https:// to a domain-looking value, and treat a bare "@handle" as a username
// on the given platform. Empty -> "".
function socialUrl(val, base) {
  val = cleanText(val, 300).trim().replace(/\s+/g, "");
  if (!val) return "";
  if (/^https?:\/\//i.test(val)) return val;
  if (/[.\/]/.test(val)) return "https://" + val.replace(/^\/+/, "");   // domain/path form
  return base + val.replace(/^@+/, "");                                  // bare @handle
}
// Avatars may only reference our own media bucket paths (never an arbitrary URL).
const isMediaUrl = (u) => typeof u === "string" && /^\/media\//.test(u);

function publicProfile(sub, i) {
  return {
    sub, displayName: i.displayName || "member",
    town: i.town || "", bio: i.bio || "", interests: i.interests || "",
    facebook: i.facebook || "", instagram: i.instagram || "", avatar: i.avatar || "",
    joinTs: i.joinTs || 0,
  };
}

async function getMe(user) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `USER#${user.sub}`, SK: "PROFILE" },
  }));
  const i = r.Item || {};
  return json(200, {
    ...publicProfile(user.sub, i),
    displayName: i.displayName || user.name,
    email: user.email, isAdmin: user.isAdmin,
  });
}

async function getUser(sub) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `USER#${sub}`, SK: "PROFILE" },
  }));
  if (!r.Item) return json(404, { error: "no profile" });
  return json(200, publicProfile(sub, r.Item));
}

async function putMe(event, user) {
  const b = JSON.parse(event.body || "{}");
  const displayName = cleanText(b.displayName, 50).trim();
  if (!displayName) return json(400, { error: "displayName required" });
  const town = cleanText(b.town, 80).trim();
  const bio = cleanText(b.bio, 200).trim();
  const interests = cleanText(b.interests, 200).trim();
  const facebook = socialUrl(b.facebook, "https://facebook.com/");
  const instagram = socialUrl(b.instagram, "https://instagram.com/");
  const avatar = isMediaUrl(b.avatar) ? b.avatar : "";
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `USER#${user.sub}`, SK: "PROFILE" },
    UpdateExpression: "SET displayName = :n, town = :tw, bio = :bio, interests = :fb, "
      + "facebook = :fbk, instagram = :ig, avatar = :av, joinTs = if_not_exists(joinTs, :t), #ty = :ty, "
      + "GSI1PK = :ml, GSI1SK = if_not_exists(joinTs, :t)",   // index into the members directory
    ExpressionAttributeNames: { "#ty": "type" },
    ExpressionAttributeValues: { ":n": displayName, ":tw": town, ":bio": bio, ":fb": interests,
      ":fbk": facebook, ":ig": instagram, ":av": avatar, ":t": now(), ":ty": "profile", ":ml": "MEMBERLIST" },
  }));
  return json(200, { displayName, town, bio, interests, facebook, instagram, avatar });
}

// Admin-only member roster with private contact info (name/email/phone), read from
// Cognito. Kept out of the public/member profile endpoints on purpose.
async function getRoster(user) {
  const d = requireAdmin(user); if (d) return d;
  const members = [];
  let token;
  do {
    const r = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken: token,
    }));
    for (const u of (r.Users || [])) {
      const a = Object.fromEntries((u.Attributes || []).map((x) => [x.Name, x.Value]));
      members.push({
        name: a.name || [a.given_name, a.family_name].filter(Boolean).join(" ")
          || (a.email || "").split("@")[0],
        email: a.email || "",
        phone: a.phone_number || "",
        status: u.UserStatus,
        joined: u.UserCreateDate ? Math.floor(new Date(u.UserCreateDate).getTime() / 1000) : 0,
      });
    }
    token = r.PaginationToken;
  } while (token);
  members.sort((x, y) => x.name.localeCompare(y.name));
  return json(200, { members });
}

async function getMembers() {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "MEMBERLIST" },
  }));
  const members = (r.Items || [])
    .map((i) => publicProfile(i.PK.slice(5), i))   // strip "USER#"
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return json(200, { members });
}

// ----------------------------------------------------------------- announcements
async function getAnnouncements(qs) {
  const limit = Math.min(parseInt(qs?.limit || "20", 10) || 20, 50);
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "ANNLIST" },
    ScanIndexForward: false, Limit: limit,
  }));
  return json(200, {
    announcements: (r.Items || []).map((i) => ({
      id: i.annId, title: i.title, body: i.body,
      author: i.author, createdTs: i.createdTs,
    })),
  });
}

async function createAnnouncement(event, user) {
  const d = requireAdmin(user); if (d) return d;
  const b = JSON.parse(event.body || "{}");
  const title = cleanText(b.title, 140).trim();
  const body = cleanText(b.body, 4000).trim();
  if (!title || !body) return json(400, { error: "title and body required" });
  const annId = randomUUID();
  const ts = now();
  const author = await loadProfileName(user.sub, user.name);
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `ANNOUNCE#${annId}`, SK: "META", type: "announcement",
      annId, title, body, author, createdTs: ts,
      GSI1PK: "ANNLIST", GSI1SK: ts,
    },
  }));
  return json(201, { id: annId });
}

async function editAnnouncement(id, event, user) {
  const d = requireAdmin(user); if (d) return d;
  const b = JSON.parse(event.body || "{}");
  const title = cleanText(b.title, 140).trim();
  const body = cleanText(b.body, 4000).trim();
  if (!title || !body) return json(400, { error: "title and body required" });
  const cur = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `ANNOUNCE#${id}`, SK: "META" },
  }));
  if (!cur.Item) return json(404, { error: "not found" });
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `ANNOUNCE#${id}`, SK: "META" },
    UpdateExpression: "SET title = :t, body = :b",
    ExpressionAttributeValues: { ":t": title, ":b": body },
  }));
  return json(200, { id });
}

async function deleteAnnouncement(id, user) {
  const d = requireAdmin(user); if (d) return d;
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { PK: `ANNOUNCE#${id}`, SK: "META" },
  }));
  return json(200, { deleted: id });
}

// ----------------------------------------------------------------- albums / gallery
async function getAlbums() {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :p",
    ExpressionAttributeValues: { ":p": "ALBUMLIST" },
    ScanIndexForward: false,
  }));
  return json(200, {
    albums: (r.Items || []).map((i) => ({
      albumId: i.albumId, name: i.name, count: i.count || 0,
      cover: i.coverThumb || i.coverFull || "",
    })),
  });
}

async function getAlbumPhotos(albumId) {
  const meta = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `ALBUM#${albumId}`, SK: "META" },
  }));
  if (!meta.Item) return json(404, { error: "not found" });
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
    ExpressionAttributeValues: { ":pk": `ALBUM#${albumId}`, ":pre": "PHOTO#" },
    ScanIndexForward: true,
  }));
  return json(200, {
    album: { albumId, name: meta.Item.name, count: meta.Item.count || 0 },
    photos: (r.Items || []).map((p) => ({
      photoId: p.photoId, t: p.thumb, f: p.full, caption: p.caption,
    })),
  });
}

async function createAlbum(event, user) {
  const d = requireAdmin(user); if (d) return d;
  const b = JSON.parse(event.body || "{}");
  const name = cleanText(b.name, 80).trim();
  if (!name) return json(400, { error: "name required" });
  const albumId = albumSlug(name);
  const ts = now();
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `ALBUM#${albumId}`, SK: "META", type: "album",
      albumId, name, count: 0, coverThumb: "", coverFull: "", createdTs: ts,
      GSI1PK: "ALBUMLIST", GSI1SK: ts,
    },
    ConditionExpression: "attribute_not_exists(PK)",
  }));
  return json(201, { albumId, name });
}

async function editAlbum(albumId, event, user) {
  const d = requireAdmin(user); if (d) return d;
  const b = JSON.parse(event.body || "{}");
  const name = cleanText(b.name, 80).trim();
  if (!name) return json(400, { error: "name required" });
  const meta = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `ALBUM#${albumId}`, SK: "META" },
  }));
  if (!meta.Item) return json(404, { error: "not found" });
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `ALBUM#${albumId}`, SK: "META" },
    UpdateExpression: "SET #n = :n",
    ExpressionAttributeNames: { "#n": "name" },
    ExpressionAttributeValues: { ":n": name },
  }));
  return json(200, { albumId, name });
}

async function deleteAlbum(albumId, user) {
  const d = requireAdmin(user); if (d) return d;
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `ALBUM#${albumId}` },
  }));
  for (const it of (q.Items || [])) {
    await ddb.send(new DeleteCommand({
      TableName: TABLE, Key: { PK: it.PK, SK: it.SK },
    }));
  }
  return json(200, { deleted: albumId });
}

async function addPhoto(albumId, event, user) {
  const d = requireAdmin(user); if (d) return d;
  const b = JSON.parse(event.body || "{}");
  const url = (b.url || "").toString();
  if (!/^\/media\/(gallery|photos|archive)\//.test(url))
    return json(400, { error: "invalid url" });
  const meta = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `ALBUM#${albumId}`, SK: "META" },
  }));
  if (!meta.Item) return json(404, { error: "not found" });
  const caption = cleanText(b.caption || "", 200);
  const order = meta.Item.count || 0;
  const photoId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `ALBUM#${albumId}`, SK: `PHOTO#${pad(order)}#${photoId}`, type: "photo",
      photoId, thumb: url, full: url, caption, order,
    },
  }));
  const upd = {
    TableName: TABLE, Key: { PK: `ALBUM#${albumId}`, SK: "META" },
    ExpressionAttributeNames: { "#c": "count" },
    ExpressionAttributeValues: { ":one": 1 },
  };
  if (order === 0) {
    upd.UpdateExpression = "ADD #c :one SET coverThumb = :u, coverFull = :u";
    upd.ExpressionAttributeValues[":u"] = url;
  } else {
    upd.UpdateExpression = "ADD #c :one";
  }
  await ddb.send(new UpdateCommand(upd));
  return json(201, { photoId, url });
}

async function deletePhoto(albumId, photoId, user) {
  const d = requireAdmin(user); if (d) return d;
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :pre)",
    ExpressionAttributeValues: { ":pk": `ALBUM#${albumId}`, ":pre": "PHOTO#" },
  }));
  const photo = (q.Items || []).find((p) => p.photoId === photoId);
  if (!photo) return json(404, { error: "not found" });
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { PK: photo.PK, SK: photo.SK },
  }));
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `ALBUM#${albumId}`, SK: "META" },
    UpdateExpression: "ADD #c :neg",
    ExpressionAttributeNames: { "#c": "count" },
    ExpressionAttributeValues: { ":neg": -1 },
  }));
  return json(200, { deleted: photoId });
}

// ---- editable pages (About, Contact, Home intro) — admins edit, anyone reads ----
const PAGE_SLUGS = new Set(["about", "contact", "home"]);
async function getPage(slug) {
  if (!PAGE_SLUGS.has(slug)) return json(404, { error: "unknown page" });
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `PAGE#${slug}`, SK: "META" },
  }));
  const i = r.Item;
  // empty title/body => the client shows its built-in default until an admin saves one
  return json(200, { slug, title: i?.title || "", body: i?.body || "", updatedTs: i?.updatedTs || 0 });
}

async function updatePage(slug, event, user) {
  const d = requireAdmin(user); if (d) return d;
  if (!PAGE_SLUGS.has(slug)) return json(404, { error: "unknown page" });
  const b = JSON.parse(event.body || "{}");
  const title = cleanText(b.title, 140).trim();
  const body = cleanText(b.body, 8000).trim();
  if (!body) return json(400, { error: "body required" });
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: `PAGE#${slug}`, SK: "META", type: "page",
      slug, title, body, updatedTs: now(),
      updatedBy: await loadProfileName(user.sub, user.name),
    },
  }));
  return json(200, { slug });
}

// ---- editable Links list (structured name/url pairs) ----
async function getLinks() {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: "CONTENT#links", SK: "META" },
  }));
  return json(200, { links: r.Item?.links || [] });
}

async function updateLinks(event, user) {
  const d = requireAdmin(user); if (d) return d;
  const b = JSON.parse(event.body || "{}");
  // keep only well-formed rows; require http(s) URLs so nothing unsafe (javascript:) is stored
  const links = (Array.isArray(b.links) ? b.links : []).slice(0, 60).map((l) => ({
    name: cleanText(l && l.name, 100).trim(),
    url: cleanText(l && l.url, 400).trim(),
  })).filter((l) => l.name && /^https?:\/\//i.test(l.url));
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: {
      PK: "CONTENT#links", SK: "META", type: "content", links, updatedTs: now(),
    },
  }));
  return json(200, { count: links.length });
}

// ----------------------------------------------------------------- router
export const handler = async (event) => {
  try {
    const rk = event.routeKey || `${event.requestContext?.http?.method} ${event.rawPath}`;
    const p = event.pathParameters || {};
    const qs = event.queryStringParameters || {};
    const method = event.requestContext?.http?.method;

    // public reads
    if (rk === "GET /api/categories") return await getCategories();
    if (rk === "GET /api/categories/{catId}/topics") return await getTopics(p.catId, qs);
    if (rk === "GET /api/topics/{topicId}") return await getTopic(p.topicId);
    if (rk === "GET /api/recent") return await getRecent(qs);
    if (rk === "GET /api/announcements") return await getAnnouncements(qs);
    if (rk === "GET /api/albums") return await getAlbums();
    if (rk === "GET /api/albums/{albumId}/photos") return await getAlbumPhotos(p.albumId);
    if (rk === "GET /api/pages/{slug}") return await getPage(p.slug);
    if (rk === "GET /api/links") return await getLinks();
    // everything below requires auth
    const user = claims(event);
    if (!user) return json(401, { error: "login required" });

    // member profiles + directory are visible to logged-in members only
    if (rk === "GET /api/users/{sub}") return await getUser(p.sub);
    if (rk === "GET /api/members") return await getMembers();
    if (rk === "GET /api/roster") return await getRoster(user);   // admin-only, incl. contact info

    if (rk === "POST /api/categories") return await createCategory(event, user);
    if (rk === "POST /api/categories/{catId}/topics") return await createTopic(p.catId, event, user);
    if (rk === "POST /api/topics/{topicId}/posts") return await createPost(p.topicId, event, user);
    if (rk === "PUT /api/topics/{topicId}/posts/{postId}") return await editPost(p.topicId, p.postId, event, user);
    if (rk === "DELETE /api/topics/{topicId}/posts/{postId}") return await deletePost(p.topicId, p.postId, user);
    if (rk === "POST /api/uploads") return await createUpload(event, user);
    if (rk === "GET /api/me") return await getMe(user);
    if (rk === "PUT /api/me") return await putMe(event, user);

    // admin content management: announcements + gallery albums/photos
    if (rk === "POST /api/announcements") return await createAnnouncement(event, user);
    if (rk === "PUT /api/announcements/{id}") return await editAnnouncement(p.id, event, user);
    if (rk === "DELETE /api/announcements/{id}") return await deleteAnnouncement(p.id, user);
    if (rk === "POST /api/albums") return await createAlbum(event, user);
    if (rk === "PUT /api/albums/{albumId}") return await editAlbum(p.albumId, event, user);
    if (rk === "DELETE /api/albums/{albumId}") return await deleteAlbum(p.albumId, user);
    if (rk === "POST /api/albums/{albumId}/photos") return await addPhoto(p.albumId, event, user);
    if (rk === "DELETE /api/albums/{albumId}/photos/{photoId}") return await deletePhoto(p.albumId, p.photoId, user);
    if (rk === "PUT /api/pages/{slug}") return await updatePage(p.slug, event, user);
    if (rk === "PUT /api/links") return await updateLinks(event, user);

    return json(404, { error: `no route for ${rk || method}` });
  } catch (err) {
    console.error("ERR", err);
    return json(500, { error: "server error" });
  }
};
