import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

let cargo=process.env.RECALLPAY_CARGO || 'cargo';
if (cargo==='cargo') {
  const candidate=join(homedir(),'.cargo','bin',process.platform==='win32'?'cargo.exe':'cargo');
  try { await access(candidate); cargo=candidate; } catch {}
}
execFileSync(cargo,['build','--manifest-path','contract/Cargo.toml','--locked','--target','wasm32-unknown-unknown','--release'],{stdio:'inherit'});
await mkdir('artifacts',{recursive:true});
// Normalize encodings and lower sign extension for the pinned sandbox's parser.
// This is the standard WASM optimization stage, not a runtime modification.
execFileSync(process.execPath,['node_modules/binaryen/bin/wasm-opt',
  'contract/target/wasm32-unknown-unknown/release/recallpay.wasm',
  '-Oz','--mvp-features','--signext-lowering','-o','artifacts/recallpay.wasm'],{stdio:'inherit'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=['contract/src/lib.rs','contract/Cargo.toml','contract/Cargo.lock','rust-toolchain.toml','.cargo/config.toml','scripts/build.mjs','package-lock.json'];
const sourceSha256={};
for (const path of paths) sourceSha256[path]=hash(await readFile(path));
const manifest={ compiler:execFileSync(cargo,['--version'],{encoding:'utf8'}).trim(),rust:'1.86.0',nearSdk:'5.24.1',
  nearSys:'0.2.7',binaryen:'123.0.0',target:'wasm32-unknown-unknown',wasmSha256:hash(await readFile('artifacts/recallpay.wasm')),sourceSha256 };
await writeFile('artifacts/build.json',JSON.stringify(manifest,null,2)+'\n');
console.log(`Built artifacts/recallpay.wasm — SHA-256 ${manifest.wasmSha256}`);
