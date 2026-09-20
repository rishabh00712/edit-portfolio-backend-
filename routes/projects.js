// routes/projects.js
// Supports videoUrl and documentUrl on BOTH:
//   - POST  /projects       (first-time add)
//   - PATCH /projects/:id   (edit later)
// Errors are logged to the server console so failures show up in Render logs.

const express = require("express");
const multer = require("multer");

module.exports = function projectRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
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
      console.error("[deleteCloudinaryAsset] failed:", parsed, err.message);
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

  function groupByCategory(categories, projects) {
    return categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      projects: projects.filter((p) => p.category_id === cat.id),
    }));
  }

  const PROJECT_RETURNING = `
    id, category_id, name, image_url AS image,
    short_description AS "shortDescription", description,
    tech_stack AS "techStack", why,
    live_url AS "liveUrl", github_url AS "githubUrl",
    video_url AS "videoUrl", document_url AS "documentUrl"
  `;

  /* =================== READ =================== */

  router.get("/projects", async (req, res) => {
    try {
      const categoriesResult = await pool.query(
        `SELECT id, label FROM project_categories ORDER BY position ASC;`
      );
      const projectsResult = await pool.query(
        `SELECT ${PROJECT_RETURNING} FROM projects ORDER BY position ASC;`
      );
      const categories = groupByCategory(categoriesResult.rows, projectsResult.rows);
      res.json({ categories });
    } catch (err) {
      console.error("[GET /projects] ERROR:", err.message, err.code);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  /* =================== CATEGORIES =================== */

  router.post("/project-categories", async (req, res) => {
    const { label, insertBeforeId = null } = req.body;

    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const position = await computePosition(client, {
        table: "project_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });

      const { rows } = await client.query(
        `INSERT INTO project_categories (label, position) VALUES ($1, $2) RETURNING id, label;`,
        [label.trim(), position]
      );

      await client.query("COMMIT");
      res.status(201).json({ ...rows[0], projects: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[POST /project-categories] ERROR:", err.message, err.code, err.detail);
      res.status(err.status || 500).json({
        error: err.message || "Failed to create category",
        code: err.code,
        detail: err.detail,
      });
    } finally {
      client.release();
    }
  });

  router.patch("/project-categories/:id", async (req, res) => {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE project_categories SET label = $1 WHERE id = $2 RETURNING id, label;`,
        [label.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /project-categories/:id] ERROR:", err.message, err.code);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  router.delete("/project-categories/:id", async (req, res) => {
    // Assumes projects.category_id has ON DELETE CASCADE.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Grab every project's image URL BEFORE the cascade removes the rows,
      // so we know what to clean up on Cloudinary afterwards.
      const { rows: projectRows } = await client.query(
        `SELECT image_url FROM projects WHERE category_id = $1;`,
        [req.params.id]
      );

      const { rowCount } = await client.query(
        `DELETE FROM project_categories WHERE id = $1;`,
        [req.params.id]
      );

      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Category not found" });
      }

      await client.query("COMMIT");

      for (const { image_url } of projectRows) {
        await deleteCloudinaryAsset(image_url);
      }

      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[DELETE /project-categories/:id] ERROR:", err.message, err.code);
      res.status(500).json({ error: "Failed to delete category" });
    } finally {
      client.release();
    }
  });

  /* =================== PROJECTS =================== */

  // ---- ADD (first time): stores videoUrl + documentUrl ----
  router.post("/projects", async (req, res) => {
    const {
      categoryId,
      name,
      shortDescription = "",
      description = "",
      techStack = [],
      why = "",
      liveUrl = null,
      githubUrl = null,
      videoUrl = null,
      documentUrl = null,
      imageUrl = null,
      insertBeforeId = null,
    } = req.body;

    if (!categoryId || !name || !name.trim()) {
      return res.status(400).json({ error: "categoryId and name are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const position = await computePosition(client, {
        table: "projects",
        scopeColumn: "category_id",
        scopeValue: categoryId,
        insertBeforeId,
      });

      const { rows } = await client.query(
        `INSERT INTO projects
           (category_id, name, short_description, description, tech_stack, why,
            live_url, github_url, video_url, document_url, image_url, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${PROJECT_RETURNING};`,
        [
          categoryId,
          name.trim(),
          shortDescription,
          description,
          techStack,
          why,
          cleanUrl(liveUrl),
          cleanUrl(githubUrl),
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
      console.error("[POST /projects] ERROR:", err.message, err.code, err.detail);
      res.status(err.status || 500).json({
        error: err.message || "Failed to create project",
        code: err.code,
        detail: err.detail,
      });
    } finally {
      client.release();
    }
  });

  // ---- EDIT: only the fields present in the request body are updated ----
  const PATCHABLE_FIELDS = {
    name: "name",
    shortDescription: "short_description",
    description: "description",
    techStack: "tech_stack",
    why: "why",
    liveUrl: "live_url",
    githubUrl: "github_url",
    videoUrl: "video_url",
    documentUrl: "document_url",
  };

  const URL_FIELDS = ["liveUrl", "githubUrl", "videoUrl", "documentUrl"];

  router.patch("/projects/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({
        error: "No valid fields to update",
        received: Object.keys(req.body),
        allowed: Object.keys(PATCHABLE_FIELDS),
      });
    }

    const setClauses = updates.map((key, i) => `${PATCHABLE_FIELDS[key]} = $${i + 1}`);
    const values = updates.map((key) =>
      URL_FIELDS.includes(key) ? cleanUrl(req.body[key]) : req.body[key]
    );
    values.push(req.params.id);

    try {
      const { rows } = await pool.query(
        `UPDATE projects SET ${setClauses.join(", ")} WHERE id = $${values.length}
         RETURNING ${PROJECT_RETURNING};`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Project not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /projects/:id] ERROR:", err.message, err.code, err.detail);
      res.status(500).json({ error: "Failed to update project", detail: err.message });
    }
  });

  router.delete("/projects/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM projects WHERE id = $1 RETURNING image_url;`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Project not found" });

      await deleteCloudinaryAsset(rows[0].image_url);

      res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE /projects/:id] ERROR:", err.message, err.code);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  // Image upload (Cloudinary). Video and document are plain external links,
  // so they don't need any upload or cleanup.
  router.post("/projects/:id/image", upload.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name must be 'image')" });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    try {
      const { rows: existingRows } = await pool.query(
        `SELECT image_url FROM projects WHERE id = $1;`,
        [req.params.id]
      );
      if (existingRows.length === 0) {
        return res.status(404).json({ error: "Project not found" });
      }
      const oldUrl = existingRows[0].image_url;

      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const uploadResult = await cloudinary.uploader.upload(dataUri, {
        folder: "portfolio/projects",
        resource_type: "image",
      });

      const { rows } = await pool.query(
        `UPDATE projects SET image_url = $1 WHERE id = $2 RETURNING id, image_url AS image;`,
        [uploadResult.secure_url, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Project not found" });

      // Remove the old asset only after the new one is uploaded AND saved.
      if (oldUrl && oldUrl !== uploadResult.secure_url) {
        await deleteCloudinaryAsset(oldUrl);
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("[POST /projects/:id/image] ERROR:", err.message);
      res.status(500).json({ error: "Failed to upload image" });
    }
  });

  return router;
};