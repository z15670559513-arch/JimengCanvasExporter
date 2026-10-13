import {spawnSync} from 'node:child_process';
const files=['snapshot','incremental','generated-validation','context','files','download'].map(name=>'scripts/test-'+name+'.mjs');
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
process.exitCode=result.status??1;
