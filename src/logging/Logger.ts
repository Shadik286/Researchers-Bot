/**
 * Structured JSON logger.
 *
 * Hard rule: secrets never reach the output. Any field whose key looks like a
 * credential is replaced with "[redacted]" before serialization, and known
 * secret VALUES registered via `registerSecret()` are scrubbed from strings.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACT_KEY_PATTERN =
  /(api[-_]?key|authorization|auth|token|secret|password|credential|bearer|cookie|set-cookie)/i;

const REDACTED = "[redacted]";

const registeredSecrets = new Set<string>();

/** Registers a secret VALUE so it is scrubbed even if it leaks into a message. */
export function registerSecret(secret: string | undefined): void {
  if (secret && secret.trim().length >= 6) registeredSecrets.add(secret.trim());
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export interface LogFields {
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  /** Injectable sink - tests capture lines instead of writing to stdout. */
  sink?: (line: string) => void;
  clock?: () => Date;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly base: LogFields;
  private readonly sink: (line: string) => void;
  private readonly clock: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.base = options.base ?? {};
    this.sink = options.sink ?? ((line) => process.stdout.write(line + "\n"));
    this.clock = options.clock ?? (() => new Date());
  }

  child(fields: LogFields): Logger {
    return new Logger({
      level: this.level,
      base: { ...this.base, ...fields },
      sink: this.sink,
      clock: this.clock,
    });
  }

  debug(event: string, fields?: LogFields): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const payload = {
      level,
      time: this.clock().toISOString(),
      event,
      ...sanitizeFields(this.base),
      ...sanitizeFields(fields ?? {}),
    };
    try {
      this.sink(JSON.stringify(payload));
    } catch {
      this.sink(JSON.stringify({ level: "error", event: "log_serialization_failed", time: this.clock().toISOString() }));
    }
  }
}

function scrubString(value: string): string {
  let out = value;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === "object") {
    return sanitizeFields(value as LogFields, depth + 1);
  }
  return String(value);
}

function sanitizeFields(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeValue(value, depth);
  }
  return out;
}

let rootLogger: Logger | undefined;

export function getLogger(): Logger {
  if (!rootLogger) rootLogger = new Logger();
  return rootLogger;
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

/** Exported for tests. */
export const __internal = { sanitizeFields, scrubString };
