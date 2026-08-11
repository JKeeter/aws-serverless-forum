#!/usr/bin/env bash
# One-command deploy for the serverless forum.
# Runs on YOUR machine with YOUR AWS credentials (aws sts get-caller-identity
# should already work). Prereqs: awscli v2, aws-sam-cli, python3+boto3, node.
set -euo pipefail

STACK="${STACK:-serverless-forum}"
REGION="${REGION:-us-east-1}"          # us-east-1 required (CloudFront ACM certs live there)
IMPORT_FILE="${IMPORT_FILE:-}"          # optional: topics.json export of your old forum (see IMPORT.md)
DOMAIN="${DOMAIN:-}"                    # optional custom domain, e.g. forum.example.com
ACM_ARN="${ACM_ARN:-}"                 # ACM cert ARN in us-east-1 (needed only with DOMAIN)
# Cognito's hosted-login domain prefix must stay STABLE across redeploys (changing
# it forces a domain rename that Cognito rejects mid-update). Reuse the existing
# stack's prefix if the stack is already deployed; only randomize on first create.
COGNITO_PREFIX="${COGNITO_PREFIX:-}"
if [ -z "$COGNITO_PREFIX" ]; then
  _EXIST=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CognitoDomain'].OutputValue" --output text 2>/dev/null || true)
  if [ -n "$_EXIST" ] && [ "$_EXIST" != "None" ]; then
    COGNITO_PREFIX="${_EXIST%%.*}"        # strip .auth.<region>.amazoncognito.com
  else
    COGNITO_PREFIX="$STACK-$RANDOM"
  fi
fi
# Optional social login. Fill these in (export before running) once you've
# registered the Google Cloud OAuth client / Meta app; leave empty to run on
# email+password only. No code changes needed either way.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
FACEBOOK_APP_ID="${FACEBOOK_APP_ID:-}"
FACEBOOK_APP_SECRET="${FACEBOOK_APP_SECRET:-}"

here="$(cd "$(dirname "$0")/.." && pwd)"; cd "$here"
echo "==> Account: $(aws sts get-caller-identity --query Account --output text) region=$REGION"

# 1) Build + deploy the stack
echo "==> sam build"
sam build
echo "==> sam deploy"
PARAMS="CognitoDomainPrefix=$COGNITO_PREFIX"
[ -n "$DOMAIN" ]  && PARAMS="$PARAMS DomainName=$DOMAIN"
[ -n "$ACM_ARN" ] && PARAMS="$PARAMS AcmCertificateArn=$ACM_ARN"
[ -n "$GOOGLE_CLIENT_ID" ]     && PARAMS="$PARAMS GoogleClientId=$GOOGLE_CLIENT_ID GoogleClientSecret=$GOOGLE_CLIENT_SECRET"
[ -n "$FACEBOOK_APP_ID" ]      && PARAMS="$PARAMS FacebookClientId=$FACEBOOK_APP_ID FacebookClientSecret=$FACEBOOK_APP_SECRET"
sam deploy --stack-name "$STACK" --region "$REGION" \
  --capabilities CAPABILITY_IAM --resolve-s3 \
  --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides $PARAMS

# 2) Read stack outputs
out(){ aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
WEB=$(out WebBucketName); MEDIA=$(out MediaBucketName); TABLE=$(out TableName)
DIST=$(out DistributionId); SITE=$(out SiteURL); CFDOMAIN=$(out CloudFrontDomain)
COG_DOMAIN=$(out CognitoDomain); CLIENT=$(out UserPoolClientId); POOL=$(out UserPoolId)
echo "==> web=$WEB media=$MEDIA table=$TABLE dist=$DIST"

# 2b) Register the CloudFront (+ custom-domain) URL as a valid Cognito callback.
#     The template can't do this without a circular dependency; this preserves all
#     other client settings.
CB_URLS="https://$CFDOMAIN/"
[ -n "$DOMAIN" ] && CB_URLS="$CB_URLS https://$DOMAIN/"
echo "==> Registering login callback URLs: $CB_URLS"
python3 scripts/register_callback.py --pool "$POOL" --client "$CLIENT" \
  --region "$REGION" --urls $CB_URLS

# 3) Write the front-end runtime config with real IDs (+ only the social
#    providers actually configured). Branding lives in site.config.js and is
#    never touched by deploys.
SOCIAL="[]"
[ -n "$GOOGLE_CLIENT_ID" ] && SOCIAL='["Google"]'
[ -n "$FACEBOOK_APP_ID" ]  && SOCIAL='["Facebook"]'
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$FACEBOOK_APP_ID" ] && SOCIAL='["Google","Facebook"]'
cat > web/config.js <<EOF
window.FORUM_CONFIG = {
  apiBase: "/api",
  cognitoDomain: "$COG_DOMAIN",
  clientId: "$CLIENT",
  redirectUri: window.location.origin + "/",
  socialProviders: $SOCIAL,
};
EOF

# 4) Upload the front end
echo "==> Uploading web app"
aws s3 sync web "s3://$WEB" --delete \
  --cache-control "no-cache" --exclude "*.png" --exclude "*.jpg"
# Image assets are excluded above, so push them explicitly with a longer cache.
# --delete on the sync above skips excludes, so nothing here gets wiped.
aws s3 sync web/assets "s3://$WEB/assets" --cache-control "public,max-age=86400"

# 5) Optional: import a legacy forum export (see IMPORT.md)
if [ -n "$IMPORT_FILE" ]; then
  echo "==> Building seed from $IMPORT_FILE"
  python3 scripts/build_seed.py --file "$IMPORT_FILE" --out ./build
  echo "==> Loading forum seed into DynamoDB"
  python3 scripts/load_seed.py --table "$TABLE" --file build/seed.ndjson --region "$REGION"
fi

# 5b) Optional: seed the photo gallery (albums + photos) from a manifest
if [ -f web/photos.json ]; then
  echo "==> Loading photo gallery into DynamoDB"
  python3 scripts/load_gallery.py --table "$TABLE" --file web/photos.json --region "$REGION"
fi

# 6) Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null || true

echo ""
echo "======================================================================"
echo " Deployed.  Your forum: $SITE"
echo " Cognito login domain:  https://$COG_DOMAIN"
echo ""
echo " Next:"
echo "  • Register yourself, then make your account an admin:"
echo "      aws cognito-idp admin-add-user-to-group --user-pool-id $POOL \\"
echo "        --username <your-email> --group-name admins --region $REGION"
echo "  • As admin, create categories in the UI and edit the About/Contact pages."
echo "  • Custom domain: point your DNS at the CloudFront domain once ACM is"
echo "    validated (see DEPLOY.md)."
echo "======================================================================"
