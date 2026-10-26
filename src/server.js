'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const logger = require('./logger');
const { AccountManager } = require('./accountManager');
const { ffmpegVersion, ensureDummyVideo, videoSourcePath } = require('./streamer');

const app = express();
const manager = new AccountManager();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ *
 * Auth: كلمة سر واحدة للوحة، بتتبعت في هيدر x-panel-key
 * ------------------------------------------------------------------ */

function requireAuth(req, res, next) {
  if (!config.panelPassword) return next(); // لو مفيش باسورد متسيب، مفتوح
  const key = req.get('x-panel-key') || req.query.key || '';
  if (key !== config.panelPassword) {
    return res.status(401).json({ ok: false, error: 'كلمة السر غلط.' });
  }
  return next();
}

// تحقق إن اللوحة محمية (الفرونت بيستخدمه عشان يعرف يطلب باسورد ولا لأ)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'discord-stream-afk',
    uptimeSec: Math.round(process.uptime()),
    protected: Boolean(config.panelPassword),
    stats: manager.stats(),
  });
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body || {};
  if (!config.panelPassword) return res.json({ ok: true });
  if (password === config.panelPassword) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: 'كلمة السر غلط.' });
});

app.use('/api', requireAuth);

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

app.get('/api/accounts', (req, res) => {
  res.json({ ok: true, accounts: manager.list(), stats: manager.stats() });
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { label, token, role } = req.body || {};
    const result = await manager.addAccount({ label, token, role });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const result = await manager.removeAccount(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * Guilds / channels (مساعدات للواجهة)
 * ------------------------------------------------------------------ */

app.get('/api/accounts/:id/guilds', (req, res) => {
  try {
    const account = manager.getAccount(req.params.id);
    if (!account.client) throw new Error('الحساب مش متصل.');

    const guilds = [...account.client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL ? g.iconURL({ dynamic: true, size: 64 }) : null,
    }));

    res.json({ ok: true, guilds });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/accounts/:id/guilds/:guildId/channels', async (req, res) => {
  try {
    const account = manager.getAccount(req.params.id);
    if (!account.client) throw new Error('الحساب مش متصل.');

    const guild = account.client.guilds.cache.get(req.params.guildId)
      || (await account.client.guilds.fetch(req.params.guildId).catch(() => null));
    if (!guild) throw new Error('السيرفر مش موجود أو الحساب مش عضو فيه.');

    const channels = [...guild.channels.cache.values()]
      .filter((c) => c.type === 'GUILD_VOICE' || c.type === 'GUILD_STAGE_VOICE')
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));

    res.json({ ok: true, guild: { id: guild.id, name: guild.name }, channels });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * Voice
 * ------------------------------------------------------------------ */

app.post('/api/accounts/:id/join', async (req, res) => {
  try {
    const { guildId, channelId } = req.body || {};
    const account = await manager.joinVoice(req.params.id, { guildId, channelId });
    res.json({ ok: true, account });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/accounts/:id/leave', async (req, res) => {
  try {
    const account = await manager.leaveVoice(req.params.id);
    res.json({ ok: true, account });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * Stream
 * ------------------------------------------------------------------ */

app.post('/api/accounts/:id/stream/start', async (req, res) => {
  try {
    const result = await manager.startStream(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/accounts/:id/stream/stop', async (req, res) => {
  try {
    const result = await manager.stopStream(req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ------------------------------------------------------------------ *
 * System
 * ------------------------------------------------------------------ */

app.get('/api/system', async (req, res) => {
  const ff = await ffmpegVersion();
  res.json({
    ok: true,
    stats: manager.stats(),
    ffmpeg: ff,
    videoSource: videoSourcePath(),
    stream: {
      fps: config.stream.fps,
      width: config.stream.width,
      height: config.stream.height,
      bitrate: config.stream.bitrate,
    },
    cooldownMs: config.joinCooldownMs,
  });
});

app.post('/api/system/prepare-video', async (req, res) => {
  try {
    const result = await ensureDummyVideo(true);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(400, parseInt(req.query.limit, 10) || 100);
  res.json({ ok: true, lines: logger.tail(limit) });
});

// Server-Sent Events للوجز المباشرة
app.get('/api/logs/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders && res.flushHeaders();

  const send = (line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  };

  // ابعت آخر 30 سطر كبداية
  for (const line of logger.tail(30)) send(line);

  const off = logger.onLine(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(ping);
    off();
  });
});

/* ------------------------------------------------------------------ *
 * Static UI
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'not found' });
  return res.sendFile(path.join(config.root, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ *
 * Error handler
 * ------------------------------------------------------------------ */

app.use((err, req, res, next) => {
  logger.error('http error:', err.message);
  if (res.headersSent) return next(err);
  return res.status(500).json({ ok: false, error: err.message || 'internal error' });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  logger.info('boot: starting discord-stream-afk');

  if (!config.panelPassword) {
    logger.warn('SECURITY: PANEL_PASSWORD فاضي — اللوحة مفتوحة لأي حد يعرف اللينك!');
  }

  const ff = await ffmpegVersion();
  if (!ff.ok) {
    logger.error('ffmpeg مش موجود. البث مش هيشتغل. تفاصيل:', ff.error || ff.bin);
  } else {
    logger.info('ffmpeg ok:', ff.version);
  }

  try {
    const v = await ensureDummyVideo(false);
    logger.info('video source ready:', v.path, `${Math.round(v.size / 1024)} KB`);
  } catch (e) {
    logger.error('failed to prepare dummy video:', e.message);
  }

  // إعادة اتصال دورية كل 45 ثانية
  setInterval(() => {
    manager.tickReconnects().catch((e) => logger.warn('reconnect tick:', e.message));
  }, 45000).unref?.();

  const server = app.listen(config.port, () => {
    logger.info(`panel listening on :${config.port}`);
  });

  const shutdown = async (sig) => {
    logger.info(`shutdown: ${sig}`);
    server.close();
    try { await manager.shutdown(); } catch (_) { /* ignore */ }
    setTimeout(() => process.exit(0), 500).unref?.();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', e && e.message ? e.message : e));
  process.on('uncaughtException', (e) => logger.error('uncaughtException:', e && e.stack ? e.stack : e));
}

boot().catch((e) => {
  logger.error('boot failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});