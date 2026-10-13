import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const runtimeFiles=['manifest.json','background.js','page-api.js','generated-resource.js','snapshot.js','incremental.js','task-context.js','download.js','async.js','files.js','task-store.js','sidepanel.html','sidepanel.css','sidepanel.js'];
export function auditRelease(root) {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  const issues=[];
  for(const file of runtimeFiles) {
    const content=fs.readFileSync(path.join(root,file),'utf8');
    if(/(?:[A-Z]:[\\/](?:Users|AI-Projects)[\\/]|https:\/\/jimeng\.jianying\.com\/ai-tool\/canvas\/\d+|https:\/\/[^\s'"<>]+[?&]x-(?:signature|expires)=|officialReferences|PRIVATE_SIGNATURE|NOT_IN_REPORT|RESOURCE_NODE_INDEX)/i.test(content))issues.push(file+': personal/test data');
    if(/['"](?:Cookie|Authorization)['"]\s*:/i.test(content))issues.push(file+': credential header');
    if(file.endsWith('.js'))for(const m of content.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]));
      if(!runtimeFiles.includes(dependency))issues.push(file+': missing runtime dependency '+dependency);
    }
  }
  for(const permission of manifest.permissions)if(!['storage','scripting','sidePanel','downloads'].includes(permission))issues.push('unexpected permission '+permission);
  if(manifest.content_scripts||manifest.externally_connectable)issues.push('unexpected legacy/external entry');
  if(!manifest.host_permissions.every(host=>['https://jimeng.jianying.com/*','https://*.byteimg.com/*'].includes(host)))issues.push('unexpected host permission');
  for(const file of [manifest.background.service_worker,manifest.side_panel.default_path])if(!runtimeFiles.includes(file))issues.push('missing manifest entry '+file);
  if(issues.length)throw new Error(issues.join('\n'));
  return{version:manifest.version,runtimeFiles:runtimeFiles.length,privacy:'passed',dependencies:'passed',permissions:manifest.permissions};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(auditRelease(path.resolve(process.argv[2]||'.')),null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
