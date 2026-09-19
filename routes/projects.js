// routes/projects.js — DEBUG VERSION
// Every step logs to the terminal so we can see exactly where it breaks.
// Once it's working, we can strip these back out.

const express = require("express");
const multer = require("multer");

module.exports = function projectRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  // ---- Cloudinary cleanup helpers ----
  // secure_urls look like:
  //   https://res.cloudinary.com/<cloud>/image/upload/v169.../portfolio/projects/abc123.jpg
  //   https://res.cloudinary.com/<cloud>/video/upload/v169.../portfolio/projects/abc123.mp4
  // resource_type (image/video) and public_id are both embedded in the path,
  // so we don't need a separate DB column to know what to destroy.
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
      // console.log("[deleteCloudinaryAsset] destroyed:", parsed);
    } catch (err) {
      // console.error("[deleteCloudinaryAsset] failed to destroy asset:", parsed, err);
      // Best-effort only — an orphaned Cloudinary asset is better than
      // blocking the delete/replace request that's already committed in the DB.
    }
  }

  async function computePosition(client, { table, scopeColumn, scopeValue, insertBeforeId }) {
    // console.log("[computePosition] called with:", { table, scopeColumn, scopeValue, insertBeforeId });
    const hasScope = Boolean(scopeColumn);

    if (insertBeforeId === null || insertBeforeId === undefined) {
      const sql = hasScope
        ? `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table} WHERE ${scopeColumn} = $1;`
        : `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table};`;
      const params = hasScope ? [scopeValue] : [];
      // console.log("[computePosition] append-at-end SQL:", sql, params);
      const { rows } = await client.query(sql, params);
      // console.log("[computePosition] append-at-end result:", rows);
      return Number(rows[0].pos);
    }

    const targetSql = hasScope
      ? `SELECT position FROM ${table} WHERE ${scopeColumn} = $1 AND id = $2;`
      : `SELECT position FROM ${table} WHERE id = $1;`;
    const targetParams = hasScope ? [scopeValue, insertBeforeId] : [insertBeforeId];
    // console.log("[computePosition] target SQL:", targetSql, targetParams);
    const { rows: targetRows } = await client.query(targetSql, targetParams);
    // console.log("[computePosition] target result:", targetRows);

    if (targetRows.length === 0) {
      const err = new Error("insertBeforeId does not exist in this scope");
      err.status = 400;
      // console.log("[computePosition] ERROR: insertBeforeId not found");
      throw err;
    }
    const targetPos = Number(targetRows[0].position);

    const prevSql = hasScope
      ? `SELECT position FROM ${table} WHERE ${scopeColumn} = $1 AND position < $2 ORDER BY position DESC LIMIT 1;`
      : `SELECT position FROM ${table} WHERE position < $1 ORDER BY position DESC LIMIT 1;`;
    const prevParams = hasScope ? [scopeValue, targetPos] : [targetPos];
    // console.log("[computePosition] prev SQL:", prevSql, prevParams);
    const { rows: prevRows } = await client.query(prevSql, prevParams);
    // console.log("[computePosition] prev result:", prevRows);

    if (prevRows.length === 0) {
      // console.log("[computePosition] target was first, new position =", targetPos - 1);
      return targetPos - 1;
    }
    const finalPos = (Number(prevRows[0].position) + targetPos) / 2;
    // console.log("[computePosition] midpoint position =", finalPos);
    return finalPos;
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
    live_url AS "liveUrl", github_url AS "githubUrl"
  `;

  /* =================== READ =================== */

  router.get("/projects", async (req, res) => {
    // console.log("[GET /projects] request received");
    try {
      const categoriesResult = await pool.query(
        `SELECT id, label FROM project_categories ORDER BY position ASC;`
      );
      // console.log("[GET /projects] categories:", categoriesResult.rows);
      const projectsResult = await pool.query(
        `SELECT ${PROJECT_RETURNING} FROM projects ORDER BY position ASC;`
      );
      // console.log("[GET /projects] projects count:", projectsResult.rows.length);
      const categories = groupByCategory(categoriesResult.rows, projectsResult.rows);
      res.json({ categories });
    } catch (err) {
      // console.error("[GET /projects] ERROR:", err);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  /* =================== CATEGORIES =================== */

  router.post("/project-categories", async (req, res) => {
    // console.log("[POST /project-categories] body received:", req.body);
    const { label, insertBeforeId = null } = req.body;

    if (!label || !label.trim()) {
      // console.log("[POST /project-categories] REJECTED: no label");
      return res.status(400).json({ error: "label is required" });
    }

    // console.log("[POST /project-categories] connecting to pool...");
    const client = await pool.connect();
    // console.log("[POST /project-categories] connected");

    try {
      // console.log("[POST /project-categories] BEGIN transaction");
      await client.query("BEGIN");

      // console.log("[POST /project-categories] computing position...");
      const position = await computePosition(client, {
        table: "project_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });
      // console.log("[POST /project-categories] position computed:", position);

      const insertSql = `INSERT INTO project_categories (label, position) VALUES ($1, $2) RETURNING id, label;`;
      // console.log("[POST /project-categories] running insert:", insertSql, [label.trim(), position]);
      const { rows } = await client.query(insertSql, [label.trim(), position]);
      // console.log("[POST /project-categories] insert result:", rows);

      await client.query("COMMIT");
      // console.log("[POST /project-categories] COMMIT successful");

      res.status(201).json({ ...rows[0], projects: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      // console.error("[POST /project-categories] ERROR — full details below:");
      // console.error("  message:", err.message);
      // console.error("  code:", err.code);       // Postgres error code, e.g. 23505 = unique violation
      // console.error("  detail:", err.detail);   // Postgres's human-readable detail line
      // console.error("  constraint:", err.constraint);
      // console.error("  stack:", err.stack);
      res.status(err.status || 500).json({
        error: err.message || "Failed to create category",
        code: err.code,
        detail: err.detail,
      });
    } finally {
      client.release();
      // console.log("[POST /project-categories] client released");
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
      // console.error(err);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  router.delete("/project-categories/:id", async (req, res) => {
    // NOTE: assumes projects.category_id has ON DELETE CASCADE — the
    // original route relied on the same assumption by not deleting child
    // project rows itself. If that's not the case in your schema, deleting
    // a category with projects still in it will fail with a FK violation
    // before it ever gets here.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Grab every project's image/video URL in this category BEFORE the
      // cascade wipes those rows out, so we know what to clean up on
      // Cloudinary afterwards.
      const { rows: projectRows } = await client.query(
        `SELECT image_url FROM projects WHERE category_id = $1;`,
        [req.params.id]
      );
      // console.log("[DELETE /project-categories/:id] assets to clean up:", projectRows);

      const { rowCount } = await client.query(
        `DELETE FROM project_categories WHERE id = $1;`,
        [req.params.id]
      );

      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Category not found" });
      }

      await client.query("COMMIT");

      // Best-effort Cloudinary cleanup, only after the DB change is safely committed.
      for (const { image_url } of projectRows) {
        await deleteCloudinaryAsset(image_url);
      }

      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK");
      // console.error(err);
      res.status(500).json({ error: "Failed to delete category" });
    } finally {
      client.release();
    }
  });

  /* =================== PROJECTS =================== */

  router.post("/projects", async (req, res) => {
    // console.log("[POST /projects] body received:", req.body);
    const {
      categoryId,
      name,
      shortDescription = "",
      description = "",
      techStack = [],
      why = "",
      liveUrl = null,
      githubUrl = null,
      imageUrl = null,
      insertBeforeId = null,
    } = req.body;

    if (!categoryId || !name || !name.trim()) {
      // console.log("[POST /projects] REJECTED: missing categoryId or name");
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
      // console.log("[POST /projects] position computed:", position);

      const { rows } = await client.query(
        `INSERT INTO projects
           (category_id, name, short_description, description, tech_stack, why, live_url, github_url, image_url, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${PROJECT_RETURNING};`,
        [categoryId, name.trim(), shortDescription, description, techStack, why, liveUrl, githubUrl, imageUrl, position]
      );
      // console.log("[POST /projects] insert result:", rows);

      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      // console.error("[POST /projects] ERROR — full details below:");
      // console.error("  message:", err.message);
      // console.error("  code:", err.code);
      // console.error("  detail:", err.detail);
      // console.error("  constraint:", err.constraint);
      // console.error("  stack:", err.stack);
      res.status(err.status || 500).json({
        error: err.message || "Failed to create project",
        code: err.code,
        detail: err.detail,
      });
    } finally {
      client.release();
    }
  });

  const PATCHABLE_FIELDS = {
    name: "name",
    shortDescription: "short_description",
    description: "description",
    techStack: "tech_stack",
    why: "why",
    liveUrl: "live_url",
    githubUrl: "github_url",
  };

  router.patch("/projects/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const setClauses = updates.map((key, i) => `${PATCHABLE_FIELDS[key]} = $${i + 1}`);
    const values = updates.map((key) => req.body[key]);
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
      // console.error(err);
      res.status(500).json({ error: "Failed to update project" });
    }
  });

  router.delete("/projects/:id", async (req, res) => {
    try {
      // RETURNING image_url so we know what to clean up on Cloudinary
      // without a separate SELECT round-trip.
      const { rows } = await pool.query(
        `DELETE FROM projects WHERE id = $1 RETURNING image_url;`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Project not found" });

      // Best-effort — the project row is already gone either way.
      await deleteCloudinaryAsset(rows[0].image_url);

      res.json({ ok: true });
    } catch (err) {
      // console.error(err);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  // Accepts images AND videos now (Cloudinary free-plan friendly — see the
  // multer limit above). resource_type: "auto" lets Cloudinary sort out
  // which one it is; we don't need to know ahead of time.
  router.post("/projects/:id/image", upload.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (field name must be 'image')" });
    }
       if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    try {
      // Look up what's currently attached BEFORE we upload the replacement,
      // so we know what to delete from Cloudinary once the new one is safely saved.
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

      // Only now — new asset is uploaded AND saved to the DB — remove the
      // old one. If this were reversed and the upload/DB step failed, we'd
      // have deleted the working asset for nothing.
      if (oldUrl && oldUrl !== uploadResult.secure_url) {
        await deleteCloudinaryAsset(oldUrl);
      }

      res.json(rows[0]);
    } catch (err) {
      // console.error(err);
      res.status(500).json({ error: "Failed to upload image" });
    }
  });

  return router;
};