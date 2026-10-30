import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,copyFileSync,statSync,rmSync } from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'t3-vacuum-bench-'));
const samples={onePage:[],batch32:[]};
let seed;
try{
 const source=join(dir,'seed.sqlite');seed=new DatabaseSync(source);
 seed.exec("PRAGMA auto_vacuum=INCREMENTAL; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep'); CREATE TABLE discarded(value BLOB); BEGIN;");
 const insert=seed.prepare('INSERT INTO discarded VALUES(zeroblob(4096))');for(let i=0;i<2048;i++)insert.run();
 seed.exec('COMMIT; DROP TABLE discarded;');seed.close();seed=undefined;
 for(let sample=0;sample<7;sample++)for(const mode of sample%2===0?['onePage','batch32']:['batch32','onePage']){
  const file=join(dir,mode+'-'+sample+'.sqlite');copyFileSync(source,file);const db=new DatabaseSync(file);
  try{
   db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;');
   const free=db.prepare('PRAGMA freelist_count'),step=db.prepare('PRAGMA incremental_vacuum(1)');
   const before=free.get().freelist_count;const start=performance.now();let commits=0,maxTransactionMs=0;
   for(let page=0;page<1024;){
    const txStart=performance.now();if(mode==='batch32')db.exec('BEGIN');
    const end=Math.min(1024,page+(mode==='batch32'?32:1));
    for(;page<end;page++){if(free.get().freelist_count===0)break;step.run();}
    if(mode==='batch32')db.exec('COMMIT');commits++;maxTransactionMs=Math.max(maxTransactionMs,performance.now()-txStart);
    if(free.get().freelist_count===0)break;
   }
   const ms=performance.now()-start;const after=free.get().freelist_count;
   assert.equal(before-after,1024);assert.equal(db.prepare('SELECT value FROM retained').get().value,'keep');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
   if(sample>0)samples[mode].push({ms,commits,maxTransactionMs,freedPages:before-after,walBytes:statSync(file+'-wal').size});
  }finally{db.close();}
 }
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixture:'8MiB disposable BLOB table deleted, 1024 free pages reclaimed, WAL NORMAL, 1 warmup and 6 alternating samples; direct SQLite prototype excludes Effect scheduling and concurrent writers',samples},null,2));
}finally{seed?.close();rmSync(dir,{recursive:true,force:true});}
