// routes/resume.js
//
// Mount in app.js like this:
//
//   const resumeRoutes = require("./routes/resume")(pool, cloudinary);
//   app.use("/api", resumeRoutes);
//
// IMPORTANT Cloudinary detail: this schema stores PDFs, not images. Cloudinary's
// default upload pipeline assumes an image, so PDFs must be uploaded with
// `resource_type: "raw"` — using the image default here would either fail or
// silently mangle the file. Every upload call below sets that explicitly.
//
// If a saved PDF won't open in the browser ("Failed to load PDF document"),
// that's very likely NOT a bug in this file — it's Cloudinary's account-level
// security setting that restricts unsigned delivery of raw PDF/ZIP files by
// default on newer accounts. Fix in the Cloudinary dashboard: Settings ->
// Security -> enable delivery of PDF/ZIP files over unsigned URLs. Confirm by
// opening the stored download_url directly and checking its HTTP status in
// DevTools — a 401 there points straight at that setting, not at this code.
//
// CLEANUP: destroying old Cloudinary files on replace/delete.
// The `resumes` table only stores `download_url`, not a Cloudinary public_id,
// so there's nothing to hand uploader.destroy() directly. Instead,
// `publicIdFromUrl()` below reconstructs it from the URL itself — Cloudinary
// raw URLs always look like `.../upload/v<version>/<public_id>`, so whatever
// comes after that version segment (decoded) IS the public_id. destroyOldFile()
// wraps that + the destroy call in a try/catch that only logs on failure —
// a failed cleanup should never block the user's actual replace/delete action
// from succeeding.
//
// Endpoints exposed (all mounted under /api):
//   GET    /resume                          -> { resumes: [...] }
//   POST   /resume                          -> create a resume entry, anywhere in the order
//                                               (optionally with downloadUrl+fileName already
//                                               obtained from POST /api/resume-upload)
//   PATCH  /resume/:id                      -> edit title/description
//   DELETE /resume/:id                      -> delete a resume entry (+ its Cloudinary file)
//   POST   /resume-upload (multipart)       -> upload a PDF to Cloudinary, get back
//                                               { url, fileName } to use when creating
//                                               or replacing a resume entry
//   POST   /resume/:id/file (multipart)     -> upload/replace a resume's PDF directly
//                                               (deletes the old Cloudinary file after
//                                               the new one is safely in place)

const express = require("express");
const multer = require("multer");

