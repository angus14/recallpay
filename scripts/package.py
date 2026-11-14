#!/usr/bin/env python3
"""Produce a self-extracting source+WASM runner, excluding keys and dependencies."""
import base64
import gzip
import hashlib
import io
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parent.parent
allowed_files = ['README.md','LICENSE','package.json','package-lock.json','rust-toolchain.toml','.gitignore','.cargo/config.toml','contract/Cargo.toml','contract/Cargo.lock','contract/src/lib.rs']
allowed_dirs = ['sdk','scripts','tests','fixtures','docs','artifacts','results']
paths = [root / p for p in allowed_files]
for directory in allowed_dirs:
    paths.extend(p for p in (root / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
paths = sorted(set(paths))
stream = io.BytesIO()
with tarfile.open(fileobj=stream,mode='w') as tar:
    for path in paths:
        relative = path.relative_to(root).as_posix()
        data = path.read_bytes()
        info = tarfile.TarInfo(f'recallpay/{relative}')
        info.size = len(data); info.mode = 0o644; info.mtime = 0
        tar.addfile(info,io.BytesIO(data))
payload = gzip.compress(stream.getvalue(),mtime=0)
checksum = hashlib.sha256(payload).hexdigest()
header = r'''#!/usr/bin/env bash
# RecallPay: source, checksum-verified WASM, tests, demo and evidence.
# Creates a fresh directory; never modifies an existing project.
set -euo pipefail
mode="${1:-run}"
if [[ "$mode" != "run" && "$mode" != "--extract-only" ]]; then
  echo 'Usage: bash RecallPay_run.sh [--extract-only]' >&2
  exit 2
fi
for command_name in base64 tar mktemp awk; do
  command -v "$command_name" >/dev/null || { echo "Missing command: $command_name" >&2; exit 1; }
done
if [[ "$mode" == "run" ]]; then
  command -v node >/dev/null || { echo 'Install Node.js 20+ first (or use Codespaces).' >&2; exit 1; }
  command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
  node -e 'if(Number(process.versions.node.split(".")[0])<20){console.error("Node.js 20+ required");process.exit(1)}'
fi
workdir="$(mktemp -d "$PWD/recallpay.XXXXXX")"
archive="$workdir/payload.tar.gz"
if [[ "$(uname -s)" == "Darwin" ]]; then
  awk 'found {print} /^__RECALLPAY_PAYLOAD__$/ {found=1}' "$0" | base64 -D > "$archive"
else
  awk 'found {print} /^__RECALLPAY_PAYLOAD__$/ {found=1}' "$0" | base64 --decode > "$archive"
fi
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null; then
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  echo 'sha256sum or shasum is required.' >&2; exit 1
fi
if [[ "$actual" != "__PAYLOAD_SHA256__" ]]; then echo 'Package checksum mismatch.' >&2; exit 1; fi
tar -xzf "$archive" -C "$workdir"
rm "$archive"
cd "$workdir/recallpay"
echo "Project extracted: $PWD"
if [[ "$mode" == "--extract-only" ]]; then exit 0; fi
echo '[1/3] Installing locked Node dependencies and local NEAR Sandbox...'
npm ci --no-audit --no-fund > results/install-run.log 2>&1 || { cat results/install-run.log; exit 1; }
echo '[2/3] Running 19 integration checks on local NEAR (usually 2 minutes)...'
npm test 2>&1 | tee results/test-run.log | awk '/^[[:space:]]*(ok|not ok) [0-9]|^# (tests|pass|fail|duration_ms)/ {print; fflush()}'
echo '[3/3] Running the two-agent recall and native refund demonstration...'
npm run demo > results/demo-run.log 2>&1 || { cat results/demo-run.log; exit 1; }
tail -n 3 results/demo-run.log
echo "Open report: $PWD/results/demo.html"
echo "All source and results: $PWD"
exit 0
__RECALLPAY_PAYLOAD__
'''
header = header.replace('__PAYLOAD_SHA256__',checksum)
encoded = base64.b64encode(payload).decode('ascii')
output = root.parent / 'RecallPay_run.sh'
output.write_text(header + '\n'.join(encoded[i:i+76] for i in range(0,len(encoded),76))+'\n')
output.chmod(0o755)
print({'runner':str(output),'files':len(paths),'bytes':output.stat().st_size,'payload_sha256':checksum})
