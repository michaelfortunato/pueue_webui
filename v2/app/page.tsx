"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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
  commandDisplay: string;
  group?: string;
  path?: string;
  label?: string;
  priority?: number;
  timing?: {
    state: "queued" | "running" | "paused" | "done" | "unknown";
    start?: string;
    end?: string;
    enqueuedAt?: string;
    result?: string;
  };
};

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
    const commandDisplay = command.replace(/(--\S+)/g, "$1\u200b");

    const timing = extractTiming(task?.status);
    return {
      id,
      status: statusLabel(task?.status),
      command,
      commandDisplay,
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
  if (["failed", "killed", "panic"].some((s) => lower.includes(s))) {
    return "danger";
  }
  if (["queued", "paused", "locked"].some((s) => lower.includes(s))) {
    return "warn";
  }
  if (["stashed", "staged"].some((s) => lower.includes(s))) {
    return "muted";
  }
  if (["done", "success"].some((s) => lower.includes(s))) {
    return "success";
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
    return { state: "queued", enqueuedAt: detail.enqueued_at as string | undefined };
  }
  if (key === "Running") {
    return {
      state: "running",
      start: detail.start as string | undefined,
      enqueuedAt: detail.enqueued_at as string | undefined,
    };
  }
  if (key === "Paused") {
    return {
      state: "paused",
      start: detail.start as string | undefined,
      enqueuedAt: detail.enqueued_at as string | undefined,
    };
  }
  if (key === "Done") {
    return {
      state: "done",
      start: detail.start as string | undefined,
      end: detail.end as string | undefined,
      enqueuedAt: detail.enqueued_at as string | undefined,
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

function formatTimestamp(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toLocaleString();
}

function taskFilterKey(task: TaskRow) {
  const timing = task.timing;
  if (!timing) return "unknown";
  if (timing.state === "done") {
    return timing.result === "Success" ? "done" : "failed";
  }
  return timing.state;
}

function isFailedTask(task: TaskRow) {
  const timing = task.timing;
  if (timing?.state === "done") {
    return timing.result !== "Success";
  }
  return task.status.toLowerCase().includes("failed");
}

function canShowLogs(task: TaskRow) {
  const state = task.timing?.state;
  return state === "running" || state === "paused" || state === "done";
}

function statusDigest(status?: Record<string, unknown>) {
  if (!status || typeof status !== "object") return "empty";
  const tasks = (status as { tasks?: Record<string, any> }).tasks ?? {};
  let hash = 5381;
  let count = 0;
  for (const id in tasks) {
    const task = tasks[id];
    const label = statusLabel(task?.status);
    const group = task?.group ?? "default";
    const chunk = `${id}|${label}|${group}|${task?.label ?? ""}|${task?.priority ?? ""}`;
    for (let i = 0; i < chunk.length; i += 1) {
      hash = (hash * 33) ^ chunk.charCodeAt(i);
    }
    count += 1;
  }
  const groups = (status as { groups?: Record<string, any> }).groups ?? {};
  for (const name in groups) {
    const g = groups[name];
    const chunk = `${name}|${g?.parallel_tasks ?? ""}|${g?.status ?? ""}`;
    for (let i = 0; i < chunk.length; i += 1) {
      hash = (hash * 33) ^ chunk.charCodeAt(i);
    }
  }
  return `${hash >>> 0}:${count}`;
}

type ActionDef = { action: string; label: string; icon: string };

type TaskRowProps = {
  task: TaskRow;
  isSelected: boolean;
  isActive: boolean;
  isMenuOpen: boolean;
  isCopied: boolean;
  pendingActions: Set<string>;
  actionDefs: ActionDef[];
  onToggleSelect: (id: string) => void;
  onOpenLog: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onRunAction: (id: string, action: string) => void;
  onSelectRow: (id: string) => void;
  onOpenTask: (id: string) => void;
  onCopyCommand: (id: string) => void;
};

const TaskRowView = memo(
  function TaskRowView({
    task,
    isSelected,
    isActive,
    isMenuOpen,
    pendingActions,
    actionDefs,
    onToggleSelect,
    onOpenLog,
    onToggleMenu,
    onRunAction,
    onSelectRow,
    onOpenTask,
    onCopyCommand,
    isCopied,
  }: TaskRowProps) {
    return (
      <div
        className={`table-row clickable${isActive ? " active" : ""}`}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, input, select, textarea, label, a")) {
            return;
          }
          onSelectRow(task.id);
        }}
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, input, select, textarea, label, a")) {
            return;
          }
          onOpenTask(task.id);
        }}
      >
        <div className="cell task">
          <label className="checkbox" onClick={(event) => event.stopPropagation()}>
            <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(task.id)} />
            <span className="sr-only">Select</span>
          </label>
          <span className="task-id">#{task.id}</span>
          <span
            className="group-pill"
            title={task.group ?? "default"}
            style={{ "--group-color": groupColor(task.group) } as React.CSSProperties}
          >
            {task.group ?? "default"}
          </span>
          <button
            className="action mini"
            disabled={!canShowLogs(task)}
            onClick={(event) => {
              event.stopPropagation();
              onOpenLog(task.id);
            }}
          >
            Logs
          </button>
        </div>
        <div className="cell status">
          <span className={`status-pill ${statusTone(task.status)}`}>{task.status}</span>
          {task.timing?.start && <div className="status-meta">Started {formatTimestamp(task.timing.start)}</div>}
          {task.timing?.end && <div className="status-meta">Ended {formatTimestamp(task.timing.end)}</div>}
          {task.timing?.state === "done" && (
            <div className="status-meta">Duration {formatDuration(durationMs(task.timing.start, task.timing.end))}</div>
          )}
        </div>
        <div className="cell command">
          <div className="command-block">
            <div className="command-head">
              <button
                className="command-copy"
                title="Copy command"
                onClick={(event) => {
                  event.stopPropagation();
                  const text = task.command || "";
                  if (!text) return;
                  const done = () => onCopyCommand(task.id);
                  if (navigator?.clipboard?.writeText) {
                    void navigator.clipboard.writeText(text).then(done);
                    return;
                  }
                  const el = document.createElement("textarea");
                  el.value = text;
                  el.style.position = "fixed";
                  el.style.opacity = "0";
                  document.body.appendChild(el);
                  el.select();
                  document.execCommand("copy");
                  document.body.removeChild(el);
                  done();
                }}
              >
                <span className="icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    <rect x="4" y="4" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </span>
                {isCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="command-text" title={task.command}>
              {task.command ? task.commandDisplay : "(no command)"}
            </div>
          </div>
        </div>
        <div className="cell actions">
          <button
            className="action icon"
            title="Actions"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu(task.id);
            }}
          >
            ⋯
          </button>
          {isMenuOpen && (
            <div className="action-menu" onClick={(event) => event.stopPropagation()}>
              {actionDefs.map((item) => {
                const disabled = pendingActions.has(`${task.id}:${item.action}`);
                return (
                  <button
                    className="action"
                    key={item.action}
                    disabled={disabled}
                    onClick={() => onRunAction(task.id, item.action)}
                  >
                    <span className="action-icon">{item.icon}</span>
                    <span>{disabled ? "Working…" : item.label}</span>
                  </button>
                );
              })}
              <button className="action" onClick={() => onSelectRow(task.id)}>
                Details
              </button>
            </div>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.task === next.task &&
    prev.isSelected === next.isSelected &&
    prev.isActive === next.isActive &&
    prev.isMenuOpen === next.isMenuOpen &&
    prev.isCopied === next.isCopied &&
    prev.pendingActions === next.pendingActions
);


const GROUP_PALETTE = [
  "#5aa0ff",
  "#7b6cff",
  "#f2b94f",
  "#ff7a7a",
  "#4cc3ff",
  "#69d19a",
  "#d58cff",
];

const EMPTY_PENDING = new Set<string>();

function groupColor(name: string | undefined) {
  const key = (name ?? "default").toLowerCase();
  if (key === "default") return "#5aa0ff";
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return GROUP_PALETTE[hash % GROUP_PALETTE.length];
}

export default function Page() {
  const [data, setData] = useState<ApiStatusResponse>({ ok: true });
  const [loading, setLoading] = useState(true);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [groupFilters, setGroupFilters] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState("id-asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [logTaskId, setLogTaskId] = useState("");
  const [logLines, setLogLines] = useState("");
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
  const [groupName, setGroupName] = useState("");
  const [groupParallel, setGroupParallel] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [showAddGroupRow, setShowAddGroupRow] = useState(false);
  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const logSectionRef = useRef<HTMLDivElement | null>(null);
  const [pollMs, setPollMs] = useState(750);
  const [pollInput, setPollInput] = useState("0.75");
  const [openActionRowId, setOpenActionRowId] = useState<string | null>(null);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const router = useRouter();
  const [renderMode, setRenderMode] = useState<"auto" | "paginate">("auto");
  const [pageSize, setPageSize] = useState(200);
  const [pageIndex, setPageIndex] = useState(0);
  const loadInFlightRef = useRef(false);
  const [isVisible, setIsVisible] = useState(true);
  const lastDigestRef = useRef<string | null>(null);

  const openLogModal = useCallback(() => {
    setIsLogModalOpen(true);
  }, []);

  useEffect(() => {
    if (!isLogModalOpen) return;
    const timer = setTimeout(() => {
      logSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
    return () => clearTimeout(timer);
  }, [isLogModalOpen]);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = (await res.json()) as ApiStatusResponse;
      if (json.ok) {
        const nextDigest = statusDigest(json.status);
        if (nextDigest === lastDigestRef.current) {
          setLoading(false);
          return;
        }
        lastDigestRef.current = nextDigest;
      } else {
        lastDigestRef.current = null;
      }
      setData(json);
    } catch (error) {
      setData({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const guardedLoad = async () => {
      if (!live) return;
      if (!isVisible) return;
      await load();
    };

    guardedLoad();
    const timer = setInterval(guardedLoad, pollMs);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [load, pollMs, isVisible]);

  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const tasks = useMemo(() => normalizeTasks(data.status), [data.status]);
  const deferredSearch = useDeferredValue(search);
  const deferredStatus = useDeferredValue(statusFilter);
  const deferredGroupFilters = useDeferredValue(groupFilters);
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
    const running = tasks.filter((task) => task.timing?.state === "running").length;
    const queued = tasks.filter((task) => task.timing?.state === "queued").length;
    const completed = tasks.filter((task) => task.timing?.state === "done").length;
    const failed = tasks.filter((task) => isFailedTask(task)).length;
    return { total, running, queued, completed, failed };
  }, [tasks]);

  const failedIds = useMemo(() => {
    const ids = tasks.filter((task) => isFailedTask(task)).map((task) => task.id);
    return ids.sort((a, b) => Number(a) - Number(b));
  }, [tasks]);

  const groupStats = useMemo(() => {
    const statsFromServer = data.status && "stats" in data && (data as any).stats;
    if (statsFromServer && statsFromServer.groups && typeof statsFromServer.groups === "object") {
      const entries = Object.entries(statsFromServer.groups as Record<string, any>).map(([group, entry]) => {
        const avgDuration = formatDuration(entry.avg_ms ?? undefined);
        const stddevDuration = formatDuration(entry.stddev_ms ?? undefined);
        return {
          group,
          total: entry.total ?? 0,
          running: entry.running ?? 0,
          queued: entry.queued ?? 0,
          paused: entry.paused ?? 0,
          done: entry.done ?? 0,
          success: entry.success ?? 0,
          failed: entry.failed ?? 0,
          durations: [],
          failedIds: Array.isArray(entry.failed_ids) ? entry.failed_ids.map(String) : [],
          avgDuration,
          stddevDuration,
        };
      });
      return entries.sort((a, b) => {
        if (a.group === "default") return -1;
        if (b.group === "default") return 1;
        return a.group.localeCompare(b.group);
      });
    }
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
        failedIds: string[];
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
        failedIds: [],
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
          failedIds: [],
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
          entry.failedIds.push(task.id);
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
        const variance =
          entry.durations.length > 1 && avgMs !== undefined
            ? entry.durations.reduce((sum, value) => sum + (value - avgMs) ** 2, 0) /
              (entry.durations.length - 1)
            : undefined;
        const stddevMs = variance !== undefined ? Math.sqrt(variance) : undefined;
        return {
          group,
          ...entry,
          avgDuration: formatDuration(avgMs),
          stddevDuration: formatDuration(stddevMs),
        };
      })
      .sort((a, b) => {
        if (a.group === "default") return -1;
        if (b.group === "default") return 1;
        return a.group.localeCompare(b.group);
      });
  }, [tasks, groupNames, data]);

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
      const matchesGroup = deferredGroupFilters.size === 0 || deferredGroupFilters.has(group);
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
  }, [tasks, deferredSearch, deferredStatus, deferredGroupFilters, deferredSort, deferredQuickFilters]);

  const maxRows = 500;
  const autoLimited = filteredTasks.length > maxRows ? filteredTasks.slice(0, maxRows) : filteredTasks;
  const pageCount = useMemo(() => {
    if (renderMode !== "paginate") return 1;
    return Math.max(1, Math.ceil(filteredTasks.length / pageSize));
  }, [renderMode, filteredTasks.length, pageSize]);

  const displayedTasks = useMemo(() => {
    if (renderMode === "paginate") {
      const start = pageIndex * pageSize;
      return filteredTasks.slice(start, start + pageSize);
    }
    return autoLimited;
  }, [filteredTasks, pageIndex, pageSize, renderMode, autoLimited]);

  const allSelected =
    displayedTasks.length > 0 && displayedTasks.every((task) => selectedIds.has(task.id));

  const pendingById = useMemo(() => {
    const map = new Map<string, Set<string>>();
    pendingActions.forEach((key) => {
      const [id, action] = key.split(":");
      if (!id || !action) return;
      const set = map.get(id) ?? new Set<string>();
      set.add(action);
      map.set(id, set);
    });
    return map;
  }, [pendingActions]);

  const actionDefs = useMemo(
    () => [
      { action: "start", label: "Start", icon: "▶" },
      { action: "pause", label: "Pause", icon: "⏸" },
      { action: "resume", label: "Resume", icon: "⏵" },
      { action: "restart", label: "Restart", icon: "↻" },
      { action: "kill", label: "Stop", icon: "■" },
      { action: "remove", label: "Remove", icon: "✕" },
    ],
    []
  );

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
      startTransition(() => setSelectedIds(new Set()));
      return;
    }
    const next = new Set(selectedIds);
    displayedTasks.forEach((task) => next.add(task.id));
    startTransition(() => setSelectedIds(next));
    setSelectedTaskId(null);
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    startTransition(() => setSelectedIds(next));
  }

  useEffect(() => {
    if (renderMode !== "paginate") {
      setPageIndex(0);
      return;
    }
    setPageIndex((prev) => Math.min(prev, Math.max(0, pageCount - 1)));
  }, [renderMode, pageCount]);

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

  async function addGroupAction() {
    setGroupError(null);
    if (!groupName.trim()) {
      setGroupError("Group name is required.");
      return;
    }
    const parallel = groupParallel.trim() ? Number(groupParallel.trim()) : undefined;
    const body = {
      action: "add",
      name: groupName.trim(),
      parallel_tasks: Number.isFinite(parallel) ? parallel : undefined,
    };
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string } | undefined;
    if (!json?.ok) {
      setGroupError(json?.error ?? "Failed to add group.");
      return;
    }
    setGroupName("");
    setGroupParallel("");
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
    if (!logTaskId) return [];
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
  const logWindow = useMemo(() => {
    const limit = 1200;
    if (parsedLogLines.length <= limit) {
      return { lines: parsedLogLines, offset: 0, total: parsedLogLines.length, limit };
    }
    return {
      lines: parsedLogLines.slice(-limit),
      offset: parsedLogLines.length - limit,
      total: parsedLogLines.length,
      limit,
    };
  }, [parsedLogLines]);

  async function loadLogs(targetId?: string) {
    const id = targetId ?? logTaskId;
    if (!id) return;
    const parsed = Number(logLines);
    const lines = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
    const query = `?lines=${lines}`;
    const res = await fetch(`/api/logs/${id}${query}`, { cache: "no-store" });
    const json = (await res.json()) as ApiLogResponse;
    setLogData(json);
  }

  useEffect(() => {
    if (!logTaskId) {
      setLogData(null);
      return;
    }
    const timer = setTimeout(() => {
      void loadLogs();
    }, 200);
    return () => clearTimeout(timer);
  }, [logTaskId, logLines]);

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
          <h1>Pueue WebUI v2</h1>
          <div className="header-meta">
            <p className="notice">
              {loading
                ? "Connecting to pueue…"
                : data.ok
                  ? "Live view"
                  : `Error: ${data.error ?? "Unknown error"}`}
            </p>
            <label className="header-label">
              Refresh
              <input
                className="input"
                value={pollInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setPollInput(value);
                  const seconds = Number(value);
                  if (Number.isFinite(seconds) && seconds > 0) {
                    setPollMs(Math.max(250, Math.round(seconds * 1000)));
                  }
                }}
                placeholder="seconds"
                inputMode="decimal"
              />
            </label>
          </div>
          <details className="header-advanced">
            <summary>Advanced</summary>
            <div className="advanced-controls">
              <label className="header-label">
                Row rendering
                <select
                  className="input"
                  value={renderMode}
                  onChange={(event) => setRenderMode(event.target.value as "auto" | "paginate")}
                >
                  <option value="auto">Auto (all rows)</option>
                  <option value="paginate">Pagination</option>
                </select>
              </label>
              {renderMode === "paginate" && (
                <label className="header-label">
                  Page size
                  <input
                    className="input"
                    value={String(pageSize)}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next > 0) {
                        setPageSize(Math.max(25, Math.min(1000, Math.floor(next))));
                      }
                    }}
                    inputMode="numeric"
                  />
                </label>
              )}
            </div>
          </details>
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h3>Total tasks</h3>
          <p>{counts.total}</p>
        </div>
        <div className="card">
          <h3>
            <span className="stat-icon running" aria-hidden="true">
              ▶
            </span>
            Running
          </h3>
          <p>{counts.running}</p>
        </div>
        <div className="card">
          <h3>
            <span className="stat-icon queued" aria-hidden="true">
              ⏳
            </span>
            Queued
          </h3>
          <p>{counts.queued}</p>
        </div>
        <div className="card">
          <h3>
            <span className="stat-icon completed" aria-hidden="true">
              ✓
            </span>
            Completed
          </h3>
          <p>{counts.completed}</p>
        </div>
        <div className="card">
          <h3>Failed</h3>
          <p>
            {counts.failed}
            {counts.failed > 1 && (
              <span className="tooltip-anchor" role="button" tabIndex={0}>
                <span className="tooltip-dot" />
                <span className="tooltip">
                  <strong>Failed task IDs</strong>
                  <div className="tooltip-list">
                    {failedIds.slice(0, 4).map((id) => (
                      <span className="tooltip-item" key={id}>
                        {id}
                      </span>
                    ))}
                    {counts.failed > failedIds.length && (
                      <span className="tooltip-item tooltip-muted">
                        {counts.failed - failedIds.length} unknown (not in list)
                      </span>
                    )}
                    {failedIds.length > 4 && <span className="tooltip-item">…</span>}
                  </div>
                </span>
              </span>
            )}
          </p>
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2 className="section-title">Groups</h2>
          <p className="section-note">Default stays pinned first. Click a chip to filter the task list.</p>
        </div>
        <div className="group-actions">
          <button className="action primary" onClick={() => setShowAddGroupRow((prev) => !prev)}>
            {showAddGroupRow ? "Hide add group" : "Add group"}
          </button>
        </div>
        <div className="group-chips">
          <button
            className={`chip ${groupFilters.size === 0 ? "active" : ""}`}
            onClick={() => startTransition(() => setGroupFilters(new Set()))}
            style={{ "--group-color": groupColor("default") } as React.CSSProperties}
          >
            All groups
          </button>
          {groupStats.map((group) => {
            const active = groupFilters.size === 0 || groupFilters.has(group.group);
            return (
            <button
              className={`chip ${active ? "active" : "inactive"}`}
              key={group.group}
              onClick={() =>
                startTransition(() =>
                  setGroupFilters((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.group)) {
                      next.delete(group.group);
                    } else {
                      next.add(group.group);
                    }
                    return next;
                  })
                )
              }
              title={`${group.group} (${group.total})`}
              style={{ "--group-color": groupColor(group.group) } as React.CSSProperties}
            >
              <span className="chip-label">{group.group}</span>
              <span className="chip-count">{group.total}</span>
            </button>
          )})}
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
            <div></div>
          </div>
          {groupStats.map((group) => (
            <div className="stats-row" key={group.group}>
              <div className="truncate" title={group.group}>
                <span className="group-pill" style={{ "--group-color": groupColor(group.group) } as React.CSSProperties}>
                  {group.group}
                </span>
              </div>
              <div>{group.total}</div>
              <div>{group.running}</div>
              <div>{group.queued}</div>
              <div>{group.paused}</div>
              <div>{group.done}</div>
              <div>{group.success}</div>
              <div>
                {group.failed > 0 ? (
                  <span className="tooltip-anchor" role="button" tabIndex={0}>
                    <span className="failed-count">{group.failed}</span>
                    <span className="tooltip">
                      <strong>Failed task IDs</strong>
                      <div className="tooltip-list">
                        {group.failedIds.slice(0, 4).map((id) => (
                          <span className="tooltip-item" key={id}>
                            {id}
                          </span>
                        ))}
                        {group.failedIds.length > 4 && <span className="tooltip-item">…</span>}
                      </div>
                    </span>
                  </span>
                ) : (
                  group.failed
                )}
              </div>
              <div>
                {group.avgDuration} ± {group.stddevDuration}
              </div>
              <div className="group-row-action">
                {group.group !== "default" && (
                  <button
                    className="icon-button"
                    title={`Remove group ${group.group}`}
                    onClick={() => {
                      if (!window.confirm(`Remove group "${group.group}"?`)) return;
                      setGroupError(null);
                      const name = group.group;
                      void (async () => {
                        const body = { action: "remove", name };
                        const res = await fetch("/api/groups", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(body),
                        });
                        const json = (await res.json()) as { ok?: boolean; error?: string } | undefined;
                        if (!json?.ok) {
                          setGroupError(json?.error ?? "Failed to remove group.");
                          return;
                        }
                        await load();
                      })();
                    }}
                  >
                    🗑
                  </button>
                )}
              </div>
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
              <div className="group-row-action">—</div>
            </div>
          )}
          {showAddGroupRow && (
            <div className="stats-row stats-row-editor">
              <div className="stats-editor">
                <input
                  className="input"
                  placeholder="Group name"
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                />
                <input
                  className="input"
                  placeholder="Parallel tasks (optional)"
                  value={groupParallel}
                  onChange={(event) => setGroupParallel(event.target.value)}
                />
                <button className="action" onClick={addGroupAction}>
                  Add group
                </button>
              </div>
              {groupError && <div className="log-error">{groupError}</div>}
            </div>
          )}
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2 className="section-title">Log preview</h2>
          <p className="section-note">Preview logs here, or open the full viewer in a modal.</p>
        </div>
        <div className="launch-panel">
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
              placeholder="Lines (default 200)"
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={useLocalTime}
                onChange={(event) => setUseLocalTime(event.target.checked)}
              />
              <span>Local time</span>
            </label>
            <button className="action" onClick={() => setIsLogModalOpen(true)}>
              Open full viewer
            </button>
            <a
              className="action link"
              href={`/logs?task=${encodeURIComponent(logTaskId || "")}&lines=${encodeURIComponent(logLines)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in new tab
            </a>
            <span className="notice">
              {logData?.ok === false ? `Log error: ${logData.error ?? "Unknown"}` : " "}
            </span>
          </div>
          {hasMalformedLogs && (
            <div className="log-error">
              Malformed timestamp detected. Log parsing failed for at least one entry.
            </div>
          )}
          <div className="log-output log-preview-output">
            {logTaskId ? (
              parsedLogLines.slice(0, 12).map((line, index) => (
                <div
                  className={`log-line${line.malformed ? " log-line-error" : ""}`}
                  key={`${index}-${line.timestamp ?? "nots"}`}
                >
                  <span className="log-index">{String(index + 1).padStart(4, "0")}</span>
                  {line.timestamp && <span className="log-time">{line.timestamp}</span>}
                  <span className="log-text">{line.rest}</span>
                </div>
              ))
            ) : (
              <div className="notice">Enter a task id to preview logs.</div>
            )}
            {logTaskId && parsedLogLines.length === 0 && (
              <div className="notice">No log output loaded yet.</div>
            )}
          </div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2 className="section-title">Tasks</h2>
          <p className="section-note">Click a row to focus it and sync the detail + log viewer.</p>
        </div>
        {renderMode === "auto" && filteredTasks.length > maxRows && (
          <div className="notice">
            Showing the first {maxRows} tasks for performance. Use Advanced → Row rendering to view all tasks.
          </div>
        )}
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
          value={
            groupFilters.size === 0 ? "all" : groupFilters.size === 1 ? Array.from(groupFilters)[0] : "multiple"
          }
          onChange={(event) =>
            startTransition(() => {
              const value = event.target.value;
              if (value === "all") {
                setGroupFilters(new Set());
                return;
              }
              setGroupFilters(new Set([value]));
            })
          }
        >
          <option value="all">All groups</option>
          {groupFilters.size > 1 && <option value="multiple">Multiple groups</option>}
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
          {actionDefs.map((item) => (
            <button
              className="action"
              key={item.action}
              disabled={selectedIds.size === 0}
              onClick={() => runBatchAction(item.action)}
            >
              <span className="action-icon">{item.icon}</span>
              <span>{item.label} selected</span>
            </button>
          ))}
        </div>
      </div>
        <div className="table">
          <div className="table-header">
            <div className="cell task">
              <label className="checkbox">
                <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                <span>Select</span>
              </label>
              <span>Task</span>
            </div>
            <div className="cell status">Status</div>
            <div className="cell command">Command</div>
            <div className="cell actions">Actions</div>
          </div>
          {displayedTasks.map((task) => (
            <TaskRowView
              key={task.id}
              task={task}
              isSelected={selectedIds.has(task.id)}
              isActive={selectedTaskId === task.id}
              isMenuOpen={openActionRowId === task.id}
              isCopied={copiedTaskId === task.id}
              pendingActions={pendingById.get(task.id) ?? EMPTY_PENDING}
              actionDefs={actionDefs}
              onToggleSelect={toggleSelect}
              onOpenLog={(id) => {
                setLogTaskId(id);
                void loadLogs(id);
                openLogModal();
              }}
              onToggleMenu={(id) => setOpenActionRowId((prev) => (prev === id ? null : id))}
              onRunAction={(id, action) => void runTaskAction(id, action)}
              onSelectRow={(id) => {
                setSelectedTaskId(id);
              }}
              onOpenTask={(id) => router.push(`/task/${id}`)}
              onCopyCommand={(id) => {
                setCopiedTaskId(id);
                setTimeout(() => setCopiedTaskId((prev) => (prev === id ? null : prev)), 1200);
              }}
            />
          ))}
        {displayedTasks.length === 0 && (
          <div className="table-row">
            <div className="cell task">—</div>
            <div className="cell status">
              <span className="status-pill">No tasks</span>
            </div>
            <div className="cell command">Launch a task with pueue add</div>
            <div className="cell actions actions">
              <button className="action" disabled>
                Awaiting tasks
              </button>
            </div>
          </div>
        )}
        </div>
        {renderMode === "paginate" && (
          <div className="pagination">
            <button
              className="action"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((prev) => Math.max(0, prev - 1))}
            >
              Prev
            </button>
            <span className="notice">
              Page {pageIndex + 1} of {pageCount}
            </span>
            <button
              className="action"
              disabled={pageIndex >= pageCount - 1}
              onClick={() => setPageIndex((prev) => Math.min(pageCount - 1, prev + 1))}
            >
              Next
            </button>
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2 className="section-title">Task detail</h2>
          <p className="section-note">Focus a task row to update this panel.</p>
        </div>
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
                  onClick={(event) => {
                    event.stopPropagation();
                    setLogTaskId(selectedTask.id);
                    void loadLogs(selectedTask.id);
                    openLogModal();
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
      </section>

      <section className="section-block">
        <div className="section-head">
          <h2 className="section-title">Launch task</h2>
          <p className="section-note">Submit a new command to the queue.</p>
        </div>
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
      </section>

      {isLogModalOpen && (
        <div className="log-modal" role="dialog" aria-modal="true">
          <div className="log-modal-backdrop" onClick={() => setIsLogModalOpen(false)} />
          <div className="log-modal-content" ref={logSectionRef}>
            <div className="log-modal-header">
              <div>
                <h2 className="section-title">Log viewer</h2>
                <p className="section-note">Running, paused, and completed tasks support logs.</p>
              </div>
              <button className="action" onClick={() => setIsLogModalOpen(false)}>
                Close
              </button>
            </div>
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
                  placeholder="Lines (default 200)"
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={useLocalTime}
                    onChange={(event) => setUseLocalTime(event.target.checked)}
                  />
                  <span>Local time</span>
                </label>
                <a
                  className="action link"
                  href={`/logs?task=${encodeURIComponent(logTaskId || "")}&lines=${encodeURIComponent(logLines)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in new tab
                </a>
                <span className="notice">
                  {logData?.ok === false ? `Log error: ${logData.error ?? "Unknown"}` : " "}
                </span>
              </div>
              {hasMalformedLogs && (
                <div className="log-error">
                  Malformed timestamp detected. Log parsing failed for at least one entry.
                </div>
              )}
              {logWindow.total > logWindow.lines.length && (
                <div className="notice">
                  Showing last {logWindow.lines.length} of {logWindow.total} log lines.
                </div>
              )}
              <div className="log-output">
                {logWindow.lines.map((line, index) => (
                  <div
                    className={`log-line${line.malformed ? " log-line-error" : ""}`}
                    key={`${logWindow.offset + index}-${line.timestamp ?? "nots"}`}
                  >
                    <span className="log-index">
                      {String(logWindow.offset + index + 1).padStart(4, "0")}
                    </span>
                    {line.timestamp && <span className="log-time">{line.timestamp}</span>}
                    <span className="log-text">{line.rest}</span>
                  </div>
                ))}
                {logWindow.lines.length === 0 && <div className="notice">No log output.</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