module.exports = function resumeRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — resumes are small, this is generous
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== "application/pdf") {
        return cb(new Error("Only PDF files are allowed"));
      }
      cb(null, true);
    },
  });

  function uploadPdfToCloudinary(buffer, originalName) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "portfolio/resumes",
          resource_type: "raw", // required for non-image files (PDFs, docs, etc.)
          public_id: originalName.replace(/\.pdf$/i, ""),
          format: "pdf",
        },
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
      stream.end(buffer);
    });
  }

  // Pull the Cloudinary public_id back out of a delivery URL. For raw
  // resources the public_id includes the extension, so this is just
  // "everything after /upload/v<version>/", decoded.
  function publicIdFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  // Best-effort delete of the old Cloudinary asset. Never throws — a failed
  // cleanup shouldn't block the replace/delete the user actually asked for;
  // it just gets logged so an orphaned file can be cleaned up manually later.
  async function destroyOldFile(url) {
    const publicId = publicIdFromUrl(url);
    if (!publicId) return;
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });
    } catch (err) {
      console.error(`Failed to delete old Cloudinary file (${publicId}):`, err);
    }
  }

  // ---------------------------------------------------------------
  // Same "where does this new row's position go" helper used by
  // projects.js / certificates.js / achievements.js. resumes has no
  // scope column (it's a flat list), so this always runs unscoped —
  // insertBeforeId == null appends at the end, otherwise the new row
  // slots in right before that id.
  // ---------------------------------------------------------------
  async function computePosition(client, insertBeforeId) {
    if (insertBeforeId === null || insertBeforeId === undefined) {
      const { rows } = await client.query(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM resumes;`);
      return Number(rows[0].pos);
    }

    const { rows: targetRows } = await client.query(`SELECT position FROM resumes WHERE id = $1;`, [insertBeforeId]);
    if (targetRows.length === 0) {
      const err = new Error("insertBeforeId does not exist");
      err.status = 400;
      throw err;
    }
    const targetPos = Number(targetRows[0].position);

    const { rows: prevRows } = await client.query(
      `SELECT position FROM resumes WHERE position < $1 ORDER BY position DESC LIMIT 1;`,
      [targetPos]
    );
    if (prevRows.length === 0) {
      return targetPos - 1; // target was first -> new row becomes first
    }
    return (Number(prevRows[0].position) + targetPos) / 2;
  }

  const RESUME_RETURNING = `id, title, description, file_name AS "fileName", download_url AS "downloadUrl"`;

  /* =================== READ =================== */

  router.get("/resume", async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT ${RESUME_RETURNING} FROM resumes ORDER BY position ASC;`);
      res.json({ resumes: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch resumes" });
    }
  });

  /* =================== STANDALONE PDF UPLOAD =================== */

  // Upload a PDF and get back its Cloudinary URL + original filename, without
  // creating a resume row yet. Mirrors the app.js /api/upload pattern used for
  // images, but for PDFs and with resource_type "raw".
  router.post("/resume-upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name must be 'file')" });
    }
    try {
      const result = await uploadPdfToCloudinary(req.file.buffer, req.file.originalname);
      res.json({ url: result.secure_url, fileName: req.file.originalname });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "PDF upload failed" });
    }
  });

  /* =================== RESUME ENTRIES =================== */

  // Create a resume entry. body:
  //   { title, description?, fileName, downloadUrl, insertBeforeId? }
  // fileName + downloadUrl are expected to already come from POST /resume-upload —
  // upload the PDF first, then create the entry with the resulting URL.
  router.post("/resume", async (req, res) => {
    const {
      title,
      description = "",
      fileName,
      downloadUrl,
      insertBeforeId = null,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    if (!fileName || !downloadUrl) {
      return res.status(400).json({ error: "fileName and downloadUrl are required — upload the PDF via /api/resume-upload first" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, insertBeforeId);
      const { rows } = await client.query(
        `INSERT INTO resumes (title, description, file_name, download_url, position)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${RESUME_RETURNING};`,
        [title.trim(), description, fileName, downloadUrl, position]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create resume entry" });
    } finally {
      client.release();
    }
  });

  // Partial update. body: any subset of { title, description }
  // File is intentionally NOT editable here — use POST /resume/:id/file instead.
  const PATCHABLE_FIELDS = {
    title: "title",
    description: "description",
  };

  router.patch("/resume/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const setClauses = updates.map((key, i) => `${PATCHABLE_FIELDS[key]} = $${i + 1}`);
    const values = updates.map((key) => req.body[key]);
    values.push(req.params.id);

    try {
      const { rows } = await pool.query(
        `UPDATE resumes SET ${setClauses.join(", ")} WHERE id = $${values.length}
         RETURNING ${RESUME_RETURNING};`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Resume entry not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update resume entry" });
    }
  });

  // Delete a resume entry AND its Cloudinary file. The DB row is the source
  // of truth for whether this succeeded, so it's deleted first; the Cloudinary
  // cleanup happens after and is best-effort (see destroyOldFile above).
  router.delete("/resume/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM resumes WHERE id = $1 RETURNING download_url;`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Resume entry not found" });

      await destroyOldFile(rows[0].download_url);

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete resume entry" });
    }
  });

  // Upload/replace a resume's PDF directly against an existing entry.
  // multipart/form-data, field name: "file". Order matters here: the new
  // file goes up and the DB row is updated FIRST, and only once that has
  // succeeded do we delete the old Cloudinary file — so a failed upload
  // never leaves the entry pointing at a file that no longer exists.
  router.post("/resume/:id/file", upload.single("file"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name must be 'file')" });
    }
    try {
      const existing = await pool.query(`SELECT download_url FROM resumes WHERE id = $1;`, [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "Resume entry not found" });
      const oldUrl = existing.rows[0].download_url;

      const result = await uploadPdfToCloudinary(req.file.buffer, req.file.originalname);
      const { rows } = await pool.query(
        `UPDATE resumes SET file_name = $1, download_url = $2 WHERE id = $3
         RETURNING ${RESUME_RETURNING};`,
        [req.file.originalname, result.secure_url, req.params.id]
      );

      // New file is confirmed saved — safe to clean up the old one now.
      await destroyOldFile(oldUrl);

      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to upload PDF" });
    }
  });

  return router;
};