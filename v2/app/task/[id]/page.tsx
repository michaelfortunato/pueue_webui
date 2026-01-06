"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

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

function formatTimestamp(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toLocaleString();
}

export default function TaskPage() {
  const params = useParams();
  const taskId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string | undefined);
  const [status, setStatus] = useState<ApiStatusResponse>({ ok: true });
  const [logData, setLogData] = useState<ApiLogResponse | null>(null);
  const [lines, setLines] = useState("");
  const [useLocalTime, setUseLocalTime] = useState(true);

  useEffect(() => {
    if (!taskId) return;
    fetch("/api/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => setStatus(json as ApiStatusResponse))
      .catch((error) =>
        setStatus({ ok: false, error: error instanceof Error ? error.message : "Unknown error" })
      );
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    const parsed = Number(lines);
    const useLines = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
    fetch(`/api/logs/${taskId}?lines=${useLines}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => setLogData(json as ApiLogResponse))
      .catch((error) =>
        setLogData({ ok: false, error: error instanceof Error ? error.message : "Unknown error" })
      );
  }, [taskId, lines]);

  const task = useMemo(() => {
    const tasks = (status.status as { tasks?: Record<string, any> } | undefined)?.tasks ?? {};
    return taskId ? tasks[taskId] : null;
  }, [status.status, taskId]);

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
    if (!taskId) return [];
    return logText.split(/\r?\n/).map((line) => {
      const match = line.match(
        /^(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)\\s*(.*)$/
      );
      if (!match) {
        return { timestamp: null, rest: line, malformed: false };
      }
      const [, ts, rest] = match;
      const parsed = Date.parse(ts);
      if (Number.isNaN(parsed)) {
        return { timestamp: ts, rest, malformed: true };
      }
      const formatted = useLocalTime ? formatTimestamp(ts) : ts;
      return { timestamp: formatted, rest, malformed: false };
    });
  }, [logText, taskId, useLocalTime]);

  return (
    <main>
      <header>
        <div>
          <h1>Task {taskId ?? ""}</h1>
          <p className="notice">{status.ok ? "Task detail" : status.error ?? "Error loading task"}</p>
        </div>
      </header>
      <section className="section-block">
        {task ? (
          <div className="detail-panel">
            <div className="detail-grid">
              <div className="card">
                <h3>Status</h3>
                <p>{task.status ? Object.keys(task.status)[0] : "unknown"}</p>
              </div>
              <div className="card">
                <h3>Group</h3>
                <p>{task.group ?? "default"}</p>
              </div>
              <div className="card">
                <h3>Command</h3>
                <p>{Array.isArray(task.command) ? task.command.join(" ") : task.command ?? ""}</p>
              </div>
              <div className="card">
                <h3>Path</h3>
                <p>{task.path ?? "—"}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="notice">Task not found.</div>
        )}
      </section>
      <section className="section-block">
        <div className="log-panel">
          <div className="log-controls">
            <input
              className="input"
              value={lines}
              onChange={(event) => setLines(event.target.value)}
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
            <a className="action link" href={`/logs?task=${encodeURIComponent(taskId ?? "")}&lines=${encodeURIComponent(lines)}`} target="_blank" rel="noreferrer">
              Open logs in new tab
            </a>
          </div>
          <div className="log-output">
            {taskId ? (
              parsedLogLines.map((line, index) => (
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
              <div className="notice">Select a task to load logs.</div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
