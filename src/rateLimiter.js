'use strict';

/**
 * طابور + Cooldown لكل مفتاح (مثلاً كل حساب).
 * الهدف: منع تنفيذ عمليتين صوت في نفس الوقت لنفس الحساب،
 * وفرض مسافة زمنية بينهم لتقليل احتمال الـ rate limit / temporary disable.
 */
class KeyedLimiter {
  constructor(options = {}) {
    this.cooldownMs = Number(options.cooldownMs) || 0;
    this.chains = new Map();
    this.lastDone = new Map();
    this.pending = new Map();
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  pendingCount(key) {
    return this.pending.get(key) || 0;
  }

  run(key, fn) {
    const previous = this.chains.get(key) || Promise.resolve();

    const task = previous.then(async () => {
      const last = this.lastDone.get(key) || 0;
      const wait = last + this.cooldownMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.pending.set(key, (this.pending.get(key) || 0) + 1);
      try {
        return await fn();
      } finally {
        this.pending.set(key, Math.max(0, (this.pending.get(key) || 1) - 1));
        this.lastDone.set(key, Date.now());
      }
    });

    this.chains.set(key, task.then(() => undefined, () => undefined));
    return task;
  }

  reset(key) {
    this.lastDone.delete(key);
  }
}

/** تأخير تصاعدي: 2s, 4s, 8s, 16s ... بحد أقصى 5 دقايق */
function backoffMs(attempt, base = 2000, max = 300000) {
  const raw = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(max, Math.round(raw));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { KeyedLimiter, backoffMs, sleep };