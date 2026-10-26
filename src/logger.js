'use strict';

const MAX_LINES = 400;
const buffer = [];
const listeners = new Set();

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function push(level, parts) {
  const line = {
    level,
    time: stamp(),
    text: parts
      .map((p) => {
        if (p instanceof Error) return p.stack || p.message;
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch (_) { return String(p); }
      })
      .join(' '),
  };
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  for (const fn of listeners) {
    try { fn(line); } catch (_) { /* ignore */ }
  }
  // eslint-disable-next-line no-console
  console.log(`[${line.time}] ${level.toUpperCase()} ${line.text}`);
}

module.exports = {
  info: (...a) => push('info', a),
  warn: (...a) => push('warn', a),
  error: (...a) => push('error', a),
  debug: (...a) => push('debug', a),
  tail: (limit = 100) => buffer.slice(-limit),
  onLine: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};