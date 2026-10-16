import {readFile,lstat,mkdir,open} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const source=resolve(root,'../faceit-telegram-bot/.secrets');
async function protectedRead(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw new Error();return readFile(path,'utf8');}
try{
 process.umask(0o077);
 const key=process.argv[2];if(!['BOT_TOKEN','FACEIT_API_KEY','TS_ENCRYPTION_KEY','WEBHOOK_SECRET'].includes(key))throw new Error();
 let value;
 if(key==='BOT_TOKEN')value=(await protectedRead(`${source}/telegram-bot.token`)).trim();
 else if(key==='FACEIT_API_KEY')value=(await protectedRead(`${source}/faceit.key`)).trim();
 else{
  const directory=resolve(root,'.secrets');await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(info.isSymbolicLink()||(info.mode&0o077))throw new Error();
  const path=resolve(directory,'cloud-generated.json');let generated;
  try{generated=JSON.parse(await protectedRead(path));}catch(error){if(error.code!=='ENOENT')throw error;generated={TS_ENCRYPTION_KEY:randomBytes(32).toString('hex'),WEBHOOK_SECRET:randomBytes(32).toString('hex')};const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(generated)+'\n');}finally{await file.close();}}
  value=generated[key];
 }
 if(!value)throw new Error();execFileSync('/usr/bin/pbcopy',{input:value});console.log(`${key} copied to clipboard. Paste only into the matching secret field in Sites. Value not printed.`);
}catch{console.error('Secret copy failed safely. Check key name and protected files. No values printed.');process.exitCode=1;}
