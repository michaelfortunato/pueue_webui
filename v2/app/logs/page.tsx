"use client";

import { useEffect, useMemo, useState } from "react";

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

export default function LogsPage() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [taskId, setTaskId] = useState(params?.get("task") ?? "");
  const [lines, setLines] = useState(params?.get("lines") ?? "200");
  const [useLocalTime, setUseLocalTime] = useState(true);
  const [logData, setLogData] = useState<ApiLogResponse | null>(null);

  useEffect(() => {
    if (!taskId) return;
    const query = Number(lines) > 0 ? `?lines=${lines}` : "";
    fetch(`/api/logs/${taskId}${query}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => setLogData(json as ApiLogResponse))
      .catch((error) => setLogData({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }));
  }, [taskId, lines]);

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
          <h1>Log viewer</h1>
          <p className="notice">Standalone log page.</p>
        </div>
      </header>
      <section className="section-block">
        <div className="log-panel">
          <div className="log-controls">
            <input
              className="input"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              placeholder="Task id"
            />
            <input
              className="input"
              value={lines}
              onChange={(event) => setLines(event.target.value)}
              placeholder="Lines"
            />
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
              <div className="notice">Enter a task id to load logs.</div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
