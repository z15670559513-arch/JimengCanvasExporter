// Audit only the explicit public snapshot. Runtime checks remain stricter than synthetic tests.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeFiles,auditRelease} from './release-audit.mjs';
export const developmentFiles=['package.json','README.md','CHANGELOG.md','PRIVACY.md','DEVELOPMENT.md','RELEASE_NOTES.md','RELEASE_TEST_REPORT.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore','scripts/package.ps1','scripts/release-audit.mjs','scripts/public-audit.mjs','scripts/test.mjs','scripts/fixtures.mjs','scripts/test-snapshot.mjs','scripts/test-incremental.mjs','scripts/test-generated-validation.mjs','scripts/test-context.mjs','scripts/test-files.mjs','scripts/test-download.mjs','scripts/browser-smoke.mjs'];
export const publicFiles=[...runtimeFiles,...developmentFiles];
export function auditPublic(root) {
  const issues=[];auditRelease(root);
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='.git'&&dir===root)continue;
    const full=path.join(dir,entry.name),relative=path.relative(root,full).split(path.sep).join('/');
    if(entry.isSymbolicLink())issues.push(relative+': symlink');
    else if(entry.isDirectory())walk(full);
    else if(!publicFiles.includes(relative))issues.push(relative+': outside public whitelist');
  }}walk(root);
  for(const file of publicFiles){
    const full=path.join(root,file);if(!fs.existsSync(full)){issues.push(file+': missing');continue;}
    const content=fs.readFileSync(full,'utf8');
    const synthetic=file.startsWith('scripts/test-')||file==='scripts/fixtures.mjs'||file==='scripts/browser-smoke.mjs';
    if(/(?:[A-Z]:[\\/](?:Users|AI-Projects)[\\/]|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i.test(content))issues.push(file+': credential or personal path');
    if(!synthetic&&/https:\/\/[^\s'"<>]+[?&](?:x-signature|signature|token)=/i.test(content))issues.push(file+': signed URL');
    if(synthetic)for(const match of content.matchAll(/[?&]x-signature=([^&\s'"<>]+)/g))
      if(!['PRIVATE_SIGNATURE','NOT_IN_REPORT','DO_NOT_LOG'].includes(match[1]))issues.push(file+': unrecognized signature fixture');
    if(/\uFFFD/.test(content))issues.push(file+': invalid UTF-8 text');
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.version!==manifest.version_name||/rc|beta|alpha/i.test(manifest.version_name))issues.push('non-final manifest version');
  if(issues.length)throw new Error(issues.join('\n'));
  return{files:publicFiles.length,version:manifest.version,privacy:'passed',syntheticTests:'explicit placeholders only',license:'all rights reserved'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(auditPublic(path.resolve(process.argv[2]||'.')),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
