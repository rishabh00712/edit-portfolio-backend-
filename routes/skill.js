// routes/skills.js
//
// Mount in app.js like this:
//
//   const skillRoutes = require("./routes/skills")(pool);
//   app.use("/api", skillRoutes);
//
// Remove the old inline app.get("/api/skills", ...) from app.js — this
// replaces it (and changes its response shape, see the note on GET below).
//
// Endpoints exposed (all mounted under /api):
//   GET    /skills                    -> { categories: [{ id, label, skills: [{id,name}, ...] }] }
//   POST   /skill-categories          -> create a category (appended at the end)
//   PATCH  /skill-categories/:id      -> rename a category
//   DELETE /skill-categories/:id      -> delete a category (cascades its skills)
//   POST   /skills                    -> create a skill, anywhere within its category
//   PATCH  /skills/:id                -> rename a skill
//   DELETE /skills/:id                -> delete a skill

const express = require("express");

module.exports = function skillRoutes(pool) {
  const router = express.Router();

  // Same insertion-position helper as routes/projects.js.
  //   - insertBeforeId == null -> append at the end (MAX + 1)
  //   - insertBeforeId given   -> midpoint between that row and whichever
  //                               row sits immediately before it in the
  //                               same scope (or MIN - 1 if it's first)
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

  // NOTE on shape: skills now come back as { id, name } objects, not plain
  // strings — editing/deleting a skill needs its id. If anything else
  // still expects plain strings, it needs to switch to reading `.name`.
  function groupByCategory(categories, skills) {
    return categories.map((cat) => ({
      id: cat.id,
      label: cat.label,
      skills: skills.filter((s) => s.category_id === cat.id).map((s) => ({ id: s.id, name: s.name })),
    }));
  }

  /* =================== READ =================== */

  router.get("/skills", async (req, res) => {
    try {
      const categoriesResult = await pool.query(`SELECT id, label FROM skill_categories ORDER BY position ASC;`);
      const skillsResult = await pool.query(`SELECT id, category_id, name FROM skills ORDER BY position ASC;`);
      res.json({ categories: groupByCategory(categoriesResult.rows, skillsResult.rows) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch skills" });
    }
  });

  /* =================== CATEGORIES =================== */

  // Create a category. body: { label, insertBeforeId? }
  // insertBeforeId omitted/null -> appended at the end.
  router.post("/skill-categories", async (req, res) => {
    const { label, insertBeforeId = null } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "skill_categories",
        scopeColumn: null,
        scopeValue: null,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO skill_categories (label, position) VALUES ($1, $2) RETURNING id, label;`,
        [label.trim(), position]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...rows[0], skills: [] });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create category" });
    } finally {
      client.release();
    }
  });

  router.patch("/skill-categories/:id", async (req, res) => {
    const { label } = req.body;
    if (!label || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE skill_categories SET label = $1 WHERE id = $2 RETURNING id, label;`,
        [label.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Category not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update category" });
    }
  });

  // ON DELETE CASCADE on skills.category_id takes care of its skills.
  router.delete("/skill-categories/:id", async (req, res) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM skill_categories WHERE id = $1;`, [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: "Category not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete category" });
    }
  });

  /* =================== SKILLS =================== */

  // Create a skill. body: { categoryId, name, insertBeforeId? }
  // insertBeforeId is scoped to the category — another skill's id within
  // the same categoryId, or null to append at the end of that category.
  router.post("/skills", async (req, res) => {
    const { categoryId, name, insertBeforeId = null } = req.body;
    if (!categoryId || !name || !name.trim()) {
      return res.status(400).json({ error: "categoryId and name are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const position = await computePosition(client, {
        table: "skills",
        scopeColumn: "category_id",
        scopeValue: categoryId,
        insertBeforeId,
      });
      const { rows } = await client.query(
        `INSERT INTO skills (category_id, name, position) VALUES ($1, $2, $3)
         RETURNING id, category_id, name;`,
        [categoryId, name.trim(), position]
      );
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(err.status || 500).json({ error: err.message || "Failed to create skill" });
    } finally {
      client.release();
    }
  });

  router.patch("/skills/:id", async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE skills SET name = $1 WHERE id = $2 RETURNING id, category_id, name;`,
        [name.trim(), req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Skill not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update skill" });
    }
  });

  router.delete("/skills/:id", async (req, res) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM skills WHERE id = $1;`, [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: "Skill not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete skill" });
    }
  });

  return router;
};