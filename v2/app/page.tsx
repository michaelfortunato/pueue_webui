"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
  const statusOptions = useMemo(() => {
    const unique = new Set(tasks.map((task) => task.status));
    return Array.from(unique).sort();
  }, [tasks]);
  const groupOptions = useMemo(() => {
    const unique = new Set(tasks.map((task) => task.group ?? "default"));
    return Array.from(unique).sort();
  }, [tasks]);

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
      .sort((a, b) => a.group.localeCompare(b.group));
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = tasks.filter((task) => {
      const group = task.group ?? "default";
      const matchesSearch =
        query.length === 0 ||
        task.id.toLowerCase().includes(query) ||
        task.command.toLowerCase().includes(query) ||
        group.toLowerCase().includes(query);
      const matchesStatus = statusFilter === "all" || task.status === statusFilter;
      const matchesGroup = groupFilter === "all" || group === groupFilter;
      const matchesQuick = quickFilters.size === 0 || quickFilters.has(taskFilterKey(task));
      return matchesSearch && matchesStatus && matchesGroup && matchesQuick;
    });

    const sorted = [...filtered];
    const [sortKey, sortDir] = sortBy.split("-");
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
  }, [tasks, search, statusFilter, groupFilter, sortBy]);

  const allSelected =
    filteredTasks.length > 0 && filteredTasks.every((task) => selectedIds.has(task.id));

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
            <div className="log-line" key={`${index}-${line.timestamp ?? "nots"}`}>
              <span className="log-index">{String(index + 1).padStart(4, "0")}</span>
              {line.timestamp && <span className="log-time">{line.timestamp}</span>}
              <span className="log-text">{line.rest}</span>
            </div>
          ))}
          {parsedLogLines.length === 0 && <div className="notice">No log output.</div>}
        </div>
      </div>
      <h2 className="section-title">Tasks</h2>
      <div className="toolbar">
        <input
          className="input"
          placeholder="Search id, command, group…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">All status</option>
          {statusOptions.map((status) => (
            <option value={status} key={status}>
              {status}
            </option>
          ))}
        </select>
        <select className="input" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
          <option value="all">All groups</option>
          {groupOptions.map((group) => (
            <option value={group} key={group}>
              {group}
            </option>
          ))}
        </select>
        <select className="input" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
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
                  setQuickFilters((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) {
                      next.delete(key);
                    } else {
                      next.add(key);
                    }
                    return next;
                  })
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
