// app.js
//
// Entrypoint. Everything in one place:
//   - shared Postgres pool from db/pool.js (retries at start-up AND per query)
//   - Cloudinary config
//   - owner login: password + email OTP reset (Brevo), session stored in the
//     database for 10 days, browser only holds a random session id cookie
//   - keep-alive ping so Render's free plan doesn't sleep
//   - each section's routes from routes/*.js, all under /api
//
//   routes/header.js    -> name, tagline, roles, socials, photos, work
//   routes/about.js     -> about summary / extracurricular / about info
//   routes/projects.js  -> project categories + projects
//   ...and the rest below.

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;

const pool = require("./db/pool"); // has pool.connectWithRetry()

const app = express();

// Matches the frontend's BACKEND_URL in src/components/apiConfig.js.
// On Render, PORT is set automatically.
const PORT = process.env.PORT || 5000;

/* ======================================================================
   Config
   ====================================================================== */

const IS_PROD = process.env.NODE_ENV === "production";

const OWNER_EMAIL = (process.env.OWNER_EMAIL || process.env.owner_email || "")
  .trim()
  .toLowerCase();

if (!OWNER_EMAIL) throw new Error("OWNER_EMAIL is missing in .env");
if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is missing in .env");

// One or more frontend addresses, comma separated, no trailing slash:
//   FRONTEND_URL=https://rishabheditportfolio.vercel.app
const FRONTEND_URLS = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Where the login page sends you after a successful login
const AFTER_LOGIN_URL = (process.env.AFTER_LOGIN_URL || FRONTEND_URLS[0]).trim();

const COOKIE_NAME = "sid";
const SESSION_DAYS = 10;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000; // OTP valid 10 minutes
const OTP_RESEND_MS = 60 * 1000; // 60s between OTP emails
const MAX_OTP_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

// Behind Render's proxy: real client IP for rate limiting
if (IS_PROD) app.set("trust proxy", 1);

/* ======================================================================
   1) DATABASE RETRY
   ====================================================================== */

// A stray rejected promise should be logged, not crash the whole server.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (server kept running):", reason);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Errors that mean "the connection failed", not "your SQL is wrong".
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01", // admin shutdown (Neon suspending)
  "57P02", // crash shutdown
  "57P03", // cannot connect now (database waking up)
  "08000",
  "08003",
  "08006",
]);

