# T3 performance audit evidence — 2026-10-30

Synthetic reproduction artifacts for focused background-database performance fixes. Baseline: `pingdotgg/t3code` commit `78f1ba8285898d50af82a49c98364197d330db6a`. All work in this audit after the requested solo handoff was performed without subagents.

## Reproduce

Install the T3 checkout's locked dependencies. For standalone SQLite benchmarks use Node 24.22.1 (SQLite 3.53.4), the runtime used in both recorded hosts:

```sh
node benchmarks/background-polling.mjs > background-polling.json
node benchmarks/vacuum-batching.mjs > vacuum-batching.json
node benchmarks/settlement-sweep.mjs /absolute/path/to/t3-checkout > settlement-sweep.json
```

The scripts create and remove disposable SQLite fixtures. They do not open T3 userdata, launch a T3 server, change durability, or call providers. The service script creates two temporary source modules in the checkout and removes them in finally; run from a clean task-owned checkout with no simultaneous checks. The service script compares the pinned baseline implementation with the checkout's current implementation using the baseline test harness. Use the settlement PR head to reproduce that change. Plain baseline against baseline is also supported to quantify run noise. `T3_BENCH_SCALE` and `T3_BENCH_ITERATIONS` tune the SQL fixture; `T3_BENCH_THREADS` tunes settlement.

## SQL fixture and measurement limits

The schema JSON contains only the three relevant table definitions and their indexes exported from migrations 001-075. It includes active-item indexes from migration 073. Payloads are synthetic, with 4,000 threads, 120,000 items (40,000 failed errors, 400 usage-limit matches), 60,000 runs and 20,000 runs for one long thread. Baseline database: 277,110,784 bytes. Five warmups, 25 alternating paired samples, 32 MiB cache per connection; WAL/NORMAL, no automatic checkpoint during timing. Rows are compared for equality (recovery is unordered). JSON retains exact SQL, query plans, every sample, median and p95. These are warm-cache query components, not entire recovery queries, client latency, cold disk throughput, RSS, power usage, or crash-resolution measurements. Real app embedded Node/SQLite versions differ from the benchmark runtime.

| Query component | Mac M4 before → after median | Agentbox before → after median |
| --- | ---: | ---: |
| Historical usage-limit failure prefilter | 148.238 → 0.140 ms | 149.696 → 0.200 ms |
| Live PR polling selection | 4.861 → 0.195 ms | 1.888 → 0.099 ms |
| Latest executed run | 8.843 → 0.006 ms | 11.940 → 0.011 ms |

All three indexes together add 3,375,104 bytes (~3.22 MiB). Mac build latency was 584 ms; larger real histories may require substantially more time/space and hold the writer lock during migration. Index build time is measured once per host, not a distribution.

## Write tradeoff

Write tests alternate 17 batches of 500 updates and discard the first two timing batches. WAL includes all 8,500 updates. Non-error item updates have identical WAL bytes with/without indexes. Agentbox executed-run payload updates increased from median 3.279 to 3.952 ms/batch (20.5%); Mac timing showed no slowdown in this run. Timing differences are environment-dependent. Executed-run-update WAL increased on both hosts from 11,696,712 to 12,327,072 bytes (5.4%). The latest-run index trades some write work for bounded historical reads; no claim of lower total app writes is made. This fixture does not measure every affected insert/update/delete path, concurrent writers, or migration on a production-size database.

## Settlement service

Actual service `make/start/drain`, mocked projection/settings/Git/filesystem dependencies, 4,000 branchless threads five minutes after their latest user message. Threads are outside the queued-start grace period and younger than the three-day settlement threshold. Four warmups and 15 alternating samples per version, assertions of zero dispatches/Git lookups. The two initial settings reads plus two per thread fall from 8,002 to 2. The benchmark excludes database, actual secret materialization, providers and Git. Fresh settings are still checked before any settlement dispatch. Raw timings and read counts are in settlement-sweep-mac.json. Other host workloads can affect wall-clock samples; deterministic read counts establish eliminated work.

## Further finding: vacuum batching prototype

A disposable 8 MiB BLOB table is deleted, then exactly 1,024 pages are reclaimed. Existing one-page autocommits versus transactions of 32 one-page calls: six paired alternating samples after one warmup. Every case preserves retained data and passes integrity_check. Direct SQLite prototype only; it excludes Effect scheduling, checkpoint worker and concurrent writers.

| Host / implementation | Median elapsed | WAL bytes | Commits |
| --- | ---: | ---: | ---: |
| Mac / one-page | 67.220 ms | 8,437,792 | 1,024 |
| Mac / 32-page | 6.711 ms | 267,832 | 32 |
| Agentbox / one-page | 28.888 ms | 8,437,792 | 1,024 |
| Agentbox / 32-page | 4.291 ms | 267,832 | 32 |

This is a follow-up candidate, not a shipped fix. Batching changes how long the shared writer connection is reserved. It needs service-level WAL regression coverage, cancellation/rollback and foreground-writer latency checks. It applies only to incremental-auto-vacuum databases with free pages. A zero freelist cannot benefit.

## Review coverage and intentionally unmodified areas

Reviewed recovery and latest-run SQL, PR sync/watch scheduling, settlement decisions and settings changes, settings/secret caching, active-item indexes, compaction pacing, vacuum stepping/driver behavior, shell history counts, transcript streaming/budgets, command output, client persistence queues, trace/provider logging and telemetry buffering. This is a targeted source review with synthetic measurements, not an exhaustive profiler capture of every UI/provider/connection mode.

- Current upstream already caches materialized settings/secret objects, uses untraced per-candidate settlement helpers, filters event-triggered sweeps and persists a six-hour compaction marker. Do not duplicate those fixes.
- Migration 073 already indexes active item lookups. Do not duplicate it.
- Command output deltas use a bounded hub rather than one durable event per byte/chunk. History/catch-up paths have byte/row budgets. No new defect established here.
- Shell/thread/config persistence uses sliding(1) queues, 500 ms coalescing and 10-second spacing. No unbounded pending-snapshot queue established.
- Telemetry bounds its buffered events and backs off failures. Trace/provider logging already serializes asynchronous writes with rotation/backpressure. No new change proposed without workload evidence.
- Some shell counts/family scans still scale with history. Caching would introduce transactional invalidation and ancestry complexity; deferred until whole-service profiling establishes cost.
- No product defaults, data retention, durability, client protocols, provider models or remote connection modes change in the three fixes.
