# Pueue WebUI v2 Roadmap

## Phase 1: Foundations (1-2 weeks)
- Replace websocketd + Python glue with Node API routes calling `pueue` directly.
- Build fast status polling and actions (start/pause/resume/kill/remove).
- Normalize data into a stable UI model (task list, counts, groups).
- Establish UX baseline: responsive, clean table, actionable controls.

## Phase 2: Accuracy + Observability (2-3 weeks)
- Introduce a status cache (server-side) with monotonic update timestamps.
- Add per-task detail panel with latest status + metadata.
- Add log streaming (SSE) with configurable tail length.
- Add robust error handling: daemon down, stale data, permission issues.

## Phase 3: Power Features (3-6 weeks)
- Filters, search, sort (status, group, tags, duration).
- Task templates and quick actions (batch start/pause/kill).
- Task graphs (dependencies) and group dashboards.
- Multi-profile support (multiple pueue configs).

## Phase 4: Performance + Polish (ongoing)
- Virtualized task list for large task sets.
- WebSocket push for status changes (if pueue exposes events).
- Persistent settings + saved views.
- Theming + accessibility improvements.
