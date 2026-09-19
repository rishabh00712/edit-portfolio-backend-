// routes/header.js
//
// Mount in app.js like this:
//
//   const headerRoutes = require("./routes/header")(pool, cloudinary);
//   app.use("/api", headerRoutes);
//
// Endpoints exposed (all mounted under /api):
//   GET    /header-info         -> { name, tagline, roles, socials, photos, work? }
//   PATCH  /profile             -> update name / tagline
//   POST   /photos (multipart)  -> upload an image straight to Cloudinary, save its URL
//   DELETE /photos/:id
//   POST   /roles               -> add a role
//   DELETE /roles/:id
//   POST   /socials             -> add/update one of the 5 fixed platforms
//   DELETE /socials/:id
//   PATCH  /work                -> update company / role text
//   POST   /work/logo (multipart) -> upload a new work logo straight to Cloudinary
//
// Image handling: this file owns Cloudinary directly (same pattern as
// routes/projects.js) — the frontend sends the raw file as
// multipart/form-data, this route streams it to Cloudinary itself, and
// only the resulting secure_url ever gets written to Neon. No separate
// /api/upload round trip needed for header images.

const express = require("express");
const multer = require("multer");

function publicIdFromUrl(url) {
  // matches the part after /upload/(optional v12345/) up to the file extension
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
  return match ? match[1] : null;
}

