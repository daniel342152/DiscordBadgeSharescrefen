'use strict';

const path = require('path');
const fs = require('fs');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

function toInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(name, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function absPath(value, fallback) {
  const v = (value || '').trim();
  if (!v) return fallback;
  return path.isAbsolute(v) ? v : path.resolve(ROOT, v);
}

const config = {
  root: ROOT,
  port: toInt('PORT', 3000),
  panelPassword: (process.env.PANEL_PASSWORD || '').trim(),
  maxAccounts: toInt('MAX_ACCOUNTS', 4),
  joinCooldownMs: toInt('JOIN_COOLDOWN_MS', 8000),
  persistTokens: toBool('PERSIST_TOKENS', false),
  dataDir: absPath(process.env.DATA_DIR, path.join(ROOT, 'data')),
  debug: toBool('DEBUG', false),
  ffmpegPath: (process.env.FFMPEG_PATH || '').trim(),
  stream: {
    fps: toInt('STREAM_FPS', 30),
    width: toInt('STREAM_WIDTH', 1280),
    height: toInt('STREAM_HEIGHT', 720),
    bitrate: (process.env.STREAM_BITRATE || '1500k').trim(),
    videoPath: absPath(process.env.STREAM_VIDEO_PATH, ''),
    dummyPath: path.join(ROOT, 'assets', 'dummy.mp4'),
  },
};

// تأكد إن مجلدات التشغيل موجودة
for (const dir of [config.dataDir, path.join(ROOT, 'assets'), path.join(ROOT, 'logs')]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
}

module.exports = config;