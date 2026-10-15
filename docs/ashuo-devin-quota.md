# Ashuo running-status quota sources

Paired with Erralia branch `codex/ashuo-devin-quota-20261016`.

`/admin/runtime-status` retains its existing Telegram-to-Erralia authentication
path. It allowlists the optional `quotaSources` extension, with independently
validated Kimi (used) and Devin (remaining) windows. Account fields and secrets
are never projected. Unknown sources, duplicate identities, wrong meanings,
invalid percentages and malformed timestamps fail visibly.

The existing More → Running status page renders separate provider headings,
availability, collection time, freshness, daily/weekly quota and reset times.
Kimi failure cannot hide successful Devin data. A small browser-only clock marks
stale values after the freshness window; it performs no background requests.
Refresh failure clears prior data. Old backend v0 responses still render Kimi.

Verification: `npm run typecheck`, `npm test`, and
`node --import tsx scripts/verify-runtime-status.mts`. The runtime tests exercise
actual projected responses and the embedded UI functions with synthetic data.
They are not a claim of post-deployment Telegram WebView acceptance.

Deployment requires authorization. Only the Worker code changes; do not run
setup, database migrations, change secrets/bindings, or touch memory policy.
Record the current Worker version and rollback to that version on failure.
Deploying this frontend before the backend is safe but shows only Kimi until
the backend's opt-in reader is enabled and its daemon restarted.
