// routes/education.js
//
// Mount in app.js like this:
//
//   const educationRoutes = require("./routes/education")(pool, cloudinary);
//   app.use("/api", educationRoutes);
//
// Same pattern as routes/projects.js and routes/experience.js: category
// table + item table, each with its own `position`, fractional-index
// insertion via insertBeforeId, and the item's image uploaded straight to
// Cloudinary from this file.
//
// Endpoints exposed (all mounted under /api):
//   GET    /education                          -> { categories: [...] }
//   POST   /education-categories                -> create a category
//   PATCH  /education-categories/:id            -> rename a category
//   DELETE /education-categories/:id            -> delete a category (cascades its educations)
//   POST   /educations                          -> create an education entry
//   PATCH  /educations/:id                      -> edit institutionName/qualification/subjects/score/startDate/endDate/scoreCardUrl
//   DELETE /educations/:id                      -> delete an education entry
//   POST   /educations/:id/image (multipart)    -> upload/replace the institution logo/image via Cloudinary
//
// Schema note: `educations.start_date` and `educations.end_date` are DATE
// columns (end_date nullable, meaning "ongoing"). The old free-text `year`
// column has been dropped in favor of these two.

const express = require("express");
const multer = require("multer");

module.exports = function educationRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  });

  // ---- Cloudinary cleanup helpers (same pattern as routes/projects.js /
  // routes/experience.js) ----
  // secure_urls look like:
  //   https://res.cloudinary.com/<cloud>/image/upload/v169.../portfolio/education/abc123.jpg
  // The public_id is embedded in the path, so no separate DB column is needed
  // to know what to destroy on Cloudinary.
  function parseCloudinaryAsset(url) {
    if (!url) return null;
    const match = url.match(/\/image\/upload\/(?:v\d+\/)?([^.]+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
    if (!match) return null;
    return { resourceType: "image", publicId: match[1] };
  }

  async function deleteCloudinaryAsset(url) {
    const parsed = parseCloudinaryAsset(url);
    if (!parsed) return; // no url, or not a recognisable Cloudinary url — nothing to clean up
    try {
      await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.resourceType });
    } catch (err) {
      console.error("[deleteCloudinaryAsset] failed to destroy asset:", parsed, err);
      // Best-effort only — an orphaned Cloudinary asset is better than
      // blocking the delete/replace request that's already committed in the DB.
    }
  }

  // Same fractional-position helper as routes/projects.js / routes/experience.js.
  // Duplicated here rather than shared so this route file stays self-contained.
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

    if (prevRows.length === 0) {
      return targetPos - 1;
    }
    return (Number(prevRows[0].position) + targetPos) / 2;
  }

  function groupByCategory(categories, educations) {
    return categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      educations: educations.filter((e) => e.category_id === cat.id),
    }));
  }

  const EDUCATION_RETURNING = `
    id, category_id, institution_name AS "institutionName",
    qualification, image_url AS image, subjects, score,
    start_date AS "startDate", end_date AS "endDate",
    score_card_url AS "scoreCardUrl"
  `;

  /* =================== READ =================== */

  router.get("/education", async (req, res) => {
    try {
      const categoriesResult = await pool.query(
        `SELECT id, label FROM education_categories ORDER BY position ASC;`
      );
      const educationsResult = await pool.query(
        `SELECT ${EDUCATION_RETURNING} FROM educations ORDER BY position ASC;`
      );
      const categories = groupByCategory(categoriesResult.rows, educationsResult.rows);
      res.json({ categories });
    } catch (err) {
      console.error("[GET /education] ERROR:", err);
      res.status(500).json({ error: "Failed to fetch education" });
    }
  });

  /* =================== CATEGORIES =================== */

  router.post("/education-categories", async (req, res) => {
    const { label, insertBeforeId = null } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "education_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO education_categories (label, position) VALUES ($1, $2) RETURNING id, label;`,
        [label.trim(), position]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...rows[0], educations: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[POST /education-categories] ERROR:", err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create category" });
    } finally {
      client.release();
    }
  });

  router.patch("/education-categories/:id", async (req, res) => {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE education_categories SET label = $1 WHERE id = $2 RETURNING id, label;`,
        [label.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /education-categories/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  router.delete("/education-categories/:id", async (req, res) => {
    // NOTE: assumes educations.category_id has ON DELETE CASCADE — same
    // assumption the original route made by not deleting child education
    // rows itself. If that's not the case in your schema, deleting a
    // category that still has educations in it will fail with a FK
    // violation before it ever gets here.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Grab every education entry's image URL in this category BEFORE the
      // cascade wipes those rows out, so we know what to clean up on
      // Cloudinary afterwards.
      const { rows: educationRows } = await client.query(
        `SELECT image_url FROM educations WHERE category_id = $1;`,
        [req.params.id]
      );

      const { rowCount } = await client.query(
        `DELETE FROM education_categories WHERE id = $1;`,
        [req.params.id]
      );

      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Category not found" });
      }

      await client.query("COMMIT");

      // Best-effort Cloudinary cleanup, only after the DB change is safely committed.
      for (const { image_url } of educationRows) {
        await deleteCloudinaryAsset(image_url);
      }

      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[DELETE /education-categories/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to delete category" });
    } finally {
      client.release();
    }
  });

  /* =================== EDUCATIONS =================== */

  // Create an education entry. body:
  //   { categoryId, institutionName, qualification?, subjects?, score?,
  //     startDate?, endDate?, scoreCardUrl?, imageUrl?, insertBeforeId? }
  // startDate/endDate are expected as "YYYY-MM-DD" strings (or null for
  // endDate to mean "ongoing").
  router.post("/educations", async (req, res) => {
    const {
      categoryId,
      institutionName,
      qualification = "",
      subjects = [],
      score = "",
      startDate = null,
      endDate = null,
      scoreCardUrl = null,
      imageUrl = null,
      insertBeforeId = null,
    } = req.body;

    if (!categoryId || !institutionName || !institutionName.trim()) {
      return res.status(400).json({ error: "categoryId and institutionName are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "educations",
        scopeColumn: "category_id",
        scopeValue: categoryId,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO educations
           (category_id, institution_name, qualification, subjects, score, start_date, end_date, score_card_url, image_url, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${EDUCATION_RETURNING};`,
        [
          categoryId,
          institutionName.trim(),
          qualification,
          subjects,
          score,
          startDate || null,
          endDate || null,
          scoreCardUrl,
          imageUrl,
          position,
        ]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[POST /educations] ERROR:", err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create education entry" });
    } finally {
      client.release();
    }
  });

  // Partial update. body: any subset of
  //   { institutionName, qualification, subjects, score, startDate, endDate, scoreCardUrl }
  // Image is intentionally NOT editable here — use POST /educations/:id/image.
  const PATCHABLE_FIELDS = {
    institutionName: "institution_name",
    qualification: "qualification",
    subjects: "subjects",
    score: "score",
    startDate: "start_date",
    endDate: "end_date",
    scoreCardUrl: "score_card_url",
  };

  router.patch("/educations/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // Normalize empty-string dates to null so Postgres doesn't choke on ''::date
    const normalizedBody = { ...req.body };
    if ("startDate" in normalizedBody && normalizedBody.startDate === "") normalizedBody.startDate = null;
    if ("endDate" in normalizedBody && normalizedBody.endDate === "") normalizedBody.endDate = null;

    const setClauses = updates.map((key, i) => `${PATCHABLE_FIELDS[key]} = $${i + 1}`);
    const values = updates.map((key) => normalizedBody[key]);
    values.push(req.params.id);

    try {
      const { rows } = await pool.query(
        `UPDATE educations SET ${setClauses.join(", ")} WHERE id = $${values.length}
         RETURNING ${EDUCATION_RETURNING};`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Education entry not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /educations/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to update education entry" });
    }
  });

  router.delete("/educations/:id", async (req, res) => {
    try {
      // RETURNING image_url so we know what to clean up on Cloudinary
      // without a separate SELECT round-trip.
      const { rows } = await pool.query(
        `DELETE FROM educations WHERE id = $1 RETURNING image_url;`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Education entry not found" });

      // Best-effort — the education row is already gone either way.
      await deleteCloudinaryAsset(rows[0].image_url);

      res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE /educations/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to delete education entry" });
    }
  });

  // Upload/replace an education entry's image. multipart/form-data, field name: "image"
  router.post("/educations/:id/image", upload.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded (field name must be 'image')" });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    try {
      // Look up what's currently attached BEFORE we upload the replacement,
      // so we know what to delete from Cloudinary once the new one is safely saved.
      const { rows: existingRows } = await pool.query(
        `SELECT image_url FROM educations WHERE id = $1;`,
        [req.params.id]
      );
      if (existingRows.length === 0) {
        return res.status(404).json({ error: "Education entry not found" });
      }
      const oldUrl = existingRows[0].image_url;

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const uploadResult = await cloudinary.uploader.upload(dataUri, {
        folder: "portfolio/education",
        resource_type: "image",
      });

      const { rows } = await pool.query(
        `UPDATE educations SET image_url = $1 WHERE id = $2 RETURNING id, image_url AS image;`,
        [uploadResult.secure_url, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Education entry not found" });

      // Only now — new asset is uploaded AND saved to the DB — remove the
      // old one. If this were reversed and the upload/DB step failed, we'd
      // have deleted the working asset for nothing.
      if (oldUrl && oldUrl !== uploadResult.secure_url) {
        await deleteCloudinaryAsset(oldUrl);
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("[POST /educations/:id/image] ERROR:", err);
      res.status(500).json({ error: "Failed to upload image" });
    }
  });

  return router;
};