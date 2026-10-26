# 🎥 Discord Stream AFK — Self-Hosted Control Panel

بوت self-bot على **حسابات ALT** بيدخل Voice Channel ويفتح **Screen Share** في لوب،
+ لوحة تحكم ويب بسيطة (عربي) تقدر منها:
- تضيف توكن الحساب وتفحصه وتعرض معلوماته
- تختار السيرفر والروم الصوتي وتدخل/تخرج
- تبدأ/توقف الشير سكرين
- تضيف حساب مشاهدة (Viewer) اختياري

---

## ⚠️ تحذير

استخدام user token للبوت مخالف لـ **Discord ToS** وممكن يؤدي لقفل الحساب.
المشروع ده **للتجربة على حسابات ALT فقط**. متحطش حسابك الأساسي أبداً.

---

## 🧱 الملفات

```
.
├── Dockerfile              # بيبني الصورة مع ffmpeg + tini
├── railway.json            # إعداد Railway
├── package.json
├── .env.example            # متغيرات البيئة
├── src/
│   ├── server.js           # Express + REST API + SSE logs
│   ├── accountManager.js   # إدارة الحسابات + login + join/leave/stream
│   ├── streamer.js         # ffmpeg pipeline + StreamSession
│   ├── rateLimiter.js      # KeyedLimiter + backoff
│   ├── config.js
│   └── logger.js
├── public/
│   └── index.html          # لوحة التحكم (RTL عربي)
└── assets/                 # dummy.mp4 يتولد تلقائي أول تشغيل
```

---

## 🚀 التشغيل المحلي

```bash
npm install
copy .env.example .env       # ويندوز
# أو: cp .env.example .env

# لازم يكون ffmpeg متثبت أو:
npm i ffmpeg-static

npm start
# → http://localhost:3000
```

---

## ☁️ النشر على Railway

1. اعمل repo على GitHub وارفع الملفات (من غير `node_modules` و `.env`).
2. New Project → Deploy from GitHub repo.
3. Railway هيلاقي `railway.json` ويبني من `Dockerfile` تلقائيًا.
4. **Variables** ضيف:
   - `PANEL_PASSWORD` = كلمة سر قوية (إجباري!)
   - `PERSIST_TOKENS` = `1` لو عايز التوكنات تفضل بعد الـ restart
     (هتتحفظ في `data/accounts.json` — استخدم Railway Volume عشان تفضل)
   - `MAX_ACCOUNTS` = 4 (افتراضي)
   - `JOIN_COOLDOWN_MS` = 8000 (حماية من rate limit)
   - `STREAM_FPS/STREAM_WIDTH/STREAM_HEIGHT/STREAM_BITRATE`
5. Deploy → افتح الدومين → هيسألك كلمة السر → خلاص.

---

## 🔐 حماية من الـ Rate Limit / Temporary Disable

الكود فيه طبقات حماية:

1. **KeyedLimiter** — طابور لكل حساب + cooldown 8 ثواني بين أي عمليتين صوت.
2. **منع التوازي** — لو فيه عملية شغالة على نفس الحساب، الطلب الجديد بيترفض.
3. **Backoff تصاعدي** — إعادة الاتصال التلقائي بـ 5s, 10s, 20s... لحد 2 دقيقة (5 محاولات كحد أقصى).
4. **رسائل أخطاء مفهومة** — `temporary disable`, `401`, `429`, `captcha` كلها بتترجم لعربي.
5. **`checkUpdate: false`, `patchVoice: true`** — تقليل الطلبات غير الضرورية.

---

## 🎬 طريقة عمل الـ Stream

1. `client.voice.joinChannel(channel)` → `VoiceConnection`.
2. `connection.createStreamConnection()` (أو `createStream()` حسب الإصدار) → قناة Stream.
3. `ffmpeg -re -stream_loop -1 -i assets/dummy.mp4 -f matroska pipe:1` → stdout.
4. الـ stdout بيتغذى للـ stream connection.
5. **Watchdog** كل 15 ثانية: لو ffmpeg مات بيرجّعه تلقائيًا.

الفيديو الـ dummy (testsrc2 متحرك + نغمة) بيتولد أول مرة تلقائيًا عبر ffmpeg.

لو عايز فيديو مخصص: حط المسار في `STREAM_VIDEO_PATH` أو استبدل `assets/dummy.mp4`.

---

## 🎨 الواجهة

- **RTL عربي** بالكامل
- **3 كروت**: إضافة Streamer، إضافة Viewer (اختياري)، وقائمة الحسابات
- كل حساب بيعرض: أفاتار، تاج، حالة (online/in-voice/streaming…)، مدة البث
- اختيار السيرفر والروم من **dropdowns** مبنية من guilds/channels الحقيقية للحساب
- أزرار: دخول الروم / خروج / ابدأ الشير / وقف الشير / مسح الحساب
- **لوجز مباشرة** عبر SSE

---

## 📡 API Reference

| Method | Path | الوظيفة |
|--------|------|---------|
| GET | `/api/health` | فحص عام + stats |
| POST | `/api/auth` | تحقق من كلمة السر |
| GET | `/api/accounts` | كل الحسابات |
| POST | `/api/accounts` | إضافة + فحص توكن |
| DELETE | `/api/accounts/:id` | مسح حساب |
| GET | `/api/accounts/:id/guilds` | سيرفرات الحساب |
| GET | `/api/accounts/:id/guilds/:gid/channels` | الرومات الصوتية |
| POST | `/api/accounts/:id/join` | دخول روم |
| POST | `/api/accounts/:id/leave` | خروج |
| POST | `/api/accounts/:id/stream/start` | بدء شير |
| POST | `/api/accounts/:id/stream/stop` | وقف شير |
| GET | `/api/system` | ffmpeg + config |
| GET | `/api/logs` | آخر لوجز |
| GET | `/api/logs/stream` | SSE logs |

كل `/api/*` (ما عدا health و auth) محتاجة هيدر `x-panel-key: <PANEL_PASSWORD>`
أو `?key=<PANEL_PASSWORD>` (للـ SSE).

---

## 🧪 استخراج التوكن

1. افتح Discord في **المتصفح** (مش التطبيق).
2. F12 → **Application** → **Local Storage** → `https://discord.com`.
3. دوّر على `token` وانسخ القيمة (من غير علامات تنصيص).
4. الصقها في اللوحة → **فحص وإضافة**.

> ⚠️ متشاركش التوكن مع أي حد. لو حسيت إنه اتسرب، غيّر كلمة سر الحساب فورًا (ده بيلغي كل التوكنات).

---

## 🐛 استكشاف الأخطاء

| المشكلة | الحل |
|---------|------|
| `ffmpeg not found` | `npm i ffmpeg-static` أو ثبّت ffmpeg في النظام |
| `Voice connection does not expose a stream API` | حدّث `discord.js-selfbot-v13` (`npm i discord.js-selfbot-v13@latest`) |
| `no known play method found` | الـ API اتغير — شوف اللوجز وافتح issue |
| الشير بيفتح بس محدش شايفه | تأكد إن الروم Voice (مش Stage)، والحساب عنده صلاحية |
| `Temporary disabled` | استنى ساعات (مش دقايق)، متعملش retry سريع |
| الحساب بيرجع disconnected كل شوية | فعّل `PERSIST_TOKENS=1` + Volume على Railway |