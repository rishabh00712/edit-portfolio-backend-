// app.js
//
// Thin entrypoint. Uses the shared Postgres pool from db/pool.js and sets up
// Cloudinary, then mounts each section's routes from its own file:
//   routes/header.js    -> name, tagline, roles, socials, photos, work
//   routes/about.js     -> about summary / extracurricular / about info
//   routes/projects.js  -> project categories + projects
//
// Extras in this file:
//   1) Database retry  -> keeps trying to connect at start-up, and retries a
//                         query if the connection drops (Neon wake-up, etc.)
//   2) Keep-alive      -> pings this service every 5 minutes so Render's
//                         free plan doesn't put it to sleep

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;

const pool = require("./db/pool"); // has pool.connectWithRetry()

const app = express();

// Matches the frontend's hardcoded BACKEND_URL = "http://localhost:5000"
// in Header.jsx / Projects.jsx / etc. Change both together if you ever
// need a different port.
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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
   Routes (all under /api)
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

/* ---------------- Start ---------------- */

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
});