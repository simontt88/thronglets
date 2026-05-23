#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
DASHBOARD="$ROOT/packages/dashboard"
SLUG="thronglets-dashboard"
TITLE="Thronglets Fleet Dashboard"
BASE_URL="https://vibespace-five.vercel.app"

# Get API key
VS_KEY=$(python3 -c "import json; print(json.load(open('$HOME/.vibesync/config.json'))['apiKey'])" 2>/dev/null)
if [ -z "$VS_KEY" ]; then
  echo "❌ No Vibespace API key found in ~/.vibesync/config.json"
  exit 1
fi

echo "📦 Building dashboard (single-file)..."
cd "$DASHBOARD"
npx vite build --mode singlefile

HTML_FILE="$DASHBOARD/dist-single/index.html"
if [ ! -f "$HTML_FILE" ]; then
  echo "❌ Build output not found: $HTML_FILE"
  exit 1
fi

SIZE=$(wc -c < "$HTML_FILE")
echo "✅ Built: $(( SIZE / 1024 ))KB single-file bundle"

echo "🚀 Publishing to Vibespace..."
# Build JSON payload to a temp file (HTML too large for argv)
PAYLOAD_FILE=$(mktemp)
python3 -c "
import json
with open('$HTML_FILE') as f:
    html = f.read()
payload = {
    'slug': '$SLUG',
    'kind': 'app',
    'title': '$TITLE',
    'html': html,
    'tags': ['dashboard', 'thronglets'],
    'overwrite': True,
}
with open('$PAYLOAD_FILE', 'w') as out:
    json.dump(payload, out)
"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/artifacts" \
  -H "Authorization: Bearer $VS_KEY" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE")
rm -f "$PAYLOAD_FILE"

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  VERSION=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('current_version', d.get('version', '?')))" 2>/dev/null || echo "?")
  echo "✅ Published! v$VERSION"
  echo "   View: $BASE_URL/a/$SLUG"
else
  echo "❌ Publish failed (HTTP $HTTP_CODE)"
  echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
  exit 1
fi