function isTransient(err) {
  if (err && TRANSIENT_CODES.has(err.code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|connection error|terminating connection/i.test(
    (err && err.message) || ""
  );
}

// Wrap pool.query so every route file gets automatic retries without any
// change in those files. Up to 3 tries, waiting 0.5s then 1s between them.
// Connection-level errors only; SQL errors (bad query, duplicate key...) are
// thrown straight away. pool.connect() (transactions) is not wrapped.
const rawQuery = pool.query.bind(pool);
const MAX_QUERY_TRIES = 3;

pool.query = async (...args) => {
  if (typeof args[args.length - 1] === "function") return rawQuery(...args); // callback style

  for (let attempt = 1; ; attempt++) {
    try {
      return await rawQuery(...args);
    } catch (err) {
      if (!isTransient(err) || attempt >= MAX_QUERY_TRIES) throw err;
      console.warn(
        `DB query failed (${err.code || err.message}). Retry ${attempt}/${MAX_QUERY_TRIES - 1}...`
      );
      await sleep(500 * attempt);
    }
  }
};

/* ======================================================================
   Middleware
   ====================================================================== */

// credentials:true lets the browser send the session cookie from the frontend.
// Only the addresses in FRONTEND_URL are allowed.
app.use(
  cors({
    origin: (origin, callback) => {
      // no Origin header = same-origin page, curl, health checks -> allow
      if (!origin || FRONTEND_URLS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Cloudinary — credentials from .env:
//   MY_CLOUD_NAME=eowextnp
//   MY_API=535691859461367
//   SECRET=<the real secret, not the placeholder>
cloudinary.config({
  cloud_name: process.env.MY_CLOUD_NAME,
  api_key: process.env.MY_API,
  api_secret: process.env.SECRET,
});

/* ======================================================================
   Auth helpers
   ====================================================================== */

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

// OTPs are stored only as an HMAC, never in plain text
const hashOtp = (otp) =>
  crypto.createHmac("sha256", process.env.AUTH_SECRET).update(otp).digest("hex");

// Frontend (vercel.app) and backend (onrender.com) are different sites, so in
// production the cookie must be SameSite=None + Secure or the browser won't
// send it on the frontend's requests. Locally (same site) "lax" is fine.
const cookieOptions = () => ({
  httpOnly: true, // browser JavaScript can't read it
  sameSite: IS_PROD ? "none" : "lax",
  secure: IS_PROD, // HTTPS only in production
  path: "/",
});

const maskEmail = (email) => {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  return `${name[0]}${"*".repeat(Math.max(name.length - 1, 2))}@${domain}`;
};

// The cookie holds only a random session id. The real session (and its
// 10-day expiry) lives in the owner_sessions table.
async function findSession(req) {
  const sid = req.cookies && req.cookies[COOKIE_NAME];
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;

  const { rows } = await pool.query(
    "SELECT id FROM owner_sessions WHERE token_hash = $1 AND expires_at > NOW()",
    [sha256(sid)]
  );
  return rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    if (await findSession(req)) return next();
    return res.status(401).json({ error: "Login required." });
  } catch (err) {
    console.error(err);
    return res.status(503).json({ error: "Service unavailable. Try again." });
  }
}

async function endSession(req, res) {
  const sid = req.cookies && req.cookies[COOKIE_NAME];
  if (sid) {
    await pool.query("DELETE FROM owner_sessions WHERE token_hash = $1", [sha256(sid)]);
  }
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

// Brevo transactional email (Node 18+ has global fetch).
// Only MY_OWN_API_KEY is required in .env. The "from" address defaults to
// OWNER_EMAIL, which must be a sender/email you have verified in Brevo.
// If Brevo rejects it, set MY_OWN_EMAIL to a verified sender.
// Brevo transactional email (Node 18+ has global fetch).
// Only MY_OWN_API_KEY is required in .env. The "from" address defaults to
// OWNER_EMAIL, which must be a sender/email you have verified in Brevo.
// If Brevo rejects it, set MY_OWN_EMAIL to a verified sender.
async function sendOtpEmail(to, otp) {
  if (!process.env.MY_OWN_API_KEY) {
    console.error("[OTP] FAILED - MY_OWN_API_KEY is missing in the environment variables.");
    throw new Error("MY_OWN_API_KEY is missing");
  }

  const from = process.env.MY_OWN_EMAIL;
  console.log(`OTP Sending reset code to ${maskEmail(to)} (from ${from})...`);

  let res;
  try {
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.MY_OWN_API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: {
          name: process.env.BREVO_SENDER_NAME || "Portfolio Admin",
          email: from,
        },
        to: [{ email: to }],
        subject: "Your password reset code",
        htmlContent: `
          <div style="font-family:Arial,sans-serif;max-width:420px">
            <p>Use this code to reset your admin password:</p>
            <p style="font-size:32px;letter-spacing:6px;font-weight:bold;margin:16px 0">${otp}</p>
            <p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>
          </div>`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(`[OTP] FAILED - could not reach Brevo: ${err.message}`);
    throw err;
  }

  const raw = await res.text();

  if (!res.ok) {
    console.error(`[OTP] FAILED - Brevo answered ${res.status}: ${raw}`);
    throw new Error(`Brevo error ${res.status}: ${raw}`);
  }

  let messageId = "n/a";
  try {
    messageId = JSON.parse(raw).messageId || "n/a";
  } catch {
    /* response was not JSON, ignore */
  }
  console.log(`[OTP] SENT OK to ${maskEmail(to)} (Brevo messageId: ${messageId}).`);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again in 15 minutes." },
});

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

/* ======================================================================
   Auth routes
   ====================================================================== */

// Login page (views/login.ejs)
app.get("/login", async (req, res) => {
  try {
    if (await findSession(req)) return res.redirect(AFTER_LOGIN_URL);
  } catch (err) {
    console.error(err);
  }
  res.render("login", { email: OWNER_EMAIL, maskedEmail: maskEmail(OWNER_EMAIL) });
});

// Password login -> creates a session row (10 days) + sets the sid cookie
app.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const password = String(req.body.password || "");
    if (!password) return res.status(400).json({ error: "Enter your password." });

    const { rows } = await pool.query("SELECT password_hash FROM owner_auth WHERE id = 1");
    const hash = rows[0] && rows[0].password_hash;
    if (!hash) {
      return res.status(400).json({
        error: "No password is set yet. Use “Forgot password” to create one.",
      });
    }

    if (!(await bcrypt.compare(password, hash))) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    const sid = crypto.randomBytes(32).toString("hex");
    await pool.query("DELETE FROM owner_sessions WHERE expires_at <= NOW()");
    await pool.query(
      `INSERT INTO owner_sessions (token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [
        sha256(sid),
        new Date(Date.now() + SESSION_MS),
        req.ip,
        (req.get("user-agent") || "").slice(0, 255),
      ]
    );

    res.cookie(COOKIE_NAME, sid, { ...cookieOptions(), maxAge: SESSION_MS });
    res.json({ ok: true, redirect: AFTER_LOGIN_URL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// Forgot password -> emails a 6-digit OTP to OWNER_EMAIL
app.post("/auth/forgot", otpLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT otp_sent_at FROM owner_auth WHERE id = 1");
    const sentAt = rows[0] && rows[0].otp_sent_at;
    if (sentAt) {
      const wait = OTP_RESEND_MS - (Date.now() - new Date(sentAt).getTime());
      if (wait > 0) {
        return res.status(429).json({
          error: `Wait ${Math.ceil(wait / 1000)}s before asking for another code.`,
        });
      }
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    await pool.query(
      `UPDATE owner_auth
          SET otp_hash = $1,
              otp_expires_at = $2,
              otp_attempts = 0,
              otp_sent_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
      [hashOtp(otp), new Date(Date.now() + OTP_TTL_MS)]
    );

    await sendOtpEmail(OWNER_EMAIL, otp);
    res.json({ ok: true, message: `Code sent to ${maskEmail(OWNER_EMAIL)}.` });
  } catch (err) {
    console.error(err); // the Brevo reason shows up here in Render's logs
    res.status(500).json({ error: "Could not send the code. Check your Brevo settings." });
  }
});

// Verify OTP + save new password (also logs out every session)
app.post("/auth/reset", otpLimiter, async (req, res) => {
  try {
    const otp = String(req.body.otp || "").trim();
    const newPassword = String(req.body.newPassword || "");

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Enter the 6-digit code." });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    const { rows } = await pool.query("SELECT * FROM owner_auth WHERE id = 1");
    const row = rows[0];
    if (!row || !row.otp_hash || !row.otp_expires_at) {
      return res.status(400).json({ error: "Request a new code first." });
    }
    if (new Date(row.otp_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "That code has expired. Request a new one." });
    }
    if (row.otp_attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ error: "Too many wrong codes. Request a new one." });
    }

    // Count the attempt before comparing so guesses can't be raced
    await pool.query("UPDATE owner_auth SET otp_attempts = otp_attempts + 1 WHERE id = 1");

    const given = Buffer.from(hashOtp(otp));
    const stored = Buffer.from(row.otp_hash);
    const match = given.length === stored.length && crypto.timingSafeEqual(given, stored);
    if (!match) return res.status(400).json({ error: "Wrong code." });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE owner_auth
          SET password_hash = $1,
              otp_hash = NULL,
              otp_expires_at = NULL,
              otp_attempts = 0,
              otp_sent_at = NULL,
              updated_at = NOW()
        WHERE id = 1`,
      [passwordHash]
    );
    await pool.query("DELETE FROM owner_sessions"); // password changed -> log out everywhere

    res.json({ ok: true, message: "Password saved. Log in with it now." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// For the React app: is the current browser logged in?
app.get("/auth/me", async (req, res) => {
  try {
    res.json({ loggedIn: Boolean(await findSession(req)) });
  } catch (err) {
    console.error(err);
    res.status(503).json({ loggedIn: false });
  }
});

// Logout (link/page) and logout (fetch from React)
app.get("/logout", async (req, res) => {
  try {
    await endSession(req, res);
  } catch (err) {
    console.error(err);
  }
  res.redirect("/login");
});

app.post("/auth/logout", async (req, res) => {
  try {
    await endSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not log out." });
  }
});

/* ======================================================================
   Protect writes on /api
   ====================================================================== */

// Anyone can read (GET). Every POST/PUT/PATCH/DELETE needs a valid session,
// except the ones listed here (the public contact form).
const PUBLIC_WRITES = [{ method: "POST", path: "/contact" }];

app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (PUBLIC_WRITES.some((r) => r.method === req.method && r.path === req.path)) {
    return next();
  }
  return requireAuth(req, res, next);
});

/* ======================================================================
   Section routes (all under /api)
   ====================================================================== */

const headerRoutes = require("./routes/header")(pool, cloudinary);
app.use("/api", headerRoutes);

const aboutRoutes = require("./routes/about")(pool);
app.use("/api", aboutRoutes);

const projectRoutes = require("./routes/projects")(pool, cloudinary);
app.use("/api", projectRoutes);

const experienceRoutes = require("./routes/experience")(pool, cloudinary);
app.use("/api", experienceRoutes);

const educationRoutes = require("./routes/education")(pool, cloudinary);
app.use("/api", educationRoutes);

const certificatesRoutes = require("./routes/certificates")(pool, cloudinary);
app.use("/api", certificatesRoutes);

const achievementsRoutes = require("./routes/achievements")(pool, cloudinary);
app.use("/api", achievementsRoutes);

const resumeRoutes = require("./routes/resume")(pool, cloudinary);
app.use("/api", resumeRoutes);

const contactRoutes = require("./routes/contact")(pool);
app.use("/api", contactRoutes);

const skillRoutes = require("./routes/skill")(pool);
app.use("/api", skillRoutes);

/* ---------------- Health ---------------- */

// Does not touch the database on purpose, so the keep-alive ping never
// wakes (or fails because of) Neon. `db` just reports the last known state.
let dbReady = false;
app.get("/api/health", (req, res) => res.json({ ok: true, db: dbReady }));

// Catches multer errors (bad file type, file too large, etc.) so they
// come back as JSON instead of an unhandled stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Something went wrong" });
});

/* ======================================================================
   2) KEEP-ALIVE (Render free plan sleeps after ~15 min without traffic)
   ====================================================================== */

// Render sets RENDER_EXTERNAL_URL automatically (https://your-app.onrender.com).
// Locally it is empty, so the keep-alive stays off. You can also set
// KEEP_ALIVE_URL yourself in the environment variables.
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
const KEEP_ALIVE_EVERY_MS = 5 * 60 * 1000; // 5 minutes

function startKeepAlive() {
  if (!KEEP_ALIVE_URL) {
    console.log("Keep-alive is off (no RENDER_EXTERNAL_URL / KEEP_ALIVE_URL).");
    return;
  }

  const url = `${KEEP_ALIVE_URL.replace(/\/$/, "")}/api/health`;

  const ping = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) console.warn(`Keep-alive ping returned ${res.status}`);
    } catch (err) {
      console.warn("Keep-alive ping failed:", err.message);
    }
  };

  setInterval(ping, KEEP_ALIVE_EVERY_MS).unref();
  console.log(`Keep-alive on: pinging ${url} every 5 minutes.`);
}

/* ======================================================================
   Start
   ====================================================================== */

// Listen first so Render sees the port open and the health check passes,
// then connect to the database in the background (retries until Neon answers).
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  startKeepAlive();

  pool
    .connectWithRetry()
    .then(() => {
      dbReady = true;
    })
    .catch((err) => console.error("connectWithRetry stopped:", err.message));

  // Remove expired sessions once an hour
  setInterval(() => {
    pool
      .query("DELETE FROM owner_sessions WHERE expires_at <= NOW()")
      .catch((err) => console.error("Session cleanup failed:", err.message));
  }, 60 * 60 * 1000).unref();
});