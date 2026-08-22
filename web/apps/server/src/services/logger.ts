import pino from "pino";
import type { Logger } from "pino";

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface WorkflowLog {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  userId?: string;
  duration: number;
  statusCode: number;
  severity: LogSeverity;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface LoggerConfig {
  minSeverity: LogSeverity;
  maxLogs: number;
  enableWorkflowTracking: boolean;
}

const SEVERITY_LEVELS: Record<LogSeverity, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 50,
};

class WorkflowLogger {
  private logs: WorkflowLog[] = [];
  private config: LoggerConfig;
  private pinoLogger: Logger;

  constructor(config: LoggerConfig) {
    this.config = config;
    
    // Use simple pino configuration without pretty-printing
    // (pino-pretty is not available in production containers)
    this.pinoLogger = pino({
      level: config.minSeverity,
    });
  }

  /**
   * Update the minimum log severity level.
   * This affects both in-memory logging and pino output.
   */
  setMinSeverity(severity: LogSeverity): void {
    this.config.minSeverity = severity;
    this.pinoLogger.level = severity;
  }

  /**
   * Get current logger configuration.
   */
  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  /**
   * Log a workflow event (HTTP request + processing).
   */
  logWorkflow(log: Omit<WorkflowLog, "id" | "timestamp">): void {
    if (!this.shouldLog(log.severity)) {
      return;
    }

    const workflowLog: WorkflowLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      ...log,
    };

    this.logs.push(workflowLog);

    // Keep only the most recent N logs
    if (this.logs.length > this.config.maxLogs) {
      this.logs = this.logs.slice(-this.config.maxLogs);
    }

    // Also emit to pino
    this.pinoLogger[log.severity]({
      workflowId: workflowLog.id,
      method: log.method,
      url: log.url,
      statusCode: log.statusCode,
      duration: log.duration,
      userId: log.userId,
      context: log.context,
      error: log.error,
    }, log.message);
  }

  /**
   * Log a simple message at the given severity.
   */
  log(severity: LogSeverity, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(severity)) {
      return;
    }

    this.pinoLogger[severity]({ context }, message);
  }

  /**
   * Get all stored workflow logs, optionally filtered.
   */
  getLogs(options?: {
    severity?: LogSeverity;
    limit?: number;
    method?: string;
  }): WorkflowLog[] {
    let filtered = [...this.logs];

    if (options?.severity) {
      filtered = filtered.filter((l) => l.severity === options.severity);
    }

    if (options?.method) {
      filtered = filtered.filter((l) => l.method === options.method);
    }

    if (options?.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  /**
   * Get workflow statistics for summary views.
   */
  getStats(): {
    totalLogs: number;
    byMethod: Record<string, number>;
    bySeverity: Record<LogSeverity, number>;
    avgDuration: number;
    errorCount: number;
  } {
    const byMethod: Record<string, number> = {};
    const bySeverity: Record<LogSeverity, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };
    let totalDuration = 0;
    let errorCount = 0;

    for (const log of this.logs) {
      byMethod[log.method] = (byMethod[log.method] ?? 0) + 1;
      bySeverity[log.severity]++;
      totalDuration += log.duration;
      if (log.severity === "error") errorCount++;
    }

    return {
      totalLogs: this.logs.length,
      byMethod,
      bySeverity,
      avgDuration: this.logs.length > 0 ? totalDuration / this.logs.length : 0,
      errorCount,
    };
  }

  /**
   * Clear all stored logs.
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Export logs as JSON for sharing with agents.
   */
  exportAsJson(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        config: this.config,
        stats: this.getStats(),
        logs: this.logs,
      },
      null,
      2,
    );
  }

  /**
   * Export logs as newline-delimited JSON (JSONL) for streaming.
   */
  exportAsJsonl(): string {
    return this.logs
      .map((log) => JSON.stringify(log))
      .join("\n");
  }

  private shouldLog(severity: LogSeverity): boolean {
    if (!this.config.enableWorkflowTracking && severity === "debug") {
      return false;
    }
    return SEVERITY_LEVELS[severity] >= SEVERITY_LEVELS[this.config.minSeverity];
  }

  /**
   * Get the underlying pino logger for direct use.
   */
  getPino(): Logger {
    return this.pinoLogger;
  }
}

// Global singleton instance
let globalLogger: WorkflowLogger | null = null;

export function createLogger(config: LoggerConfig): WorkflowLogger {
  if (!globalLogger) {
    globalLogger = new WorkflowLogger(config);
  }
  return globalLogger;
}

export function getLogger(): WorkflowLogger {
  if (!globalLogger) {
    globalLogger = new WorkflowLogger({
      minSeverity: "info",
      maxLogs: 10000,
      enableWorkflowTracking: true,
    });
  }
  return globalLogger;
}
