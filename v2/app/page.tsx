"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";

type ApiStatusResponse = {
  ok: boolean;
  status?: Record<string, unknown>;
  error?: string;
};

type ApiLogResponse = {
  ok: boolean;
  log?: Record<string, unknown>;
  error?: string;
};

type TaskRow = {
  id: string;
  status: string;
  command: string;
  group?: string;
  path?: string;
  label?: string;
  priority?: number;
  timing?: {
    state: "queued" | "running" | "paused" | "done" | "unknown";
    start?: string;
    end?: string;
    result?: string;
  };
};

const POLL_MS = 2000;

function statusLabel(status: unknown): string {
  if (typeof status === "string") {
    return status;
  }
  if (status && typeof status === "object") {
    const keys = Object.keys(status as Record<string, unknown>);
    if (keys.length > 0) {
      return keys[0];
    }
  }
  return "unknown";
}

function normalizeTasks(status?: Record<string, unknown>): TaskRow[] {
  if (!status || typeof status !== "object") {
    return [];
  }

  const tasks = (status as { tasks?: Record<string, any> }).tasks;
  if (!tasks || typeof tasks !== "object") {
    return [];
  }

  return Object.entries(tasks).map(([id, task]) => {
    const command =
      typeof task?.command === "string"
        ? task.command
        : Array.isArray(task?.command)
          ? task.command.join(" ")
          : "";

    const timing = extractTiming(task?.status);
    return {
      id,
      status: statusLabel(task?.status),
      command,
      group: task?.group,
      path: task?.path,
      label: typeof task?.label === "string" ? task.label : undefined,
      priority: typeof task?.priority === "number" ? task.priority : undefined,
      timing,
    };
  });
}

function statusTone(status: string) {
  const lower = status.toLowerCase();
  if (["failed", "killed", "stashed", "panic"].some((s) => lower.includes(s))) {
    return "danger";
  }
  if (["paused", "queued", "locked"].some((s) => lower.includes(s))) {
    return "warn";
  }
  return "";
}

function extractTiming(status: unknown): TaskRow["timing"] {
  if (!status || typeof status !== "object") {
    return { state: "unknown" };
  }
  const record = status as Record<string, unknown>;
  const key = Object.keys(record)[0];
  if (!key) {
    return { state: "unknown" };
  }
  const detail = (record[key] ?? {}) as Record<string, unknown>;
  if (key === "Queued") {
    return { state: "queued" };
  }
  if (key === "Running") {
    return { state: "running", start: detail.start as string | undefined };
  }
  if (key === "Paused") {
    return { state: "paused", start: detail.start as string | undefined };
  }
  if (key === "Done") {
    return {
      state: "done",
      start: detail.start as string | undefined,
      end: detail.end as string | undefined,
      result: typeof detail.result === "string" ? detail.result : undefined,
    };
  }
  return { state: "unknown" };
}

