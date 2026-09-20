// routes/experience.js
//
// Mount in app.js like this:
//
//   const experienceRoutes = require("./routes/experience")(pool, cloudinary);
//   app.use("/api", experienceRoutes);
//
// Endpoints exposed (all mounted under /api):
//   GET    /experience                          -> { categories: [...] }
//   POST   /experience-categories                -> create a category
//   PATCH  /experience-categories/:id            -> rename a category
//   DELETE /experience-categories/:id            -> delete a category (cascades its experiences)
//   POST   /experiences                          -> create an experience entry
//   PATCH  /experiences/:id                      -> edit companyName/role/description/dates/techStack/
//                                                   certificateUrl/videoUrl/documentUrl
//   DELETE /experiences/:id                      -> delete an experience entry
//   POST   /experiences/:id/image (multipart)    -> upload/replace the company logo/image via Cloudinary
//
// videoUrl and documentUrl are plain external links (YouTube, Google Drive, ...),
// saved on BOTH the first add (POST) and later edits (PATCH).

const express = require("express");
const multer = require("multer");

module.exports = function experienceRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  });

  // ---- Cloudinary cleanup helpers ----
  function parseCloudinaryAsset(url) {
    if (!url) return null;
    const match = url.match(/\/image\/upload\/(?:v\d+\/)?([^.]+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
    if (!match) return null;
    return { resourceType: "image", publicId: match[1] };
  }

  async function deleteCloudinaryAsset(url) {
    const parsed = parseCloudinaryAsset(url);
    if (!parsed) return;
    try {
      await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.resourceType });
    } catch (err) {
      // Best-effort only: an orphaned Cloudinary asset is better than
      // blocking a request that is already committed in the DB.
      console.error("[deleteCloudinaryAsset] failed to destroy asset:", parsed, err.message);
    }
  }

  // Turns "" or whitespace-only strings into null, trims everything else.
  // Used for every link field so a cleared input is stored as NULL.
  function cleanUrl(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }

  async function computePosition(client, { table, scopeColumn, scopeValue, insertBeforeId }) {
    const hasScope = Boolean(scopeColumn);

    if (insertBeforeId === null || insertBeforeId === undefined) {
      const sql = hasScope
        ? `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table} WHERE ${scopeColumn} = $1;`
        : `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table};`;
      const params = hasScope ? [scopeValue] : [];
      const { rows } = await client.query(sql, params);
      return Number(rows[0].pos);
    }

    const targetSql = hasScope
      ? `SELECT position FROM ${table} WHERE ${scopeColumn} = $1 AND id = $2;`
      : `SELECT position FROM ${table} WHERE id = $1;`;
    const targetParams = hasScope ? [scopeValue, insertBeforeId] : [insertBeforeId];
    const { rows: targetRows } = await client.query(targetSql, targetParams);

    if (targetRows.length === 0) {
      const err = new Error("insertBeforeId does not exist in this scope");
      err.status = 400;
      throw err;
    }
    const targetPos = Number(targetRows[0].position);

    const prevSql = hasScope
      ? `SELECT position FROM ${table} WHERE ${scopeColumn} = $1 AND position < $2 ORDER BY position DESC LIMIT 1;`
      : `SELECT position FROM ${table} WHERE position < $1 ORDER BY position DESC LIMIT 1;`;
    const prevParams = hasScope ? [scopeValue, targetPos] : [targetPos];
    const { rows: prevRows } = await client.query(prevSql, prevParams);

    if (prevRows.length === 0) return targetPos - 1;
    return (Number(prevRows[0].position) + targetPos) / 2;
  }

  // Computes a human-readable duration ("1 yr 3 mos", "6 mos") from
  // start_date/end_date. Runs server-side whenever either date changes.
  function calculateDuration(startDate, endDate) {
    if (!startDate) return "";
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date();

    let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (end.getDate() < start.getDate()) months -= 1;
    if (months < 0) months = 0;

    const years = Math.floor(months / 12);
    const remMonths = months % 12;

    const parts = [];
    if (years > 0) parts.push(`${years} yr${years !== 1 ? "s" : ""}`);
    if (remMonths > 0 || years === 0) parts.push(`${remMonths} mo${remMonths !== 1 ? "s" : ""}`);
    return parts.join(" ");
  }

  function groupByCategory(categories, experiences) {
    return categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      experiences: experiences.filter((e) => e.category_id === cat.id),
    }));
  }

  const EXPERIENCE_RETURNING = `
    id, category_id, company_name AS "companyName", role,
    image_url AS image, description,
    start_date AS "startDate", end_date AS "endDate", duration,
    tech_stack AS "techStack", certificate_url AS "certificateUrl",
    video_url AS "videoUrl", document_url AS "documentUrl"
  `;

  /* =================== READ =================== */

  router.get("/experience", async (req, res) => {
    try {
      const categoriesResult = await pool.query(
        `SELECT id, label FROM experience_categories ORDER BY position ASC;`
      );
      const experiencesResult = await pool.query(
        `SELECT ${EXPERIENCE_RETURNING} FROM experiences ORDER BY position ASC;`
      );
      const categories = groupByCategory(categoriesResult.rows, experiencesResult.rows);
      res.json({ categories });
    } catch (err) {
      console.error("[GET /experience] ERROR:", err);
      res.status(500).json({ error: "Failed to fetch experience" });
    }
  });

  /* =================== CATEGORIES =================== */

  router.post("/experience-categories", async (req, res) => {
    const { label, insertBeforeId = null } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "experience_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO experience_categories (label, position) VALUES ($1, $2) RETURNING id, label;`,
        [label.trim(), position]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...rows[0], experiences: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[POST /experience-categories] ERROR:", err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create category" });
    } finally {
      client.release();
    }
  });

  router.patch("/experience-categories/:id", async (req, res) => {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE experience_categories SET label = $1 WHERE id = $2 RETURNING id, label;`,
        [label.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /experience-categories/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  router.delete("/experience-categories/:id", async (req, res) => {
    // Assumes experiences.category_id has ON DELETE CASCADE.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Grab every experience's image URL BEFORE the cascade removes the
      // rows, so we know what to clean up on Cloudinary afterwards.
      const { rows: experienceRows } = await client.query(
        `SELECT image_url FROM experiences WHERE category_id = $1;`,
        [req.params.id]
      );

      const { rowCount } = await client.query(
        `DELETE FROM experience_categories WHERE id = $1;`,
        [req.params.id]
      );

      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Category not found" });
      }

      await client.query("COMMIT");

      for (const { image_url } of experienceRows) {
        await deleteCloudinaryAsset(image_url);
      }

      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[DELETE /experience-categories/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to delete category" });
    } finally {
      client.release();
    }
  });

  /* =================== EXPERIENCES =================== */

  // ---- ADD (first time): stores videoUrl + documentUrl ----
  // body: { categoryId, companyName, role, description?, startDate?, endDate?,
  //         techStack?, certificateUrl?, videoUrl?, documentUrl?, imageUrl?, insertBeforeId? }
  router.post("/experiences", async (req, res) => {
    const {
      categoryId,
      companyName,
      role,
      description = "",
      startDate = null,
      endDate = null,
      techStack = [],
      certificateUrl = null,
      videoUrl = null,
      documentUrl = null,
      imageUrl = null,
      insertBeforeId = null,
    } = req.body;

    if (!categoryId || !companyName || !companyName.trim() || !role || !role.trim()) {
      return res.status(400).json({ error: "categoryId, companyName and role are required" });
    }

    const duration = calculateDuration(startDate, endDate);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "experiences",
        scopeColumn: "category_id",
        scopeValue: categoryId,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO experiences
           (category_id, company_name, role, description, start_date, end_date, duration,
            tech_stack, certificate_url, video_url, document_url, image_url, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${EXPERIENCE_RETURNING};`,
        [
          categoryId,
          companyName.trim(),
          role.trim(),
          description,
          startDate,
          endDate,
          duration,
          techStack,
          cleanUrl(certificateUrl),
          cleanUrl(videoUrl),
          cleanUrl(documentUrl),
          imageUrl,
          position,
        ]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[POST /experiences] ERROR:", err.message, err.code, err.detail);
      res.status(err.status || 500).json({
        error: err.message || "Failed to create experience",
        code: err.code,
        detail: err.detail,
      });
    } finally {
      client.release();
    }
  });

  // ---- EDIT: only the fields present in the request body are updated ----
  // duration is not directly editable: startDate/endDate are the source of
  // truth, and changing either recomputes duration here. If only one date is
  // sent, the other is read from the existing row first.
  const PATCHABLE_FIELDS = {
    companyName: "company_name",
    role: "role",
    description: "description",
    startDate: "start_date",
    endDate: "end_date",
    techStack: "tech_stack",
    certificateUrl: "certificate_url",
    videoUrl: "video_url",
    documentUrl: "document_url",
  };

  const URL_FIELDS = ["certificateUrl", "videoUrl", "documentUrl"];

  router.patch("/experiences/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({
        error: "No valid fields to update",
        received: Object.keys(req.body),
        allowed: Object.keys(PATCHABLE_FIELDS),
      });
    }

    const client = await pool.connect();
    try {
      const touchesDates = updates.includes("startDate") || updates.includes("endDate");
      let finalUpdates = updates;
      let body = req.body;

      if (touchesDates) {
        const { rows: existingRows } = await client.query(
          `SELECT start_date AS "startDate", end_date AS "endDate" FROM experiences WHERE id = $1;`,
          [req.params.id]
        );
        if (existingRows.length === 0) return res.status(404).json({ error: "Experience not found" });

        const startDate = updates.includes("startDate") ? req.body.startDate : existingRows[0].startDate;
        const endDate = updates.includes("endDate") ? req.body.endDate : existingRows[0].endDate;
        body = { ...req.body, duration: calculateDuration(startDate, endDate) };
        finalUpdates = [...new Set([...updates, "duration"])];
      }

      const setClauses = finalUpdates.map(
        (key, i) => `${key === "duration" ? "duration" : PATCHABLE_FIELDS[key]} = $${i + 1}`
      );
      const values = finalUpdates.map((key) =>
        URL_FIELDS.includes(key) ? cleanUrl(body[key]) : body[key]
      );
      values.push(req.params.id);

      const { rows } = await client.query(
        `UPDATE experiences SET ${setClauses.join(", ")} WHERE id = $${values.length}
         RETURNING ${EXPERIENCE_RETURNING};`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Experience not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /experiences/:id] ERROR:", err.message, err.code, err.detail);
      res.status(500).json({ error: "Failed to update experience", detail: err.message });
    } finally {
      client.release();
    }
  });

  router.delete("/experiences/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM experiences WHERE id = $1 RETURNING image_url;`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Experience not found" });

      await deleteCloudinaryAsset(rows[0].image_url);

      res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE /experiences/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to delete experience" });
    }
  });

  // Upload/replace an experience entry's image. multipart/form-data, field name: "image"
  router.post("/experiences/:id/image", upload.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded (field name must be 'image')" });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    try {
      const { rows: existingRows } = await pool.query(
        `SELECT image_url FROM experiences WHERE id = $1;`,
        [req.params.id]
      );
      if (existingRows.length === 0) {
        return res.status(404).json({ error: "Experience not found" });
      }
      const oldUrl = existingRows[0].image_url;

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const uploadResult = await cloudinary.uploader.upload(dataUri, {
        folder: "portfolio/experience",
        resource_type: "image",
      });

      const { rows } = await pool.query(
        `UPDATE experiences SET image_url = $1 WHERE id = $2 RETURNING id, image_url AS image;`,
        [uploadResult.secure_url, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Experience not found" });

      // Remove the old asset only after the new one is uploaded AND saved.
      if (oldUrl && oldUrl !== uploadResult.secure_url) {
        await deleteCloudinaryAsset(oldUrl);
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("[POST /experiences/:id/image] ERROR:", err);
      res.status(500).json({ error: "Failed to upload image" });
    }
  });

  return router;
};