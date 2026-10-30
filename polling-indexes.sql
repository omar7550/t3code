-- Additive indexes only. Apply with T3 fully stopped after a verified database backup.
-- Does not change the application migration ledger. Do not VACUUM the live database.
BEGIN IMMEDIATE;
CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_usage_limit_idx
ON orchestration_v2_projection_turn_items(thread_id)
WHERE type = 'error' AND status = 'failed'
  AND json_extract(payload_json, '$.failure.class') = 'usage_limit';

CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_pull_request_poll_idx
ON orchestration_v2_projection_threads(updated_at, thread_id)
WHERE deleted_at IS NULL
  AND json_extract(payload_json, '$.archivedAt') IS NULL
  AND json_array_length(payload_json, '$.pullRequests') > 0;

CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_latest_executed_idx
ON orchestration_v2_projection_runs(
  thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
)
WHERE status <> 'queued'
  AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL);
COMMIT;