function durationMs(start?: string, end?: string) {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

function formatDuration(ms?: number) {
  if (ms === undefined) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function taskFilterKey(task: TaskRow) {
  const timing = task.timing;
  if (!timing) return "unknown";
  if (timing.state === "done") {
    return timing.result === "Success" ? "done" : "failed";
  }
  return timing.state;
}

function canShowLogs(task: TaskRow) {
  const state = task.timing?.state;
  return state === "running" || state === "paused" || state === "done";
}

export default function Page() {
  const [data, setData] = useState<ApiStatusResponse>({ ok: true });
  const [loading, setLoading] = useState(true);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [sortBy, setSortBy] = useState("id-asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [logTaskId, setLogTaskId] = useState("1");
  const [logLines, setLogLines] = useState("200");
  const [logData, setLogData] = useState<ApiLogResponse | null>(null);
  const [useLocalTime, setUseLocalTime] = useState(true);
  const [quickFilters, setQuickFilters] = useState<Set<string>>(new Set());
  const [addCommand, setAddCommand] = useState("");
  const [addGroup, setAddGroup] = useState("default");
  const [addPriority, setAddPriority] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addStashed, setAddStashed] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = (await res.json()) as ApiStatusResponse;
      setData(json);
    } catch (error) {
      setData({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const guardedLoad = async () => {
      if (!live) return;
      await load();
    };

    guardedLoad();
    const timer = setInterval(guardedLoad, POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load]);

  const tasks = useMemo(() => normalizeTasks(data.status), [data.status]);
  const deferredSearch = useDeferredValue(search);
  const deferredStatus = useDeferredValue(statusFilter);
  const deferredGroup = useDeferredValue(groupFilter);
  const deferredSort = useDeferredValue(sortBy);
  const deferredQuickFilters = useDeferredValue(quickFilters);

  const groupNames = useMemo(() => {
    const names = new Set<string>();
    tasks.forEach((task) => names.add(task.group ?? "default"));
    const groups = (data.status as { groups?: Record<string, unknown> } | undefined)?.groups;
    if (groups && typeof groups === "object") {
      Object.keys(groups).forEach((name) => names.add(name));
    }
    return Array.from(names).sort((a, b) => {
      if (a === "default") return -1;
      if (b === "default") return 1;
      return a.localeCompare(b);
    });
  }, [tasks, data.status]);

  const statusOptions = useMemo(() => {
    const unique = new Set(tasks.map((task) => task.status));
    return Array.from(unique).sort();
  }, [tasks]);
  const groupOptions = useMemo(() => groupNames, [groupNames]);

  const counts = useMemo(() => {
    const total = tasks.length;
    const running = tasks.filter((task) => task.status.toLowerCase().includes("running")).length;
    const queued = tasks.filter((task) => task.status.toLowerCase().includes("queued")).length;
    const failed = tasks.filter((task) => task.status.toLowerCase().includes("failed")).length;
    return { total, running, queued, failed };
  }, [tasks]);

  const groupStats = useMemo(() => {
    const stats = new Map<
      string,
      {
        total: number;
        running: number;
        queued: number;
        paused: number;
        done: number;
        success: number;
        failed: number;
        durations: number[];
      }
    >();

    groupNames.forEach((group) => {
      stats.set(group, {
        total: 0,
        running: 0,
        queued: 0,
        paused: 0,
        done: 0,
        success: 0,
        failed: 0,
        durations: [],
      });
    });

    tasks.forEach((task) => {
      const group = task.group ?? "default";
      if (!stats.has(group)) {
        stats.set(group, {
          total: 0,
          running: 0,
          queued: 0,
          paused: 0,
          done: 0,
          success: 0,
          failed: 0,
          durations: [],
        });
      }
      const entry = stats.get(group)!;
      entry.total += 1;
      const timing = task.timing;
      if (!timing) return;
      if (timing.state === "running") entry.running += 1;
      if (timing.state === "queued") entry.queued += 1;
      if (timing.state === "paused") entry.paused += 1;
      if (timing.state === "done") {
        entry.done += 1;
        if (timing.result === "Success") {
          entry.success += 1;
        } else {
          entry.failed += 1;
        }
        const duration = durationMs(timing.start, timing.end);
        if (duration !== undefined) entry.durations.push(duration);
      }
    });

    return Array.from(stats.entries())
      .map(([group, entry]) => {
        const avgMs =
          entry.durations.length > 0
            ? entry.durations.reduce((sum, value) => sum + value, 0) / entry.durations.length
            : undefined;
        return {
          group,
          ...entry,
          avgDuration: formatDuration(avgMs),
        };
      })
      .sort((a, b) => {
        if (a.group === "default") return -1;
        if (b.group === "default") return 1;
        return a.group.localeCompare(b.group);
      });
  }, [tasks, groupNames]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 200);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filteredTasks = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    const filtered = tasks.filter((task) => {
      const group = task.group ?? "default";
      const matchesSearch =
        query.length === 0 ||
        task.id.toLowerCase().includes(query) ||
        task.command.toLowerCase().includes(query) ||
        group.toLowerCase().includes(query);
      const matchesStatus = deferredStatus === "all" || task.status === deferredStatus;
      const matchesGroup = deferredGroup === "all" || group === deferredGroup;
      const matchesQuick =
        deferredQuickFilters.size === 0 || deferredQuickFilters.has(taskFilterKey(task));
      return matchesSearch && matchesStatus && matchesGroup && matchesQuick;
    });

    const sorted = [...filtered];
    const [sortKey, sortDir] = deferredSort.split("-");
    sorted.sort((a, b) => {
      let value = 0;
      if (sortKey === "id") {
        value = Number(a.id) - Number(b.id);
      } else if (sortKey === "status") {
        value = a.status.localeCompare(b.status);
      } else if (sortKey === "command") {
        value = a.command.localeCompare(b.command);
      } else if (sortKey === "group") {
        value = (a.group ?? "").localeCompare(b.group ?? "");
      }
      return sortDir === "desc" ? -value : value;
    });
    return sorted;
  }, [tasks, deferredSearch, deferredStatus, deferredGroup, deferredSort, deferredQuickFilters]);

  const allSelected =
    filteredTasks.length > 0 && filteredTasks.every((task) => selectedIds.has(task.id));

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );

  const selectedDuration = useMemo(() => {
    if (!selectedTask?.timing) return "—";
    if (selectedTask.timing.state !== "done") return "—";
    return formatDuration(durationMs(selectedTask.timing.start, selectedTask.timing.end));
  }, [selectedTask]);

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    const next = new Set(selectedIds);
    filteredTasks.forEach((task) => next.add(task.id));
    setSelectedIds(next);
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  }

  async function runTaskAction(id: string, action: string) {
    const key = `${id}:${action}`;
    setPendingActions((prev) => new Set(prev).add(key));
    try {
      await fetch(`/api/task/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    } finally {
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function runBatchAction(action: string) {
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      await runTaskAction(id, action);
    }
  }

  async function addTask() {
    setAddError(null);
    if (!addCommand.trim()) {
      setAddError("Command is required.");
      return;
    }
    const priority = addPriority.trim() ? Number(addPriority.trim()) : undefined;
    const body = {
      command: addCommand.trim(),
      group: addGroup.trim() || "default",
      priority: Number.isFinite(priority) ? priority : undefined,
      label: addLabel.trim() || undefined,
      stashed: addStashed,
      start_immediately: !addStashed,
    };
    const res = await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string } | undefined;
    if (!json?.ok) {
      setAddError(json?.error ?? "Failed to add task.");
      return;
    }
    setAddCommand("");
    setAddLabel("");
    setAddPriority("");
    await load();
  }

  const logText = useMemo(() => {
    if (!logData?.log) return "";
    const log = logData.log;
    if (typeof log.output === "string") return log.output;
    if (typeof log.stdout === "string") return log.stdout;
    if (typeof log.text === "string") return log.text;
    if (typeof log.output === "object" && log.output && "stdout" in log.output) {
      return String((log.output as Record<string, unknown>).stdout ?? "");
    }
    return "";
  }, [logData]);

  const parsedLogLines = useMemo(() => {
    const lines = logText.split(/\r?\n/);
    return lines.map((line) => {
      const match = line.match(
        /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*(.*)$/
      );
      if (!match) {
        return { timestamp: null, rest: line, malformed: false };
      }
      const [, ts, rest] = match;
      const parsed = Date.parse(ts);
      if (Number.isNaN(parsed)) {
        return { timestamp: ts, rest, malformed: true };
      }
      const formatted = useLocalTime ? new Date(parsed).toLocaleString() : ts;
      return { timestamp: formatted, rest, malformed: false };
    });
  }, [logText, useLocalTime]);

  const hasMalformedLogs = useMemo(
    () => parsedLogLines.some((line) => line.malformed),
    [parsedLogLines]
  );

  async function loadLogs() {
    if (!logTaskId) return;
    const lines = Number(logLines);
    const query = Number.isFinite(lines) && lines > 0 ? `?lines=${lines}` : "";
    const res = await fetch(`/api/logs/${logTaskId}${query}`, { cache: "no-store" });
    const json = (await res.json()) as ApiLogResponse;
    setLogData(json);
  }

  return (
    <main>
      {!data.ok && (
        <div className="banner">
          <div>
            <strong>Backend offline.</strong> Start the Rust service in `v2/server` and retry.
          </div>
          <button className="action" onClick={load}>
            Retry
          </button>
        </div>
      )}
      <header>
        <div>
          <div className="badge">Local-first Pueue control</div>
          <h1>Pueue WebUI v2</h1>
          <p className="notice">
            {loading
              ? "Connecting to pueue…"
              : data.ok
                ? "Live view, polling every 2s"
                : `Error: ${data.error ?? "Unknown error"}`}
          </p>
        </div>
        <div className="card">
          <h3>Daemon status</h3>
          <p>{data.ok ? "Online" : "Offline"}</p>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h3>Total tasks</h3>
          <p>{counts.total}</p>
        </div>
        <div className="card">
          <h3>Running</h3>
          <p>{counts.running}</p>
        </div>
        <div className="card">
          <h3>Queued</h3>
          <p>{counts.queued}</p>
        </div>
        <div className="card">
          <h3>Failed</h3>
          <p>{counts.failed}</p>
        </div>
      </section>

      <h2 className="section-title">Group stats</h2>
      <div className="group-chips">
        <button
          className={`chip ${groupFilter === "all" ? "active" : ""}`}
          onClick={() => startTransition(() => setGroupFilter("all"))}
        >
          All groups
        </button>
        {groupStats.map((group) => (
          <button
            className={`chip ${groupFilter === group.group ? "active" : ""}`}
            key={group.group}
            onClick={() => startTransition(() => setGroupFilter(group.group))}
          >
            {group.group} · {group.total}
          </button>
        ))}
      </div>
      <div className="stats-table">
        <div className="stats-header">
          <div>Group</div>
          <div>Total</div>
          <div>Running</div>
          <div>Queued</div>
          <div>Paused</div>
          <div>Done</div>
          <div>Success</div>
          <div>Failed</div>
          <div>Avg duration</div>
        </div>
        {groupStats.map((group) => (
          <div className="stats-row" key={group.group}>
            <div>{group.group}</div>
            <div>{group.total}</div>
            <div>{group.running}</div>
            <div>{group.queued}</div>
            <div>{group.paused}</div>
            <div>{group.done}</div>
            <div>{group.success}</div>
            <div>{group.failed}</div>
            <div>{group.avgDuration}</div>
          </div>
        ))}
        {groupStats.length === 0 && (
          <div className="stats-row">
            <div>default</div>
            <div>0</div>
            <div>0</div>
            <div>0</div>
            <div>0</div>
            <div>0</div>
            <div>0</div>
            <div>0</div>
            <div>—</div>
          </div>
        )}
      </div>
      <h2 className="section-title">Log preview</h2>
      <div className="log-panel">
        <div className="log-controls">
          <input
            className="input"
            value={logTaskId}
            onChange={(event) => setLogTaskId(event.target.value)}
            placeholder="Task id"
          />
          <input
            className="input"
            value={logLines}
            onChange={(event) => setLogLines(event.target.value)}
            placeholder="Lines"
          />
          <button className="action" onClick={loadLogs}>
            Load logs
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={useLocalTime}
              onChange={(event) => setUseLocalTime(event.target.checked)}
            />
            <span>Local time</span>
          </label>
          <span className="notice">
            {logData?.ok === false ? `Log error: ${logData.error ?? "Unknown"}` : " "}
          </span>
        </div>
        {hasMalformedLogs && (
          <div className="log-error">
            Malformed timestamp detected. Log parsing failed for at least one entry.
          </div>
        )}
        <div className="log-output">
          {parsedLogLines.map((line, index) => (
            <div
              className={`log-line${line.malformed ? " log-line-error" : ""}`}
              key={`${index}-${line.timestamp ?? "nots"}`}
            >
              <span className="log-index">{String(index + 1).padStart(4, "0")}</span>
              {line.timestamp && <span className="log-time">{line.timestamp}</span>}
              <span className="log-text">{line.rest}</span>
            </div>
          ))}
          {parsedLogLines.length === 0 && <div className="notice">No log output.</div>}
        </div>
      </div>
      <h2 className="section-title">Task detail</h2>
      <div className="detail-panel">
        {selectedTask ? (
          <>
            <div className="detail-header">
              <div>
                <div className="badge">Task #{selectedTask.id}</div>
                <h3>{selectedTask.command || "(no command)"}</h3>
                <p className="notice">
                  {selectedTask.group ?? "default"} · {selectedTask.status}
                  {selectedTask.label ? ` · ${selectedTask.label}` : ""}
                </p>
              </div>
              <div className="actions">
                <button
                  className="action"
                  onClick={() => {
                    setLogTaskId(selectedTask.id);
                    loadLogs();
                  }}
                >
                  View logs
                </button>
              </div>
            </div>
            <div className="detail-grid">
              <div className="card">
                <h3>Status</h3>
                <p>{selectedTask.status}</p>
              </div>
              <div className="card">
                <h3>Group</h3>
                <p>{selectedTask.group ?? "default"}</p>
              </div>
              <div className="card">
                <h3>Duration</h3>
                <p>{selectedDuration}</p>
              </div>
              <div className="card">
                <h3>Priority</h3>
                <p>{selectedTask.priority ?? "—"}</p>
              </div>
            </div>
            <div className="detail-meta">
              <div>
                <strong>Path</strong>
                <div>{selectedTask.path ?? "—"}</div>
              </div>
              <div>
                <strong>Result</strong>
                <div>{selectedTask.timing?.result ?? "—"}</div>
              </div>
              <div>
                <strong>Label</strong>
                <div>{selectedTask.label ?? "—"}</div>
              </div>
            </div>
          </>
        ) : (
          <p className="notice">Select a task to see details.</p>
        )}
      </div>
      <h2 className="section-title">Launch task</h2>
      <div className="launch-panel">
        <div className="launch-grid">
          <input
            className="input"
            placeholder="Command (required)"
            value={addCommand}
            onChange={(event) => setAddCommand(event.target.value)}
          />
          <select className="input" value={addGroup} onChange={(event) => setAddGroup(event.target.value)}>
            {groupOptions.length === 0 && <option value="default">default</option>}
            {groupOptions.map((group) => (
              <option value={group} key={group}>
                {group}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Priority (optional)"
            value={addPriority}
            onChange={(event) => setAddPriority(event.target.value)}
          />
          <input
            className="input"
            placeholder="Label (optional)"
            value={addLabel}
            onChange={(event) => setAddLabel(event.target.value)}
          />
          <label className="checkbox">
            <input type="checkbox" checked={addStashed} onChange={(event) => setAddStashed(event.target.checked)} />
            <span>Stashed</span>
          </label>
          <button className="action" onClick={addTask}>
            Add task
          </button>
        </div>
        {addError && <div className="log-error">{addError}</div>}
      </div>
      <h2 className="section-title">Tasks</h2>
      <div className="toolbar">
        <input
          className="input"
          placeholder="Search id, command, group…"
          value={searchInput}
          onChange={(event) => startTransition(() => setSearchInput(event.target.value))}
        />
        <select
          className="input"
          value={statusFilter}
          onChange={(event) => startTransition(() => setStatusFilter(event.target.value))}
        >
          <option value="all">All status</option>
          {statusOptions.map((status) => (
            <option value={status} key={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={groupFilter}
          onChange={(event) => startTransition(() => setGroupFilter(event.target.value))}
        >
          <option value="all">All groups</option>
          {groupOptions.map((group) => (
            <option value={group} key={group}>
              {group}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={sortBy}
          onChange={(event) => startTransition(() => setSortBy(event.target.value))}
        >
          <option value="id-asc">Sort: ID ↑</option>
          <option value="id-desc">Sort: ID ↓</option>
          <option value="status-asc">Sort: Status A→Z</option>
          <option value="status-desc">Sort: Status Z→A</option>
          <option value="command-asc">Sort: Command A→Z</option>
          <option value="command-desc">Sort: Command Z→A</option>
          <option value="group-asc">Sort: Group A→Z</option>
          <option value="group-desc">Sort: Group Z→A</option>
        </select>
        <div className="quick-filters">
          {[
            ["running", "Running"],
            ["queued", "Queued"],
            ["paused", "Paused"],
            ["done", "Done"],
            ["failed", "Failed"],
          ].map(([key, label]) => (
            <label className="checkbox" key={key}>
              <input
                type="checkbox"
                checked={quickFilters.has(key)}
                onChange={() =>
                  startTransition(() =>
                    setQuickFilters((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) {
                        next.delete(key);
                      } else {
                        next.add(key);
                      }
                      return next;
                    })
                  )
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="batch-actions">
          {[
            ["start", "Start"],
            ["pause", "Pause"],
            ["resume", "Resume"],
            ["restart", "Restart"],
            ["kill", "Kill"],
            ["remove", "Remove"],
          ].map(([action, label]) => (
            <button
              className="action"
              key={action}
              disabled={selectedIds.size === 0}
              onClick={() => runBatchAction(action)}
            >
              {label} selected
            </button>
          ))}
        </div>
      </div>
      <div className="table">
        <div className="table-header">
          <div>
            <label className="checkbox">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              <span>Select</span>
            </label>
          </div>
          <div>ID</div>
          <div>Status</div>
          <div>Command</div>
          <div>Group</div>
          <div>Logs</div>
          <div>Actions</div>
        </div>
        {filteredTasks.map((task) => (
          <div className="table-row" key={task.id}>
            <div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={selectedIds.has(task.id)}
                  onChange={() => toggleSelect(task.id)}
                />
                <span>Pick</span>
              </label>
            </div>
            <div>{task.id}</div>
            <div>
              <span className={`status-pill ${statusTone(task.status)}`}>{task.status}</span>
            </div>
            <div>{task.command || "(no command)"}</div>
            <div>{task.group ?? "default"}</div>
            <div>
              <button
                className="action"
                disabled={!canShowLogs(task)}
                onClick={() => {
                  setLogTaskId(task.id);
                  loadLogs();
                }}
              >
                Logs
              </button>
            </div>
            <div className="actions">
              {[
                ["start", "Start"],
                ["pause", "Pause"],
                ["resume", "Resume"],
                ["restart", "Restart"],
                ["kill", "Kill"],
                ["remove", "Remove"],
              ].map(([action, label]) => {
                const disabled = pendingActions.has(`${task.id}:${action}`);
                return (
                  <button
                    className="action"
                    key={action}
                    disabled={disabled}
                    onClick={() => runTaskAction(task.id, action)}
                  >
                    {disabled ? "Working…" : label}
                  </button>
                );
              })}
              <button className="action" onClick={() => setSelectedTaskId(task.id)}>
                Details
              </button>
            </div>
          </div>
        ))}
        {filteredTasks.length === 0 && (
          <div className="table-row">
            <div>—</div>
            <div>
              <span className="status-pill">No tasks</span>
            </div>
            <div>Launch a task with pueue add</div>
            <div>default</div>
            <div>
              <button className="action" disabled>
                Logs
              </button>
            </div>
            <div className="actions">
              <button className="action" disabled>
                Awaiting tasks
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