module.exports = function headerRoutes(pool, cloudinary) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
  });

  function uploadBufferToCloudinary(buffer, folder) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder }, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
      stream.end(buffer);
    });
  }

  // "Rishabh Garai" -> "Rishabh". If the name is already a single word,
  // it comes back unchanged. Header only ever shows the first name —
  // this is the one place that rule is enforced, so every consumer of
  // /header-info automatically gets just the first name for free.
  function firstNameOnly(fullName) {
    if (!fullName) return fullName;
    return fullName.trim().split(/\s+/)[0];
  }

  const ALLOWED_SOCIAL_PLATFORMS = ["github", "linkedin", "leetcode", "codeforces", "codechef"];

  /* ============================================================
     HEADER — read
  ============================================================ */

  router.get("/header-info", async (req, res) => {
    try {
      const profileResult = await pool.query(
        `SELECT id, name, tagline, work_company, work_role, work_logo_url
         FROM profile LIMIT 1;`
      );
      if (profileResult.rows.length === 0) {
        return res.status(404).json({ error: "Profile not set up" });
      }
      const profile = profileResult.rows[0];

      const rolesResult = await pool.query(
        `SELECT id, role_text FROM roles WHERE profile_id = $1 ORDER BY position ASC;`,
        [profile.id]
      );

      const socialsResult = await pool.query(
        `SELECT id, platform, url FROM socials WHERE profile_id = $1 ORDER BY position ASC;`,
        [profile.id]
      );

      const photosResult = await pool.query(
        `SELECT id, url FROM photos WHERE profile_id = $1 ORDER BY created_at ASC;`,
        [profile.id]
      );

      const response = {
        name: firstNameOnly(profile.name), // "Rishabh Garai" -> "Rishabh"
        tagline: profile.tagline,
        roles: rolesResult.rows,
        socials: socialsResult.rows,
        photos: photosResult.rows,
      };

      if (profile.work_company || profile.work_role) {
        response.work = {
          company: profile.work_company,
          role: profile.work_role,
          logo: profile.work_logo_url,
        };
      }

      res.json(response);
    } catch (err) {
      console.error("[GET /header-info] ERROR:", err);
      res.status(500).json({ error: "Failed to fetch header info" });
    }
  });

  /* ============================================================
     PROFILE — name / tagline
     Note: store the FULL name here (e.g. "Rishabh Garai"). Only the
     GET /header-info response trims it to the first word — the full
     name is still preserved in the database for other sections
     (resume, contact, etc.) that may want the whole thing later.
  ============================================================ */

  router.patch("/profile", async (req, res) => {
    const { name, tagline } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE profile
         SET name = COALESCE($1, name),
             tagline = COALESCE($2, tagline),
             updated_at = now()
         WHERE id = (SELECT id FROM profile LIMIT 1)
         RETURNING name, tagline;`,
        [name, tagline]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
      res.json({ ...rows[0], name: firstNameOnly(rows[0].name) });
    } catch (err) {
      console.error("[PATCH /profile] ERROR:", err);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  /* ============================================================
     PHOTOS — upload goes straight to Cloudinary from here.
     multipart/form-data, field name: "image"
  ============================================================ */

  router.post("/photos", upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file uploaded (field name must be 'image')" });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    try {
      const profileId = (await pool.query(`SELECT id FROM profile LIMIT 1;`)).rows[0]?.id;
      if (!profileId) return res.status(404).json({ error: "Profile not set up" });

      const uploadResult = await uploadBufferToCloudinary(req.file.buffer, "portfolio/header");

      const { rows } = await pool.query(
        `INSERT INTO photos (profile_id, url) VALUES ($1, $2) RETURNING id, url;`,
        [profileId, uploadResult.secure_url]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error("[POST /photos] ERROR:", err);
      res.status(500).json({ error: "Failed to upload photo" });
    }
  });

router.delete("/photos/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM photos WHERE id = $1 RETURNING url;`,
      [req.params.id]
    );

    const url = rows[0]?.url;
    if (url) {
      const publicId = publicIdFromUrl(url);
      if (publicId) {
        cloudinary.uploader.destroy(publicId).catch((err) =>
          console.error("[DELETE /photos/:id] Cloudinary cleanup failed:", err)
        );
      } else {
        console.warn("[DELETE /photos/:id] Could not parse public_id from url:", url);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /photos/:id] ERROR:", err);
    res.status(500).json({ error: "Failed to delete photo" });
  }
});

  /* ============================================================
     ROLES
  ============================================================ */

  router.post("/roles", async (req, res) => {
    const { role_text } = req.body;
    if (!role_text) return res.status(400).json({ error: "role_text is required" });
    try {
      const { rows } = await pool.query(
        `INSERT INTO roles (profile_id, role_text, position)
         VALUES ((SELECT id FROM profile LIMIT 1), $1,
           (SELECT COALESCE(MAX(position), 0) + 1 FROM roles))
         RETURNING id, role_text;`,
        [role_text]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error("[POST /roles] ERROR:", err);
      res.status(500).json({ error: "Failed to add role" });
    }
  });

  router.delete("/roles/:id", async (req, res) => {
    try {
      await pool.query(`DELETE FROM roles WHERE id = $1;`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE /roles/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to delete role" });
    }
  });

  /* ============================================================
     SOCIALS — only 5 fixed platforms, one link per platform.
  ============================================================ */

  router.post("/socials", async (req, res) => {
    const { platform, url } = req.body;
    if (!platform || !ALLOWED_SOCIAL_PLATFORMS.includes(platform)) {
      return res.status(400).json({
        error: `platform must be one of: ${ALLOWED_SOCIAL_PLATFORMS.join(", ")}`,
      });
    }
    if (!url) return res.status(400).json({ error: "url is required" });

    try {
      const existing = await pool.query(`SELECT id FROM socials WHERE platform = $1;`, [platform]);

      const result = existing.rows.length > 0
        ? await pool.query(
            `UPDATE socials SET url = $1 WHERE platform = $2 RETURNING id, platform, url;`,
            [url, platform]
          )
        : await pool.query(
            `INSERT INTO socials (profile_id, platform, url, position)
             VALUES ((SELECT id FROM profile LIMIT 1), $1, $2,
               (SELECT COALESCE(MAX(position), 0) + 1 FROM socials))
             RETURNING id, platform, url;`,
            [platform, url]
          );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("[POST /socials] ERROR:", err);
      res.status(500).json({ error: "Failed to save social link" });
    }
  });

  router.delete("/socials/:id", async (req, res) => {
    try {
      await pool.query(`DELETE FROM socials WHERE id = $1;`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[DELETE /socials/:id] ERROR:", err);
      res.status(500).json({ error: "Failed to delete social link" });
    }
  });

  /* ============================================================
     WORK — company / role text, and a separate logo upload route.
  ============================================================ */

  router.patch("/work", async (req, res) => {
    const { company, role } = req.body;
    try {
      const { rows } = await pool.query(
        `UPDATE profile
         SET work_company = $1,
             work_role = $2,
             updated_at = now()
         WHERE id = (SELECT id FROM profile LIMIT 1)
         RETURNING work_company, work_role, work_logo_url;`,
        [company || null, role || null]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[PATCH /work] ERROR:", err);
      res.status(500).json({ error: "Failed to update work info" });
    }
  });
router.post("/work/logo", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image file uploaded (field name must be 'image')" });
  if (!req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "Uploaded file must be an image" });
  }

  try {
    // grab the OLD url before overwriting it
    const oldUrl = (
      await pool.query(`SELECT work_logo_url FROM profile LIMIT 1;`)
    ).rows[0]?.work_logo_url;

    const uploadResult = await uploadBufferToCloudinary(req.file.buffer, "portfolio/header");

    const { rows } = await pool.query(
      `UPDATE profile
       SET work_logo_url = $1, updated_at = now()
       WHERE id = (SELECT id FROM profile LIMIT 1)
       RETURNING work_company, work_role, work_logo_url;`,
      [uploadResult.secure_url]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });

    // now delete the old logo from Cloudinary, using the old url
    if (oldUrl) {
      const oldPublicId = publicIdFromUrl(oldUrl);
      if (oldPublicId) {
        cloudinary.uploader.destroy(oldPublicId).catch((err) =>
          console.error("[POST /work/logo] Cloudinary cleanup failed:", err)
        );
      }
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("[POST /work/logo] ERROR:", err);
    res.status(500).json({ error: "Failed to upload work logo" });
  }
});


router.delete("/work", async (req, res) => {
  try {
    // grab the old logo url first so we can clean it up on Cloudinary
    const oldUrl = (
      await pool.query(`SELECT work_logo_url FROM profile LIMIT 1;`)
    ).rows[0]?.work_logo_url;

    const { rows } = await pool.query(
      `UPDATE profile
       SET work_company = NULL,
           work_role = NULL,
           work_logo_url = NULL,
           updated_at = now()
       WHERE id = (SELECT id FROM profile LIMIT 1)
       RETURNING work_company, work_role, work_logo_url;`
    );
    if (rows.length === 0) return res.status(404).json({ error: "Profile not set up" });

    if (oldUrl) {
      const oldPublicId = publicIdFromUrl(oldUrl);
      if (oldPublicId) {
        cloudinary.uploader.destroy(oldPublicId).catch((err) =>
          console.error("[DELETE /work] Cloudinary cleanup failed:", err)
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /work] ERROR:", err);
    res.status(500).json({ error: "Failed to delete work info" });
  }
});

  return router;
};