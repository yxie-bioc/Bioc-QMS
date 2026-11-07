import { pathToFileURL } from 'node:url';
let stopping=false;
const stop=()=>{ if(stopping)return; stopping=true; process.emit('SIGTERM'); };
process.on('message',m=>{if(m==='stop')stop();});
process.on('disconnect',stop);
await import(pathToFileURL(process.env.BBC_SERVER_ENTRY).href);
