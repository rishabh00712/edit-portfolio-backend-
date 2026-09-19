// app.js
//
// Thin entrypoint. Sets up the shared Postgres pool and Cloudinary config
// once, then mounts each section's routes from its own file:
//   routes/header.js    -> name, tagline, roles, socials, photos, work
//   routes/about.js     -> about summary / extracurricular / about info
//   routes/projects.js  -> project categories + projects
//
// Nothing else lives directly in this file anymore — no inline route
// handlers, no mailer. Each section's routes, including any Cloudinary
// upload logic specific to that section, live in their own routes/ file.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

const app = express();

// Matches the frontend's hardcoded BACKEND_URL = "http://localhost:5000"
// in Header.jsx / Projects.jsx / etc. Change both together if you ever
// need a different port.
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Single shared connection pool, read from .env -> DATABASE_URL
// (your Neon connection string, e.g. postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

// Cloudinary — credentials from .env:
//   MY_CLOUD_NAME=eowextnp
//   MY_API=535691859461367
//   SECRET=<the real secret, not the placeholder>
cloudinary.config({
  cloud_name: process.env.MY_CLOUD_NAME,
  api_key: process.env.MY_API,
  api_secret: process.env.SECRET,
});

// Mount each section's routes, all under /api
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Catches multer errors (bad file type, file too large, etc.) so they
// come back as JSON instead of an unhandled stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Something went wrong" });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});