# Serverless Forum — Architecture

**Goal:** a real, member-facing forum (logins, categories, topics/replies,
profiles, uploads, photo albums) for a small community, on AWS, with **no
server to patch** and cost that sits in/near the free tier.

## Why serverless

A traditional forum is a long-running server plus a database engine plus forum
software — three things that need patching forever, and the reason so many
small-community forums end up defaced or malware-ridden. This design has **no
long-running server and no self-managed database engine**: everything is
static files or managed AWS services, plus one small sandboxed Lambda.

## The picture

```
                          your-domain.com
                                 │
                         ┌───────▼────────┐
                         │   CloudFront    │  (TLS via ACM, caching, WAF optional)
                         └───┬────────┬────┘
              default /*     │        │   /api/*
        ┌──────────────────┐ │        │ ┌───────────────────────────┐
        │  S3: web bucket   │◄┘        └►│  API Gateway (HTTP API)   │
        │  static SPA       │           │   JWT authorizer (Cognito) │
        └──────────────────┘           └───────────┬───────────────┘
                                                    │  Lambda (Node.js 20)
             /media/*  ┌───────────────┐  ┌──────────┴───────────┐
        ────────────►  │ S3: media     │  │ the whole API        │
                       │ (attachments) │  │ (read public,        │
                       └───────────────┘  │  write = logged in)  │
                                          └──────────┬───────────┘
                                              ┌──────▼───────┐
                                              │  DynamoDB     │  single table
                                              │  (on-demand)  │
                                              └──────────────┘
        Auth: Amazon Cognito User Pool (email+password, email verification, JWTs)
```

**Request flow:** visitors hit your domain → CloudFront serves the static app
from S3. The app calls `/api/*` (same domain, no CORS) → API Gateway → Lambda
→ DynamoDB. Reading is public; writing requires a Cognito login (JWT checked
at the gateway). Uploads go straight to a separate media bucket via presigned
URLs and are served through CloudFront at `/media/*`.

## Components

| Layer | Service | Role |
|---|---|---|
| CDN/TLS | **CloudFront + ACM** | One distribution, HTTPS, routes `/api/*` and `/media/*` |
| Front end | **S3 (web bucket)** | No-build static SPA (HTML/CSS/vanilla JS) |
| API | **API Gateway HTTP API** | Cheap routing to Lambda; Cognito JWT authorizer on write routes |
| Compute | **AWS Lambda (Node.js 20)** | One small handler; scales to zero when idle |
| Data | **DynamoDB (single table, on-demand)** | Categories, topics, posts, users, albums, pages |
| Auth | **Amazon Cognito User Pool** | Registration, email verification, login, JWTs |
| Media | **S3 (media bucket)** | Attachments via presigned upload |
| Infra | **AWS SAM (CloudFormation)** | One template provisions all of the above |

## DynamoDB single-table design

One table, on-demand billing. Key shapes:

| Entity | PK | SK | Notes / GSI |
|---|---|---|---|
| Category | `CAT#<catId>` | `META` | GSI1PK=`CATLIST` → category list |
| Topic metadata | `TOPIC#<topicId>` | `META` | GSI1 (`FORUM`/lastTs → recent feed) AND GSI2 (`CAT#<cat>`/lastTs → topics in category) |
| Post | `TOPIC#<topicId>` | `POST#<epoch>#<postId>` | chronological within topic |
| User profile | `USER#<sub>` | `PROFILE` | displayName, bio, socials |
| Announcement | `ANNOUNCE#<id>` | `META` | GSI1PK=`ANNLIST` |
| Album | `ALBUM#<id>` | `META` | GSI1PK=`ALBUMLIST` |
| Photo | `ALBUM#<id>` | `PHOTO#<order>#<photoId>` | ordered within album |
| Editable page | `PAGE#<slug>` | `META` | about/contact/home/links content |

Notes:
- **Legacy import** writes topics/posts with `archived=true` and `author` as
  the original display-name string (no account link — old password hashes
  can't and shouldn't be migrated into Cognito). Archived threads render
  inline, read-only, badged "Archived."
- **New posts** carry `authorSub` (the Cognito user id) so people can
  edit/delete their own.

## Auth model

Cognito User Pool with email + password and email verification.
Login/registration/password-reset run **in-page** against the Cognito API
(`InitiateAuth` with `USER_PASSWORD_AUTH`, `SignUp`/`ConfirmSignUp`, the
forgot-password flow) — no redirect for the common case. The Cognito **Hosted
UI** is used only for optional social sign-in (Google/Facebook), enabled
purely by supplying OAuth credentials at deploy time.

The SPA sends the **ID token** as `Authorization: Bearer <token>`; the HTTP
API's JWT authorizer verifies it (audience = the app client id). An `admins`
Cognito group unlocks moderation and site-content editing; admin-only routes
re-check group membership server-side.

**Callback registration:** the app client's CallbackURLs can't reference the
CloudFront domain inside CloudFormation — that would create a circular
dependency (Client → Distribution → HttpApi → Client, since the API's JWT
authorizer audience IS the client). `deploy.sh` registers the real URLs
post-deploy via `scripts/register_callback.py`, which merges URLs without
clobbering other client settings.

## Security posture

- **No server, no DB engine to patch.**
- **Stored-XSS defense (load-bearing):** user text is stored as plain text and
  rendered with `textContent`/DOM nodes — never `innerHTML`. This kills the
  class of bug that defaces forums. Do not add raw-HTML rendering of user
  content.
- **Least-privilege IAM:** the Lambda gets only the DynamoDB/S3 actions it
  needs.
- **Uploads:** presigned, type-allowlisted (jpg/png/gif/webp/pdf), size-capped,
  into a bucket only served via CloudFront; media renders only from same-origin
  `/media/` paths.
- **Optional AWS WAF** on CloudFront (rate limiting, managed rules) if you
  ever want it; unnecessary at small scale.
- **Backups:** DynamoDB point-in-time recovery is on.

## Cost estimate (25–100 members, light traffic)

| Service | Typical monthly |
|---|---|
| S3 (web + media, a few GB) | < $0.25 |
| CloudFront (first 1 TB egress free) | ~$0 |
| API Gateway HTTP API ($1/million req) | < $0.50 |
| Lambda (1M req + 400k GB-s free) | ~$0 |
| DynamoDB on-demand + PITR | < $0.50 |
| Cognito (free tier covers thousands of MAUs) | ~$0 |
| **Total** | **~$0–2/month** (plus your domain) |

A t3.nano/Lightsail alternative would be ~$5–8/month **and** a server you must
keep patched — more money and more risk.
