// routes/achievements.js
//
// Mount in app.js like this:
//
//   const achievementRoutes = require("./routes/achievements")(pool);
//   app.use("/api", achievementRoutes);
//
// No Cloudinary dependency here — the achievements schema has no image
// column, so unlike projects/certificates this router only needs `pool`.
//
// Endpoints exposed (all mounted under /api):
//   GET    /achievements                         -> { categories: [...] }
//   POST   /achievement-categories                -> create a category, anywhere in the order
//   PATCH  /achievement-categories/:id             -> rename a category
//   DELETE /achievement-categories/:id             -> delete a category (cascades its achievements)
//   POST   /achievements                           -> create an achievement, anywhere within its category
//   PATCH  /achievements/:id                       -> edit title/description/link
//   DELETE /achievements/:id                       -> delete an achievement

const express = require("express");

module.exports = function achievementRoutes(pool) {
  const router = express.Router();

  // ---------------------------------------------------------------
  // Same "where does this new row's position go" helper used by
  // projects.js / certificates.js:
  //   - insertBeforeId == null  -> append at the end (MAX + 1)
  //   - insertBeforeId given    -> midpoint between that row and the
  //                                row immediately before it (or
  //                                MIN - 1 if it's currently first)
  // `scopeColumn` lets this serve both:
  //   - achievement_categories (no scope — global order)
  //   - achievements           (scoped by category_id — order within a category)
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

  // Groups a flat achievements array under their parent category, in the
  // same order the categories came back in (already ORDER BY position).
  function groupByCategory(categories, achievements) {
    return categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      achievements: achievements.filter((a) => a.category_id === cat.id),
    }));
  }

  const ACHIEVEMENT_RETURNING = `id, category_id, title, description, link`;

  /* =================== READ =================== */

  router.get("/achievements", async (req, res) => {
    try {
      const categoriesResult = await pool.query(
        `SELECT id, label FROM achievement_categories ORDER BY position ASC;`
      );
      const achievementsResult = await pool.query(
        `SELECT ${ACHIEVEMENT_RETURNING} FROM achievements ORDER BY position ASC;`
      );
      const categories = groupByCategory(categoriesResult.rows, achievementsResult.rows);
      res.json({ categories });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch achievements" });
    }
  });

  /* =================== CATEGORIES =================== */

  // Create a category. body: { label, insertBeforeId? }
  router.post("/achievement-categories", async (req, res) => {
    const { label, insertBeforeId = null } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "achievement_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO achievement_categories (label, position) VALUES ($1, $2) RETURNING id, label;`,
        [label.trim(), position]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...rows[0], achievements: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create category" });
    } finally {
      client.release();
    }
  });

  // Rename a category. body: { label }
  router.patch("/achievement-categories/:id", async (req, res) => {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE achievement_categories SET label = $1 WHERE id = $2 RETURNING id, label;`,
        [label.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  // Delete a category. ON DELETE CASCADE on achievements.category_id takes care of its achievements.
  router.delete("/achievement-categories/:id", async (req, res) => {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM achievement_categories WHERE id = $1;`,
        [req.params.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: "Category not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete category" });
    }
  });

  /* =================== ACHIEVEMENTS =================== */

  // Create an achievement. body: { categoryId, title, description?, link?, insertBeforeId? }
  router.post("/achievements", async (req, res) => {
    const {
      categoryId,
      title,
      description = "",
      link = null,
      insertBeforeId = null,
    } = req.body;

    if (!categoryId || !title || !title.trim()) {
      return res.status(400).json({ error: "categoryId and title are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "achievements",
        scopeColumn: "category_id",
        scopeValue: categoryId,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO achievements (category_id, title, description, link, position)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ACHIEVEMENT_RETURNING};`,
        [categoryId, title.trim(), description, link, position]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create achievement" });
    } finally {
      client.release();
    }
  });

  // Partial update. body: any subset of { title, description, link }
  const PATCHABLE_FIELDS = {
    title: "title",
    description: "description",
    link: "link",
  };

  router.patch("/achievements/:id", async (req, res) => {
    const updates = Object.keys(req.body).filter((key) => key in PATCHABLE_FIELDS);
    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const setClauses = updates.map((key, i) => `${PATCHABLE_FIELDS[key]} = $${i + 1}`);
    const values = updates.map((key) => req.body[key]);
    values.push(req.params.id);

    try {
      const { rows } = await pool.query(
        `UPDATE achievements SET ${setClauses.join(", ")} WHERE id = $${values.length}
         RETURNING ${ACHIEVEMENT_RETURNING};`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Achievement not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update achievement" });
    }
  });

  router.delete("/achievements/:id", async (req, res) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM achievements WHERE id = $1;`, [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: "Achievement not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete achievement" });
    }
  });

  return router;
};