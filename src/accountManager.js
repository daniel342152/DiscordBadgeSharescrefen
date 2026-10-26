'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const config = require('./config');
const logger = require('./logger');
const { KeyedLimiter, backoffMs, sleep } = require('./rateLimiter');
const { StreamSession } = require('./streamer');

let Selfbot;
try {
  // eslint-disable-next-line global-require
  Selfbot = require('discord.js-selfbot-v13');
} catch (e) {
  logger.error('discord.js-selfbot-v13 is not installed:', e.message);
  Selfbot = null;
}

const STORE_FILE = path.join(config.dataDir, 'accounts.json');

/* ------------------------------------------------------------------ *
 * أدوات مساعدة
 * ------------------------------------------------------------------ */

function normalizeToken(raw) {
  const t = String(raw || '').trim().replace(/^"|"$/g, '');
  if (!t) return '';
  // شيل أي بادئة زي "Bearer " لو المستخدم لصقها
  return t.replace(/^Bearer\s+/i, '').trim();
}

function looksLikeToken(token) {
  // التوكنات الحديثة: 3 أجزاء مفصولة بنقطة (base64url)
  if (!token || token.length < 40) return false;
  return token.split('.').length === 3;
}

function friendlyDiscordError(err) {
  const msg = String((err && err.message) || err || '');
  const lower = msg.toLowerCase();

  if (lower.includes('token') && (lower.includes('invalid') || lower.includes('incorrect'))) {
    return 'التوكن غير صحيح (Invalid token). راجع إنك نسخت التوكن كامل.';
  }
  if (lower.includes('temporarily') || lower.includes('temporary disable')) {
    return 'الحساب معطّل مؤقتًا من ديسكورد (Temporary disabled). استنى شوية ومتحاولش تاني بسرعة.';
  }
  if (lower.includes('an invalid token') || lower.includes('401')) {
    return 'التوكن مرفوض من ديسكورد (401).';
  }
  if (lower.includes('captcha')) {
    return 'ديسكورد طلب CAPTCHA. الحساب محتاج تسجيل دخول يدوي من المتصفح أولاً.';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'وصلت لحد الـ rate limit. استنى دقيقة وحاول تاني.';
  }
  if (lower.includes('unknown guild') || lower.includes('unknown channel')) {
    return 'السيرفر أو الروم مش موجود / الحساب مش عضو فيه.';
  }
  if (lower.includes('missing access') || lower.includes('missing permissions')) {
    return 'الحساب مش عنده صلاحية يدخل الروم ده.';
  }
  return msg || 'خطأ غير معروف';
}

/* ------------------------------------------------------------------ *
 * مدير الحسابات
 * ------------------------------------------------------------------ */

class AccountManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.accounts = new Map();
    this.limiter = new KeyedLimiter({ cooldownMs: config.joinCooldownMs });
    this.voiceStateListeners = [];
    this.loadStore();
  }

  /* ---------------- persistence (اختياري) ---------------- */

  loadStore() {
    if (!config.persistTokens) return;
    try {
      if (!fs.existsSync(STORE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      for (const row of raw.accounts || []) {
        if (!row.token) continue;
        this.accounts.set(row.id, {
          id: row.id,
          label: row.label || 'account',
          role: row.role === 'viewer' ? 'viewer' : 'streamer',
          token: row.token,
          client: null,
          connection: null,
          stream: null,
          user: row.user || null,
          state: 'offline',
          lastError: null,
          joinedAt: null,
          createdAt: row.createdAt || Date.now(),
          reconnectAttempts: 0,
        });
      }
      logger.info(`accounts: loaded ${this.accounts.size} saved account(s)`);
    } catch (e) {
      logger.warn('accounts: failed to load store ->', e.message);
    }
  }

  saveStore() {
    if (!config.persistTokens) return;
    try {
      const rows = [...this.accounts.values()].map((a) => ({
        id: a.id,
        label: a.label,
        role: a.role,
        token: a.token,
        user: a.user,
        createdAt: a.createdAt,
      }));
      fs.writeFileSync(STORE_FILE, JSON.stringify({ accounts: rows }, null, 2), 'utf8');
      try { fs.chmodSync(STORE_FILE, 0o600); } catch (_) { /* windows */ }
    } catch (e) {
      logger.warn('accounts: failed to save store ->', e.message);
    }
  }

  /* ---------------- بناء عميل ديسكورد ---------------- */

  buildClient() {
    if (!Selfbot) throw new Error('discord.js-selfbot-v13 مش متثبت على السيرفر');

    const client = new Selfbot.Client({
      checkUpdate: false,
      patchVoice: true,
      // إعدادات تخفيف البصمة/التنبيهات
      sync: false,
      messageCaches: false,
      captchaService: undefined,
    });

    client.on('rateLimit', (info) => {
      logger.warn(`[rateLimit] ${info && info.method ? info.method : ''} ${info && info.path ? info.path : ''}`);
    });

    client.on('error', (e) => logger.warn('[client error]', e && e.message ? e.message : e));
    client.on('warn', (m) => logger.debug('[client warn]', m));

    return client;
  }

  /* ---------------- إضافة حساب + فحص التوكن ---------------- */

  async addAccount({ label, token, role = 'streamer' }) {
    if (this.accounts.size >= config.maxAccounts) {
      throw new Error(`وصلت للحد الأقصى (${config.maxAccounts} حسابات). امسح حساب قديم الأول.`);
    }

    const clean = normalizeToken(token);
    if (!clean) throw new Error('التوكن فاضي.');
    if (!looksLikeToken(clean)) {
      throw new Error('شكل التوكن غلط. لازم يكون 3 أجزاء مفصولة بنقطة (xxx.yyy.zzz).');
    }

    for (const existing of this.accounts.values()) {
      if (existing.token === clean) {
        return { duplicate: true, account: this.publicView(existing) };
      }
    }

    const account = {
      id: randomUUID(),
      label: (label || '').trim() || 'account',
      role: role === 'viewer' ? 'viewer' : 'streamer',
      token: clean,
      client: null,
      connection: null,
      stream: new StreamSession({ label: (label || 'account') }),
      user: null,
      state: 'checking',
      lastError: null,
      joinedAt: null,
      createdAt: Date.now(),
      reconnectAttempts: 0,
    };

    this.accounts.set(account.id, account);

    try {
      await this.login(account);
    } catch (e) {
      account.state = 'invalid';
      account.lastError = friendlyDiscordError(e);
      this.accounts.delete(account.id);
      throw new Error(account.lastError);
    }

    account.state = 'online';
    this.saveStore();
    logger.info(`accounts: added ${account.label} (${account.user ? account.user.tag : 'unknown'})`);

    return { duplicate: false, account: this.publicView(account) };
  }

  async login(account) {
    const client = this.buildClient();
    account.client = client;

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('انتهت مهلة الاتصال بديسكورد (timeout). جرّب تاني.')), 45000).unref?.();
    });

    await Promise.race([client.login(account.token), timeout]);

    if (client.token) account.token = client.token;

    const u = client.user;
    account.user = u
      ? {
        id: u.id,
        username: u.username,
        tag: u.tag || `${u.username}`,
        avatar: u.displayAvatarURL ? u.displayAvatarURL({ dynamic: true, size: 128 }) : null,
        verified: Boolean(u.verified),
        premiumType: u.premiumType || 0,
        createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
      }
      : null;

    return account.user;
  }

  /* ---------------- عمليات الصوت ---------------- */

  getAccount(id) {
    const acc = this.accounts.get(id);
    if (!acc) throw new Error('الحساب غير موجود في اللوحة.');
    return acc;
  }

  async joinVoice(id, { guildId, channelId }) {
    const account = this.getAccount(id);

    if (!account.client || !account.client.token) {
      throw new Error('الحساب مش متصل بديسكورد. امسحه وضيفه تاني.');
    }
    if (account.connection) {
      throw new Error('الحساب أصلاً في روم صوتي. اعمله Leave الأول.');
    }
    if (this.limiter.pendingCount(id) > 0) {
      throw new Error('فيه عملية صوت شغالة بالفعل على الحساب ده. استنى ثانية.');
    }

    const gid = String(guildId || '').trim();
    const cid = String(channelId || '').trim();
    if (!/^\d{15,25}$/.test(gid)) throw new Error('Server ID غلط. لازم يكون أرقام فقط.');
    if (!/^\d{15,25}$/.test(cid)) throw new Error('Voice Channel ID غلط. لازم يكون أرقام فقط.');

    return this.limiter.run(id, async () => {
      account.state = 'joining';
      account.lastError = null;

      const guild = account.client.guilds.cache.get(gid)
        || (await account.client.guilds.fetch(gid).catch(() => null));
      if (!guild) throw new Error('السيرفر مش موجود أو الحساب مش عضو فيه.');

      const channel = guild.channels.cache.get(cid)
        || (await guild.channels.fetch(cid).catch(() => null));
      if (!channel) throw new Error('الروم مش موجود في السيرفر ده.');
      const VOICE_TYPES = ['GUILD_VOICE', 'GUILD_STAGE_VOICE'];
      if (!VOICE_TYPES.includes(channel.type)) {
        throw new Error('الـ ID ده مش روم صوتي (Voice Channel).');
      }

      const connection = account.client.voice.joinChannel(channel, {
        selfMute: false,
        selfDeaf: false,
        selfVideo: false,
      });

      account.connection = connection;

      connection.on('disconnect', () => {
        logger.warn(`accounts[${account.label}]: voice disconnected`);
        account.state = 'disconnected';
      });
      connection.on('error', (e) => {
        logger.warn(`accounts[${account.label}]: voice error ->`, e.message);
        account.lastError = e.message;
      });

      // نستنى تأكيد الاتصال (أو نفشل بعد 30 ثانية)
      await this.waitForVoiceReady(connection, 30000);

      account.state = 'in-voice';
      account.joinedAt = Date.now();
      account.guildId = gid;
      account.channelId = cid;
      account.channelName = channel.name;
      account.guildName = guild.name;
      account.reconnectAttempts = 0;

      logger.info(`accounts[${account.label}]: joined voice ${guild.name} / ${channel.name}`);
      return this.publicView(account);
    });
  }

  waitForVoiceReady(connection, timeoutMs) {
    if (connection.state && connection.state.status === 'ready') return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('الاتصال بالروم الصوتي مكملش (timeout). جرّب تاني.'));
      }, timeoutMs);

      const onReady = () => { cleanup(); resolve(); };
      const onError = (e) => { cleanup(); reject(new Error(friendlyDiscordError(e))); };
      const onDisconnect = () => { cleanup(); reject(new Error('الاتصال اتقطع قبل ما يثبت.')); };

      function cleanup() {
        clearTimeout(timer);
        try {
          if (typeof connection.off === 'function') {
            connection.off('ready', onReady);
            connection.off('error', onError);
            connection.off('disconnect', onDisconnect);
          }
        } catch (_) { /* ignore */ }
      }

      connection.once('ready', onReady);
      connection.once('error', onError);
      connection.once('disconnect', onDisconnect);
    });
  }

  async startStream(id) {
    const account = this.getAccount(id);

    if (account.role === 'viewer') {
      throw new Error('الحساب ده متسجل كـ Viewer. الـ Stream يشتغل من حساب الـ Streamer.');
    }
    if (!account.connection) {
      throw new Error('الحساب مش في روم صوتي. ادخل الروم الأول.');
    }

    account.state = 'streaming';
    try {
      const status = await account.stream.start(account.connection);
      logger.info(`accounts[${account.label}]: stream started`);
      return { account: this.publicView(account), stream: status };
    } catch (e) {
      account.state = 'in-voice';
      account.lastError = e.message;
      throw new Error(`فشل تشغيل الشير سكرين: ${e.message}`);
    }
  }

  async stopStream(id) {
    const account = this.getAccount(id);
    const status = await account.stream.stop();
    if (account.state === 'streaming') account.state = account.connection ? 'in-voice' : 'online';
    return { account: this.publicView(account), stream: status };
  }

  async leaveVoice(id, { silent = false } = {}) {
    const account = this.getAccount(id);

    return this.limiter.run(id, async () => {
      try { await account.stream.stop(); } catch (_) { /* ignore */ }

      if (account.connection) {
        try { account.connection.disconnect(); } catch (_) { /* ignore */ }
        try { account.connection.destroy(); } catch (_) { /* ignore */ }
        account.connection = null;
      }

      account.state = account.client && account.client.token ? 'online' : 'offline';
      account.joinedAt = null;
      account.guildId = null;
      account.channelId = null;
      account.channelName = null;
      account.guildName = null;

      if (!silent) logger.info(`accounts[${account.label}]: left voice`);
      return this.publicView(account);
    });
  }

  async removeAccount(id) {
    const account = this.getAccount(id);

    try { await this.leaveVoice(id, { silent: true }); } catch (_) { /* ignore */ }

    if (account.client) {
      try { account.client.destroy(); } catch (_) { /* ignore */ }
    }

    this.accounts.delete(id);
    this.limiter.reset(id);
    this.saveStore();
    logger.info(`accounts: removed ${account.label}`);
    return { removed: true, id };
  }

  /* ---------------- إعادة الاتصال التلقائي ---------------- */

  async tickReconnects() {
    for (const account of this.accounts.values()) {
      if (!account.client) continue;
      if (account.state === 'streaming' || account.state === 'joining') continue;
      if (account.connection && account.state !== 'disconnected') continue;
      if (account.state === 'disconnected' || (account.lastError && account.state === 'in-voice')) {
        if (account.reconnectAttempts >= 5) continue;
        account.reconnectAttempts += 1;
        const wait = backoffMs(account.reconnectAttempts, 5000, 120000);
        logger.info(`accounts[${account.label}]: reconnect attempt ${account.reconnectAttempts} in ${Math.round(wait / 1000)}s`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(wait);
        try {
          if (account.guildId && account.channelId) {
            account.connection = null;
            account.state = 'online';
            // eslint-disable-next-line no-await-in-loop
            await this.joinVoice(account.id, { guildId: account.guildId, channelId: account.channelId });
          }
        } catch (e) {
          account.lastError = e.message;
          logger.warn(`accounts[${account.label}]: reconnect failed ->`, e.message);
        }
      }
    }
  }

  /* ---------------- عرض الحالة ---------------- */

  publicView(account) {
    return {
      id: account.id,
      label: account.label,
      role: account.role,
      state: account.state,
      user: account.user,
      lastError: account.lastError,
      guildId: account.guildId || null,
      channelId: account.channelId || null,
      guildName: account.guildName || null,
      channelName: account.channelName || null,
      joinedAt: account.joinedAt || null,
      voiceDurationSec: account.joinedAt ? Math.round((Date.now() - account.joinedAt) / 1000) : 0,
      stream: account.stream ? account.stream.status() : null,
      createdAt: account.createdAt,
    };
  }

  list() {
    return [...this.accounts.values()].map((a) => this.publicView(a));
  }

  stats() {
    const all = [...this.accounts.values()];
    return {
      total: all.length,
      online: all.filter((a) => a.client && a.client.token).length,
      inVoice: all.filter((a) => Boolean(a.connection)).length,
      streaming: all.filter((a) => a.stream && a.stream.active).length,
      max: config.maxAccounts,
    };
  }

  async shutdown() {
    for (const account of this.accounts.values()) {
      try { await this.leaveVoice(account.id, { silent: true }); } catch (_) { /* ignore */ }
      try { if (account.client) account.client.destroy(); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = { AccountManager, friendlyDiscordError, looksLikeToken, normalizeToken };