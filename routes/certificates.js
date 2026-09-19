// routes/certificates.js
//
// Mount in app.js like this (same pattern as projects.js):
//
//   const certificateRoutes = require("./routes/certificates")(pool, cloudinary);
//   app.use("/api", certificateRoutes);
//
// Endpoints exposed (all mounted under /api):
//   GET    /certificates                         -> { categories: [...] }
//   POST   /certificate-categories                -> create a category, anywhere in the order
//   PATCH  /certificate-categories/:id             -> rename a category
//   DELETE /certificate-categories/:id             -> delete a category (cascades its certificates)
//   POST   /certificates                           -> create a certificate, anywhere within its category
//                                                      (optionally with an imageUrl, same as projects)
//   PATCH  /certificates/:id                       -> edit certificateName/organization/description/
//                                                      issuedDate/skills/certificateUrl
//   DELETE /certificates/:id                       -> delete a certificate
//   POST   /certificates/:id/image (multipart)     -> upload/replace the certificate image via Cloudinary

const express = require("express");
const multer = require("multer");

module.exports = function certificateRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  });

  // ---- Cloudinary cleanup helpers (same pattern as routes/projects.js /
  // routes/experience.js / routes/education.js) ----
  // secure_urls look like:
  //   https://res.cloudinary.com/<cloud>/image/upload/v169.../portfolio/certificates/abc123.jpg
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

  // ---------------------------------------------------------------
  // Same "where does this new row's position go" helper as projects.js:
  //   - insertBeforeId == null  -> append at the end (MAX + 1)
  //   - insertBeforeId given    -> midpoint between that row and the
  //                                row immediately before it (or
  //                                MIN - 1 if it's currently first)
  // `scopeColumn` lets this serve both:
  //   - certificate_categories (no scope — global order)
  //   - certificates           (scoped by category_id — order within a category)
  // ---------------------------------------------------------------
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
      return targetPos - 1; // target was first in its scope -> new row becomes first
    }
    return (Number(prevRows[0].position) + targetPos) / 2;
  }

  // Groups a flat certificates array under their parent category, in the
  // same order the categories came back in (already ORDER BY position).
  function groupByCategory(categories, certificates) {
    return categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      certificates: certificates.filter((c) => c.category_id === cat.id),
    }));
  }

  const CERTIFICATE_RETURNING = `
    id, category_id, certificate_name AS "certificateName",
    organization, image_url AS image, description,
    issued_date AS "issuedDate", skills,
    certificate_url AS "certificateUrl"
  `;

  /* =================== READ =================== */

  router.get("/certificates", async (req, res) => {
    try {
      const categoriesResult = await pool.query(
        `SELECT id, label FROM certificate_categories ORDER BY position ASC;`
      );
      const certificatesResult = await pool.query(
        `SELECT ${CERTIFICATE_RETURNING} FROM certificates ORDER BY position ASC;`
      );
      const categories = groupByCategory(categoriesResult.rows, certificatesResult.rows);
      res.json({ categories });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch certificates" });
    }
  });

  /* =================== CATEGORIES =================== */

  // Create a category. body: { label, insertBeforeId? }
  router.post("/certificate-categories", async (req, res) => {
    const { label, insertBeforeId = null } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "certificate_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO certificate_categories (label, position) VALUES ($1, $2) RETURNING id, label;`,
        [label.trim(), position]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...rows[0], certificates: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create category" });
    } finally {
      client.release();
    }
  });

  // Rename a category. body: { label }
  router.patch("/certificate-categories/:id", async (req, res) => {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE certificate_categories SET label = $1 WHERE id = $2 RETURNING id, label;`,
        [label.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  // Delete a category. ON DELETE CASCADE on certificates.category_id takes
  // care of the DB rows for its certificates — but the cascade doesn't know
  // about Cloudinary, so we grab their image URLs first and clean those up
  // ourselves after the delete commits.
  router.delete("/certificate-categories/:id", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: certificateRows } = await client.query(
        `SELECT image_url FROM certificates WHERE category_id = $1;`,
        [req.params.id]
      );

      const { rowCount } = await client.query(
        `DELETE FROM certificate_categories WHERE id = $1;`,
        [req.params.id]
      );

      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Category not found" });
      }

      await client.query("COMMIT");

      // Best-effort Cloudinary cleanup, only after the DB change is safely committed.
      for (const { image_url } of certificateRows) {
        await deleteCloudinaryAsset(image_url);
      }

      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ error: "Failed to delete category" });
    } finally {
      client.release();
    }
  });

  /* =================== CERTIFICATES =================== */

  // Create a certificate. body:
  //   { categoryId, certificateName, organization?, description?, issuedDate?,
  //     skills?, certificateUrl?, imageUrl?, insertBeforeId? }
  // imageUrl (optional) is the Cloudinary URL already returned by POST /api/upload —
  // upload the file first, then pass the resulting URL here so the certificate
  // has its image from the moment it's created.
  router.post("/certificates", async (req, res) => {
    const {
      categoryId,
      certificateName,
      organization = "",
      description = "",
      issuedDate = "",
      skills = [],
      certificateUrl = null,
      imageUrl = null,
      insertBeforeId = null,
    } = req.body;

    if (!categoryId || !certificateName || !certificateName.trim()) {
      return res.status(400).json({ error: "categoryId and certificateName are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "certificates",
        scopeColumn: "category_id",
        scopeValue: categoryId,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO certificates
           (category_id, certificate_name, organization, description, issued_date, skills, certificate_url, image_url, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${CERTIFICATE_RETURNING};`,
        [categoryId, certificateName.trim(), organization, description, issuedDate, skills, certificateUrl, imageUrl, position]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create certificate" });
    } finally {
      client.release();
    }
  });

  // Partial update. body: any subset of
  //   { certificateName, organization, description, issuedDate, skills, certificateUrl }
  // Image is intentionally NOT editable here — use POST /certificates/:id/image instead.
  const PATCHABLE_FIELDS = {
    certificateName: "certificate_name",
    organization: "organization",
    description: "description",
    issuedDate: "issued_date",
    skills: "skills",
    certificateUrl: "certificate_url",
  };

  router.patch("/certificates/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const setClauses = updates.map((key, i) => `${PATCHABLE_FIELDS[key]} = $${i + 1}`);
    const values = updates.map((key) => req.body[key]);
    values.push(req.params.id);

    try {
      const { rows } = await pool.query(
        `UPDATE certificates SET ${setClauses.join(", ")} WHERE id = $${values.length}
         RETURNING ${CERTIFICATE_RETURNING};`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Certificate not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update certificate" });
    }
  });

  router.delete("/certificates/:id", async (req, res) => {
    try {
      // RETURNING image_url so we know what to clean up on Cloudinary
      // without a separate SELECT round-trip.
      const { rows } = await pool.query(
        `DELETE FROM certificates WHERE id = $1 RETURNING image_url;`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Certificate not found" });

      // Best-effort — the certificate row is already gone either way.
      await deleteCloudinaryAsset(rows[0].image_url);

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete certificate" });
    }
  });

  // Upload/replace a certificate's image via Cloudinary.
  // multipart/form-data, field name: "image"
  router.post("/certificates/:id/image", upload.single("image"), async (req, res) => {
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
        `SELECT image_url FROM certificates WHERE id = $1;`,
        [req.params.id]
      );
      if (existingRows.length === 0) {
        return res.status(404).json({ error: "Certificate not found" });
      }
      const oldUrl = existingRows[0].image_url;

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const uploadResult = await cloudinary.uploader.upload(dataUri, {
        folder: "portfolio/certificates",
        resource_type: "image",
      });

      const { rows } = await pool.query(
        `UPDATE certificates SET image_url = $1 WHERE id = $2 RETURNING id, image_url AS image;`,
        [uploadResult.secure_url, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Certificate not found" });

      // Only now — new asset is uploaded AND saved to the DB — remove the
      // old one. If this were reversed and the upload/DB step failed, we'd
      // have deleted the working asset for nothing.
      if (oldUrl && oldUrl !== uploadResult.secure_url) {
        await deleteCloudinaryAsset(oldUrl);
      }

      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to upload image" });
    }
  });

  return router;
};