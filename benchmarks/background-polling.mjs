import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const root = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 't3-background-polling-bench-'));
const scale = Number(process.env.T3_BENCH_SCALE ?? 1);
const iterations = Number(process.env.T3_BENCH_ITERATIONS ?? 25);
const schema = JSON.parse(readFileSync(join(root, 'upstream-schema.json'), 'utf8'));
const indexes = readFileSync(join(root, '..', 'polling-indexes.sql'), 'utf8');
const counts = { threads: Math.round(4000 * scale), items: Math.round(120000 * scale), runs: Math.round(60000 * scale), hotRuns: Math.round(20000 * scale) };
const sql = {
  recoveryPrefilter: `SELECT failure.thread_id FROM orchestration_v2_projection_turn_items failure
    WHERE failure.type = 'error' AND failure.status = 'failed'
    AND json_extract(failure.payload_json, '$.failure.class') = 'usage_limit'`,
  pullRequestPolling: `SELECT payload_json FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.archivedAt') IS NULL
    AND json_array_length(payload_json, '$.pullRequests') > 0 ORDER BY updated_at ASC, thread_id ASC`,
  latestExecutedRun: `SELECT latest.run_id FROM orchestration_v2_projection_runs latest
    WHERE latest.thread_id = 'hot-thread' AND latest.status <> 'queued'
    AND NOT (latest.status = 'cancelled' AND json_extract(latest.payload_json, '$.startedAt') IS NULL)
    ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC, latest.ordinal DESC, latest.run_id DESC LIMIT 1`,
};
const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.min(values.length - 1, Math.floor(values.length * p))];
function measure(statement) { const start = performance.now(); const rows = statement.all(); return { ms: performance.now()-start, rows }; }
function warm(statement) { for(let i=0;i<5;i++) statement.all(); }
let baseline, improved;
try {
  const baselinePath = join(directory,'baseline.sqlite');
  baseline = new DatabaseSync(baselinePath);
  baseline.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-32768;');
  for (const row of schema) if(row.type === 'table') baseline.exec(row.sql);
  for (const row of schema) if(row.type === 'index') baseline.exec(row.sql);
  const thread = baseline.prepare(`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (?, 'project', 'Synthetic', 'codex', 'full-access', 'default', ?, ?, ?)`);
  const run = baseline.prepare(`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (?, ?, ?, 'codex', ?, ?, ?, ?)`);
  const item = baseline.prepare(`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const at = ordinal => new Date(Date.UTC(2026,0,1) + ordinal*1000).toISOString();
  const filler = 'representative synthetic payload '.repeat(32);
  const seedStart = performance.now();
  baseline.exec('BEGIN');
  for(let i=0;i<counts.threads;i++) thread.run(`thread-${i}`,at(0),at(i),JSON.stringify({archivedAt:i%20===0?at(i):null,pullRequests:i%40===1?[{number:i}]:[],notes:filler}));
  for(let i=0;i<counts.runs;i++) {
    const hot = i<counts.hotRuns;
    const status = i%50===0?'queued':i%31===0?'cancelled':i%17===0?'failed':'completed';
    run.run(`run-${i}`,hot?'hot-thread':`thread-${i%counts.threads}`,i,status,at(i),status==='queued'?null:at(i+1),JSON.stringify({startedAt:status==='cancelled'?null:at(i),rootNodeId:`node-${i}`,notes:filler}));
  }
  for(let i=0;i<counts.items;i++) {
    const error = i%3===0;
    item.run(`item-${i}`,`thread-${i%counts.threads}`,`run-${i%counts.runs}`,i,error?'error':'command_execution',error?'failed':'completed',at(i),JSON.stringify({failure:error?{class:i%300===0?'usage_limit':'provider',resetAt:at(i+1)}:undefined,output:filler}));
  }
  baseline.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  const seedMs = performance.now()-seedStart;
  const baselineBytes = statSync(baselinePath).size;
  const improvedPath = join(directory,'improved.sqlite');
  copyFileSync(baselinePath,improvedPath);
  improved = new DatabaseSync(improvedPath);
  improved.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-32768;');
  const indexStart = performance.now();
  improved.exec(indexes);
  const indexBuildMs = performance.now()-indexStart;
  improved.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const addedIndexBytes = statSync(improvedPath).size-baselineBytes;
  const result={environment:{node:process.version,sqlite:baseline.prepare('SELECT sqlite_version() AS v').get().v,platform:process.platform,arch:process.arch,cpu:cpus()[0].model,memoryBytes:totalmem(),schemaSource:'upstream 78f1ba8285898d50af82a49c98364197d330db6a migrations 001-075; three projection tables/indexes; synthetic data only',fixture:counts,iterations,warmup:5,cacheKiB:32768,cacheState:'SQLite and OS caches warmed; neither cold disk nor full-service end-to-end latency'},fixtureSetup:{seedMs,baselineBytes,indexBuildMs,addedIndexBytes},queries:{}};
  for(const [name,query] of Object.entries(sql)) {
    const before = baseline.prepare(query), after=improved.prepare(query);
    const beforeRows=before.all(),afterRows=after.all();
    if(name==='recoveryPrefilter') { beforeRows.sort((a,b)=>a.thread_id.localeCompare(b.thread_id)); afterRows.sort((a,b)=>a.thread_id.localeCompare(b.thread_id)); }
    assert.deepEqual(afterRows,beforeRows);
    warm(before);warm(after);
    const beforeTimes=[],afterTimes=[];
    for(let i=0;i<iterations;i++) {
      if(i%2===0) { beforeTimes.push(measure(before).ms);afterTimes.push(measure(after).ms); }
      else { afterTimes.push(measure(after).ms);beforeTimes.push(measure(before).ms); }
    }
    const beforeMedianMs=percentile(beforeTimes,.5),afterMedianMs=percentile(afterTimes,.5);
    result.queries[name]={sql:query,resultCount:beforeRows.length,beforeMedianMs,afterMedianMs,speedup:beforeMedianMs/afterMedianMs,beforeP95Ms:percentile(beforeTimes,.95),afterP95Ms:percentile(afterTimes,.95),beforePlan:baseline.prepare('EXPLAIN QUERY PLAN '+query).all(),afterPlan:improved.prepare('EXPLAIN QUERY PLAN '+query).all(),beforeSamplesMs:beforeTimes,afterSamplesMs:afterTimes};
  }
  result.writeOverhead={};
  for(const [name,query,parameter] of [
    ['nonErrorItemUpdates',`UPDATE orchestration_v2_projection_turn_items SET updated_at=?, payload_json=json_set(payload_json,'$.revision',?) WHERE turn_item_id=?`,i=>`item-${3*i+1}`],
    ['executedRunPayloadUpdates',`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.revision',?) WHERE run_id=?`,i=>`run-${i+1}`],
  ]) {
    const handles=[['before',baseline,baselinePath],['after',improved,improvedPath]].map(([label,db,file])=>({label,db,file,statement:db.prepare(query),samples:[]}));
    for(const {db} of handles) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for(let batch=0;batch<17;batch++) {
      for(const handle of batch%2===0?handles:[...handles].reverse()) {
        const {db,statement,samples}=handle;
        const start=performance.now();db.exec('BEGIN');
        for(let i=0;i<500;i++) name==='nonErrorItemUpdates'?statement.run(at(batch+1),batch,parameter(i)):statement.run(batch,parameter(i));
        db.exec('COMMIT');
        if(batch>=2) samples.push(performance.now()-start);
      }
    }
    const measurements=Object.fromEntries(handles.map(({label,file,samples})=>[label,{medianBatchMs:percentile(samples,.5),p95BatchMs:percentile(samples,.95),samplesMs:samples,updates:8500,warmupBatches:2,walBytes:statSync(file+'-wal').size}]));
    result.writeOverhead[name]=measurements;
  }
  console.log(JSON.stringify(result,null,2));
} finally { baseline?.close(); improved?.close(); rmSync(directory,{recursive:true,force:true}); }
