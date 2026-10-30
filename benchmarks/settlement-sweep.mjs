import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const repo = resolve(process.argv[2]);
const dir = join(repo, 'apps/server/src/orchestration-v2');
const testResult = spawnSync('git', ['show', '78f1ba8285898d50af82a49c98364197d330db6a:apps/server/src/orchestration-v2/ThreadSettlementService.test.ts'], {cwd:repo,encoding:'utf8'});
if (testResult.status !== 0) throw new Error(testResult.stderr);
const test=testResult.stdout;
const original = readFileSync(join(dir, 'ThreadSettlementService.ts'), 'utf8');
const baseline = spawnSync('git', ['show', '78f1ba8285898d50af82a49c98364197d330db6a:apps/server/src/orchestration-v2/ThreadSettlementService.ts'], {cwd:repo,encoding:'utf8'});
if (baseline.status !== 0) throw new Error(baseline.stderr);
const baselinePath=join(dir,'settlement-audit-baseline.ts');
const scriptPath=join(dir,'settlement-audit-run.ts');
const imports=test.slice(0,test.indexOf('const NOW_MS')).split('\n').filter(line=>!line.includes('@effect/vitest')&&!line.includes('effect/testing')).join('\n');
const shell=test.slice(test.indexOf('const NOW_MS'),test.indexOf('function persistedLink'));
const helpers=test.slice(test.indexOf('type AutoSettleCommand'),test.indexOf('describe("ThreadSettlementServiceV2 worker"'));
const instrumented=helpers.replace('getSettings: Ref.get(settings),','getSettings: Effect.sync(() => { settingsReads++; }).pipe(Effect.andThen(Ref.get(settings))),').replace('ThreadSettlementService.make,','selectedMake,');
const code=imports+`\nimport * as Baseline from "./settlement-audit-baseline.ts";\nimport { performance } from "node:perf_hooks";\nimport assert from "node:assert/strict";\n`+shell+`\nconst NOW = new Date().toISOString();\nconst PROJECT_ID = ProjectId.make("settlement-project");\nlet settingsReads = 0;\nlet selectedMake = ThreadSettlementService.make;\n`+instrumented+`
const count=Number(process.env.T3_BENCH_THREADS ?? 4000);
const threads=Array.from({length:count},(_,i)=>makeThread('thread-'+i,{
 updatedAt: DateTime.makeUnsafe(NOW),latestUserMessageAt:DateTime.makeUnsafe(Date.parse(NOW) - 5 * 60_000),
}));
const samples={before:[],after:[]};const reads={before:[],after:[]};
for(let i=0;i<19;i++) for(const version of i%2===0?['before','after']:['after','before']) {
 selectedMake=version==='before'?Baseline.make:ThreadSettlementService.make;settingsReads=0;
 const ms=await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const fixture=yield* makeHarness({snapshot:makeSnapshot(threads),settings:{...DEFAULT_SERVER_SETTINGS,sidebarAutoSettleAfterDays:3}});
  return yield* Effect.gen(function*(){
   const service=yield* ThreadSettlementService.ThreadSettlementServiceV2;
   const start=performance.now();yield* startHarness(service,fixture.activation,fixture.snapshotReads);
   const elapsed=performance.now()-start;
   assert.equal((yield* Ref.get(fixture.commands)).length,0);
   assert.equal((yield* Ref.get(fixture.branchCalls)).length,0);
   return elapsed;
  }).pipe(Effect.provide(fixture.layer));
 })));
 if(i>=4){samples[version].push(ms);reads[version].push(settingsReads);}
}
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
console.log(JSON.stringify({node:process.version,threads:count,baseline:'78f1ba8285898d50af82a49c98364197d330db6a',iterations:15,warmup:4,fixture:'actual service; mocked projections/settings/IO; recent branchless threads; no DB or Git work; start+drain; alternating order',samplesMs:samples,settingsReads:reads,beforeMedianMs:median(samples.before),afterMedianMs:median(samples.after)},null,2));
`;
try { writeFileSync(baselinePath,baseline.stdout);writeFileSync(scriptPath,code);
const result=spawnSync(process.execPath,['--experimental-transform-types',scriptPath],{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;
} finally {unlinkSync(baselinePath);unlinkSync(scriptPath);}
