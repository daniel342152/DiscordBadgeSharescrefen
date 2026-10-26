'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config');
const logger = require('./logger');

/* ------------------------------------------------------------------ *
 * 1) إيجاد ffmpeg
 * ------------------------------------------------------------------ */

let cachedFfmpeg = null;

function resolveFfmpeg() {
  if (cachedFfmpeg) return cachedFfmpeg;

  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) {
    cachedFfmpeg = config.ffmpegPath;
    return cachedFfmpeg;
  }

  try {
    // eslint-disable-next-line global-require
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) {
      cachedFfmpeg = staticPath;
      return cachedFfmpeg;
    }
  } catch (_) { /* not installed -> fall back to PATH */ }

  cachedFfmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return cachedFfmpeg;
}

function ffmpegVersion() {
  return new Promise((resolve) => {
    const bin = resolveFfmpeg();
    const child = spawn(bin, ['-version']);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve({ ok: false, bin, error: 'ffmpeg not found' }));
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        bin,
        version: (out.split('\n')[0] || '').trim(),
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 2) توليد فيديو dummy (مرة واحدة، لو مش موجود)
 * ------------------------------------------------------------------ */

function videoSourcePath() {
  if (config.stream.videoPath && fs.existsSync(config.stream.videoPath)) {
    return config.stream.videoPath;
  }
  return config.stream.dummyPath;
}

function ensureDummyVideo(force = false) {
  const target = config.stream.dummyPath;

  if (!force && fs.existsSync(target)) {
    const st = fs.statSync(target);
    if (st.size > 1024) return Promise.resolve({ created: false, path: target, size: st.size });
  }

  const bin = resolveFfmpeg();
  const { width, height, fps } = config.stream;

  // testsrc2 = صورة متحركة (مش سوداء) + ساعة/نص عشان يبان إنه شير حقيقي
  const args = [
    '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '20',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    target,
  ];

  logger.info('streamer: generating dummy video ->', target);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`));
      }
      const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
      logger.info('streamer: dummy video ready', `${Math.round(size / 1024)} KB`);
      resolve({ created: true, path: target, size });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 3) عملية ffmpeg بتقرأ الفيديو في لوب وتطلع stdout
 * ------------------------------------------------------------------ */

function spawnLoopingVideo(options = {}) {
  const bin = resolveFfmpeg();
  const src = videoSourcePath();
  const { width, height, fps, bitrate } = config.stream;

  if (!fs.existsSync(src)) {
    throw new Error(`video source not found: ${src}`);
  }

  const args = [
    '-re',
    '-stream_loop', '-1',
    '-i', src,
    '-an',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-s', `${width}x${height}`,
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', bitrate,
    '-g', String(Math.max(1, fps)),
    '-f', 'matroska',
    'pipe:1',
  ];

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.on('data', (d) => {
    if (config.debug) logger.debug('ffmpeg:', d.toString().trim().slice(0, 300));
  });
  child.on('error', (e) => logger.error('ffmpeg process error:', e.message));

  logger.info('streamer: ffmpeg pipeline started', path.basename(src));
  return child;
}

/* ------------------------------------------------------------------ *
 * 4) جلسة بث واحدة (Voice + Stream connection)
 * ------------------------------------------------------------------ */

/**
 * كشف ديناميكي لواجهة البث.
 * discord.js-selfbot-v13 عدّت منها أكتر من شكل عبر الإصدارات،
 * فبدل ما نكسر، بنجرب الأشكال المعروفة بالترتيب.
 */
function detectStreamApi(connection) {
  const candidates = [];

  if (typeof connection.createStreamConnection === 'function') {
    candidates.push({ kind: 'createStreamConnection', fn: () => connection.createStreamConnection() });
  }
  if (typeof connection.createStream === 'function') {
    candidates.push({ kind: 'createStream', fn: () => connection.createStream() });
  }
  if (connection.streamConnection) {
    candidates.push({ kind: 'streamConnection-prop', fn: () => connection.streamConnection });
  }

  return candidates;
}

function detectPlayMethod(streamConnection) {
  if (!streamConnection) return null;
  const names = ['playStream', 'play', 'sendVideo', 'sendStream', 'streamVideo'];
  for (const name of names) {
    if (typeof streamConnection[name] === 'function') return name;
  }
  return null;
}

class StreamSession {
  constructor(account) {
    this.account = account;
    this.connection = null;
    this.streamConnection = null;
    this.ffmpeg = null;
    this.active = false;
    this.startedAt = null;
    this.lastError = null;
    this.playMethod = null;
    this.watchdog = null;
  }

  status() {
    return {
      active: this.active,
      startedAt: this.startedAt,
      durationSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      playMethod: this.playMethod,
      ffmpegAlive: Boolean(this.ffmpeg && !this.ffmpeg.killed),
    };
  }

  async start(connection) {
    if (this.active) return this.status();

    this.connection = connection;
    this.lastError = null;

    const candidates = detectStreamApi(connection);
    if (!candidates.length) {
      throw new Error(
        'Voice connection does not expose a stream API. ' +
        'تأكد إن discord.js-selfbot-v13 متثبت وإصداره حديث.',
      );
    }

    let lastErr = null;
    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        this.streamConnection = await candidate.fn();
        logger.info(`streamer[${this.account.label}]: stream API =`, candidate.kind);
        break;
      } catch (e) {
        lastErr = e;
        logger.warn(`streamer[${this.account.label}]: ${candidate.kind} failed ->`, e.message);
      }
    }

    if (!this.streamConnection) {
      throw new Error(`failed to open stream connection: ${lastErr ? lastErr.message : 'unknown'}`);
    }

    this.playMethod = detectPlayMethod(this.streamConnection);
    if (!this.playMethod) {
      logger.warn(
        `streamer[${this.account.label}]: no known play method found on stream connection`,
        Object.getOwnPropertyNames(Object.getPrototypeOf(this.streamConnection)).join(','),
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await ensureDummyVideo();

    this.ffmpeg = spawnLoopingVideo();

    this.ffmpeg.on('close', (code) => {
      if (this.active) {
        logger.warn(`streamer[${this.account.label}]: ffmpeg closed (${code})`);
      }
    });

    if (this.playMethod) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.streamConnection[this.playMethod](this.ffmpeg.stdout, {
          type: 'video',
          fps: config.stream.fps,
          width: config.stream.width,
          height: config.stream.height,
        });
      } catch (e) {
        // بعض الإصدارات بترجع Promise وبعضها لأ — منكسرش لو رمى
        logger.warn(`streamer[${this.account.label}]: play call warning ->`, e.message);
      }
    }

    this.active = true;
    this.startedAt = Date.now();

    // watchdog: لو ffmpeg مات، نعيد التشغيل مرة واحدة
    this.watchdog = setInterval(() => {
      if (!this.active) return;
      if (!this.ffmpeg || this.ffmpeg.killed) {
        logger.warn(`streamer[${this.account.label}]: ffmpeg dead, restarting`);
        try {
          this.ffmpeg = spawnLoopingVideo();
          if (this.playMethod && this.streamConnection) {
            this.streamConnection[this.playMethod](this.ffmpeg.stdout, { type: 'video' }).catch(() => {});
          }
        } catch (e) {
          this.lastError = e.message;
        }
      }
    }, 15000);

    if (this.watchdog.unref) this.watchdog.unref();

    logger.info(`streamer[${this.account.label}]: streaming started`);
    return this.status();
  }

  async stop() {
    this.active = false;

    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }

    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGKILL'); } catch (_) { /* ignore */ }
      this.ffmpeg = null;
    }

    if (this.streamConnection) {
      try {
        if (typeof this.streamConnection.stop === 'function') await this.streamConnection.stop();
        else if (typeof this.streamConnection.destroy === 'function') this.streamConnection.destroy();
      } catch (_) { /* ignore */ }
      this.streamConnection = null;
    }

    this.startedAt = null;
    logger.info(`streamer[${this.account.label}]: streaming stopped`);
    return this.status();
  }
}

module.exports = {
  StreamSession,
  ensureDummyVideo,
  ffmpegVersion,
  resolveFfmpeg,
  videoSourcePath,
};