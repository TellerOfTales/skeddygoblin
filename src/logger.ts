/**
 * Minimal leveled logger with secret redaction.
 *
 * The redaction pass exists so that an accidental `logger.info({ config })`
 * cannot print the bot token. It is a safety net, not a licence to log config.
 */

import { config, knownSecrets, type LogLevel } from './config.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function redact(value: string): string {
  let out = value;
  // Read at call time, not module load: scoped configs (Discord, Steam) resolve
  // lazily, so the secret set grows after this module is first imported.
  for (const secret of knownSecrets()) {
    out = out.split(secret).join('***');
  }
  return out;
}

function serialize(fields: Record<string, unknown>): string {
  const safe = JSON.stringify(fields, (_key, value: unknown) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
  });
  return redact(safe ?? '{}');
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.logLevel]) return;

  const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), redact(message)];
  if (fields && Object.keys(fields).length > 0) line.push(serialize(fields));

  const text = line.join(' ');
  if (level === 'error' || level === 'warn') console.error(text);
  else console.log(text);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function make(context: Record<string, unknown>): Logger {
  const merge = (fields?: Record<string, unknown>): Record<string, unknown> =>
    Object.keys(context).length > 0 ? { ...context, ...fields } : (fields ?? {});

  return {
    debug: (m, f) => emit('debug', m, merge(f)),
    info: (m, f) => emit('info', m, merge(f)),
    warn: (m, f) => emit('warn', m, merge(f)),
    error: (m, f) => emit('error', m, merge(f)),
    child: (extra) => make({ ...context, ...extra }),
  };
}

export const logger: Logger = make({});
