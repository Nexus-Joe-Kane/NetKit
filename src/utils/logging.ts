type LogValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogValue>;

const sensitiveKey = /authorization|cookie|history|password|secret|signed|token|url/iu;

function sanitise(fields: LogFields): Record<string, Exclude<LogValue, undefined>> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sensitiveKey.test(key) ? "[redacted]" : value]),
  ) as Record<string, Exclude<LogValue, undefined>>;
}

function write(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitise(fields),
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

export const logger = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};
