import { type LogData, type LogLevel, LogLevels, type Logger } from '@aztec/foundation/log';

export interface RecordedLine {
  module: string;
  level: LogLevel;
  message: string;
  /** The `event` field when the call carries one, else the message. This is the key CloudWatch histograms count. */
  event: string;
  data?: LogData;
  /** The second argument of `log.error`, which the real logger folds into the message. */
  error?: unknown;
}

/** The levels an operator sees in a deployed relayer, where the pino level is `info`. */
export const OPERATOR_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info'];

/**
 * A `Logger` that keeps every line in memory so a test can count them. `createChild` returns a logger that appends to
 * the same array, so one recorder covers a component and every child it builds.
 */
export class LogRecorder {
  readonly lines: RecordedLine[] = [];

  logger(module = 'test'): Logger {
    const write = (level: LogLevel, message: string, fields: unknown, error?: unknown): void => {
      const data = isLogData(fields) ? fields : undefined;
      const event = typeof data?.event === 'string' ? data.event : message;
      this.lines.push({ module, level, message, event, data, error });
    };
    const logger: Record<string, unknown> = {
      level: 'trace',
      module,
      isLevelEnabled: () => true,
      createChild: (childModule: string) => this.logger(`${module}:${childModule}`),
      getBindings: () => ({}),
    };
    for (const level of LogLevels) {
      logger[level] = (message: string, data?: unknown) => write(level, message, data);
    }
    logger.error = (message: string, err?: unknown, data?: LogData) => write('error', message, data, err);
    return logger as Logger;
  }

  /** Line counts keyed by event, over the given levels. */
  countByEvent(levels: readonly LogLevel[] = OPERATOR_LEVELS): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const line of this.lines) {
      if (levels.includes(line.level)) {
        counts[line.event] = (counts[line.event] ?? 0) + 1;
      }
    }
    return counts;
  }

  /** Total lines over the given levels. */
  count(levels: readonly LogLevel[] = OPERATOR_LEVELS): number {
    return this.lines.filter(line => levels.includes(line.level)).length;
  }

  clear(): void {
    this.lines.length = 0;
  }
}

function isLogData(data: unknown): data is LogData {
  return typeof data === 'object' && data !== null && !(data instanceof Error);
}
