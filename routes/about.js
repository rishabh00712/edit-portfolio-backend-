// routes/about.js
//
// About section: summary text + 3 fixed info fields (location, work
// style, availability) stored directly on `profile`, plus the
// `extracurricular` list — which supports inserting a new item at the
// start, between any two existing items, or at the end, using the
// midpoint-position pattern documented in the schema.
//
// Mount this in app.js:
//
//   const aboutRoutes = require("./routes/about")(pool);
//   app.use("/api", aboutRoutes);
//
// (`pool` is the same `pg` Pool instance app.js already creates from
// DATABASE_URL — passed in so this file never opens its own connection.)

const express = require("express");

module.exports = function aboutRoutes(pool) {
  const router = express.Router();

  /* ============================================================
     SUMMARY
  ============================================================ */

  router.get("/about-summary", async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT about_summary FROM profile LIMIT 1;`);
      res.json({ summary: rows[0]?.about_summary ?? null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch about summary" });
    }
  });

  router.patch("/about-summary", async (req, res) => {
    const { summary } = req.body;
    if (typeof summary !== "string" || !summary.trim()) {
      return res.status(400).json({ error: "summary is required" });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE profile
         SET about_summary = $1, updated_at = now()
         WHERE id = (SELECT id FROM profile LIMIT 1)
         RETURNING about_summary;`,
        [summary.trim()]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
      res.json({ summary: rows[0].about_summary });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update about summary" });
    }
  });

  /* ============================================================
     INFO ROWS — Based in / Work style / Availability
     Labels are fixed (they default in the schema); only values and
     the isOpen flag are ever sent from the frontend.
  ============================================================ */

  router.get("/about", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT about_work_role_label, about_work_role_value,
              about_work_pref_label, about_work_pref_value,
              about_location_label, about_location_value,
              about_availability_label, about_availability_value,
              about_is_open
       FROM profile LIMIT 1;`
    );
    if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
    res.json(shapeAboutRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch about info" });
  }
});

  router.patch("/about", async (req, res) => {
  const { workRoleValue, workPrefValue, locationValue, availabilityValue, isOpen } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE profile
       SET about_work_role_value = COALESCE($1, about_work_role_value),
           about_work_pref_value = COALESCE($2, about_work_pref_value),
           about_location_value = COALESCE($3, about_location_value),
           about_availability_value = COALESCE($4, about_availability_value),
           about_is_open = COALESCE($5, about_is_open),
           updated_at = now()
       WHERE id = (SELECT id FROM profile LIMIT 1)
       RETURNING about_work_role_label, about_work_role_value,
                 about_work_pref_label, about_work_pref_value,
                 about_location_label, about_location_value,
                 about_availability_label, about_availability_value,
                 about_is_open;`,
      [
        workRoleValue ?? null,
        workPrefValue ?? null,
        locationValue ?? null,
        availabilityValue ?? null,
        typeof isOpen === "boolean" ? isOpen : null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
    res.json(shapeAboutRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update about info" });
  }
});

  function shapeAboutRow(p) {
  return {
    workRole: { label: p.about_work_role_label, value: p.about_work_role_value },
    workPreference: { label: p.about_work_pref_label, value: p.about_work_pref_value },
    location: { label: p.about_location_label, value: p.about_location_value },
    availability: {
      label: p.about_availability_label,
      value: p.about_availability_value,
      isOpen: p.about_is_open,
    },
  };
}

  /* ============================================================
     EXTRACURRICULAR — reorderable list, insertable anywhere
  ============================================================ */

  router.get("/extracurricular", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, description, position
         FROM extracurricular ORDER BY position ASC;`
      );
      res.json({ activities: rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch extracurricular activities" });
    }
  });

  // Body: { title, description?, insertBeforeId? }
  //   insertBeforeId omitted / null -> append at the very end
  //   insertBeforeId: <id>          -> insert immediately before that item
  //
  // Position is the midpoint between the target and whatever currently
  // sits before it (or MIN - 1 if the target is currently first), so
  // this never has to touch any other row's position.
  router.post("/extracurricular", async (req, res) => {
    const { title, description, insertBeforeId } = req.body;
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    try {
      let position;

      if (insertBeforeId == null) {
        const { rows } = await pool.query(
          `SELECT COALESCE(MAX(position), 0) + 1 AS position FROM extracurricular;`
        );
        position = rows[0].position;
      } else {
        const target = await pool.query(
          `SELECT position FROM extracurricular WHERE id = $1;`,
          [insertBeforeId]
        );
        if (target.rows.length === 0) {
          return res.status(400).json({ error: "insertBeforeId does not exist" });
        }
        const targetPosition = target.rows[0].position;

        const before = await pool.query(
          `SELECT position FROM extracurricular
           WHERE position < $1
           ORDER BY position DESC LIMIT 1;`,
          [targetPosition]
        );

        position =
          before.rows.length > 0
            ? (Number(before.rows[0].position) + Number(targetPosition)) / 2
            : Number(targetPosition) - 1;
      }

      const { rows } = await pool.query(
        `INSERT INTO extracurricular (title, description, position)
         VALUES ($1, $2, $3)
         RETURNING id, title, description, position;`,
        [title.trim(), description?.trim() || null, position]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to add extracurricular activity" });
    }
  });

  router.patch("/extracurricular/:id", async (req, res) => {
    const { title, description } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE extracurricular
         SET title = COALESCE($1, title),
             description = COALESCE($2, description)
         WHERE id = $3
         RETURNING id, title, description, position;`,
        [title ?? null, description ?? null, req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Activity not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update extracurricular activity" });
    }
  });

  router.delete("/extracurricular/:id", async (req, res) => {
    try {
      await pool.query(`DELETE FROM extracurricular WHERE id = $1;`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete extracurricular activity" });
    }
  });

  return router;
};