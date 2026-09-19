// routes/contact.js
//
// Mount in app.js:
//
//   const contactRoutes = require("./routes/contact")(pool);
//   app.use("/api", contactRoutes);

const express = require("express");

module.exports = function contactRoutes(pool) {
  const router = express.Router();

  function shapeContact(p, photoUrl) {
    return {
      name: p.name,
      photo: photoUrl ?? null,
      phone: p.phone,
      email: p.email,
      whatsapp: p.whatsapp_number,
      additionalPhone: p.extra_phone,
      additionalEmail: p.extra_email,
    };
  }

  router.get("/contact-info", async (req, res) => {
    try {
      const profileResult = await pool.query(
        `SELECT name, phone, email, whatsapp_number, extra_phone, extra_email
         FROM profile LIMIT 1;`
      );
      if (profileResult.rows.length === 0) {
        return res.status(404).json({ error: "Profile not set up" });
      }

      // Reuses the same photo pool as the header — no separate "contact
      // photo" table, since it's the same person's photo either way.
      const photoResult = await pool.query(`SELECT url FROM photos ORDER BY random() LIMIT 1;`);

      res.json(shapeContact(profileResult.rows[0], photoResult.rows[0]?.url));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch contact info" });
    }
  });

  // Body: any subset of { name, phone, email, whatsapp, additionalPhone, additionalEmail }.
  // Omitted fields keep their current value — each column falls back via
  // COALESCE, so only the fields actually sent get overwritten.
  router.patch("/contact-info", async (req, res) => {
    const { name, phone, email, whatsapp, additionalPhone, additionalEmail } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE profile
         SET name = COALESCE($1, name),
             phone = COALESCE($2, phone),
             email = COALESCE($3, email),
             whatsapp_number = COALESCE($4, whatsapp_number),
             extra_phone = COALESCE($5, extra_phone),
             extra_email = COALESCE($6, extra_email),
             updated_at = now()
         WHERE id = (SELECT id FROM profile LIMIT 1)
         RETURNING name, phone, email, whatsapp_number, extra_phone, extra_email;`,
        [
          name ?? null,
          phone ?? null,
          email ?? null,
          whatsapp ?? null,
          additionalPhone ?? null,
          additionalEmail ?? null,
        ]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
      res.json(shapeContact(rows[0]));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update contact info" });
    }
  });

  return router;
};