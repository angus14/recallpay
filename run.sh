#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo 'Node.js 20+ is required.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Node.js 20+ is required."); process.exit(1); }'
if [[ -n "${NEAR_SANDBOX_BIN_PATH:-}" ]]; then
  printf '%s  %s\n' 'e4a88ee5c6f6a65ac3e786b68da2fbd6044b7b77f750d91a67c89b28b005d225' "$NEAR_SANDBOX_BIN_PATH" | sha256sum -c -
  npm ci --ignore-scripts --no-audit --no-fund
  install -m 755 "$NEAR_SANDBOX_BIN_PATH" node_modules/near-sandbox/bin/near-sandbox
else
  npm ci --no-audit --no-fund
fi
npm test 2>&1 | tee results/test-run.log
npm run demo
echo 'Open results/demo.html to inspect the transaction evidence.'
