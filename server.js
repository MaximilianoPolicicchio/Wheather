// server.js
// Backend para clima + favoritos (SQLite)

const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Middlewares
app.use(cors());
app.use(express.json());

// ---- SQLite (archivo en la raíz del proyecto)
const DB_PATH = path.join(__dirname, "weather.db");
const db = new sqlite3.Database(DB_PATH);

// Crear tablas si no existen
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT,
      place TEXT,
      lat REAL,
      lon REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL UNIQUE,
      lat REAL,
      lon REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Utilidad: formatear place
function formatPlace(name, admin1, country) {
  return [name, admin1, country].filter(Boolean).join(", ");
}

// ---- Rutas utilitarias
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---- Rutas de clima

// GET /weather?city=Nombre
app.get("/weather", async (req, res) => {
  try {
    const city = String(req.query.city || "").trim();
    if (!city) return res.status(400).json({ error: "Falta city" });

    // 1) Geocoding
    const gUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      city
    )}&count=1&language=es&format=json`;
    const gRes = await fetch(gUrl);
    if (!gRes.ok) throw new Error("geo failed");
    const gData = await gRes.json();

    if (!gData.results || !gData.results.length)
      return res.status(404).json({ error: "Ciudad no encontrada" });

    const { latitude, longitude, name, country, admin1 } = gData.results[0];
    const place = formatPlace(name, admin1, country);

    // 2) Forecast
    const fUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,relative_humidity_2m,precipitation,pressure_msl` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum` +
      `&timezone=auto`;

    const fRes = await fetch(fUrl);
    if (!fRes.ok) throw new Error("forecast failed");
    const fData = await fRes.json();

    res.json({
      place,
      lat: latitude,
      lon: longitude,
      current: fData.current,
      daily: fData.daily,
    });
  } catch (e) {
    res.status(500).json({ error: "No se pudo obtener el clima" });
  }
});

// GET /weather/coords?lat=..&lon=..
app.get("/weather/coords", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon))
      return res.status(400).json({ error: "Lat/Lon inválidos" });

    // Reverse geocoding (Open-Meteo)
    let place = `(${lat.toFixed(2)}, ${lon.toFixed(2)})`;
    try {
      const rUrl = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=es&format=json`;
      const rRes = await fetch(rUrl);
      if (rRes.ok) {
        const rData = await rRes.json();
        if (rData.results && rData.results.length) {
          const { name, admin1, country } = rData.results[0];
          place = formatPlace(name, admin1, country) || place;
        }
      }
    } catch {}

    // Forecast
    const fUrl =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,relative_humidity_2m,precipitation,pressure_msl` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum` +
      `&timezone=auto`;

    const fRes = await fetch(fUrl);
    if (!fRes.ok) throw new Error("forecast failed");
    const fData = await fRes.json();

    res.json({
      place,
      current: fData.current,
      daily: fData.daily,
    });
  } catch (e) {
    res.status(500).json({ error: "No se pudo obtener el clima" });
  }
});

// ---- Rutas de favoritos (SQLite)

// POST /favorites  { city, lat, lon }
app.post("/favorites", (req, res) => {
  const { city, lat, lon } = req.body || {};
  if (!city) return res.status(400).json({ error: "Falta city" });

  db.run(
    `INSERT OR IGNORE INTO favorites (city, lat, lon) VALUES (?, ?, ?)`,
    [city, lat ?? null, lon ?? null],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });

      db.get(`SELECT * FROM favorites WHERE city = ?`, [city], (e, row) => {
        if (e) return res.status(500).json({ error: "DB error" });
        res.json(row);
      });
    }
  );
});

// POST /favorites/toggle { city, lat, lon }
app.post("/favorites/toggle", (req, res) => {
  const { city, lat, lon } = req.body || {};
  if (!city) return res.status(400).json({ error: "Falta city" });

  db.get(`SELECT * FROM favorites WHERE city = ?`, [city], (e, row) => {
    if (e) return res.status(500).json({ error: "DB error" });

    if (row) {
      db.run(`DELETE FROM favorites WHERE city = ?`, [city], function (err2) {
        if (err2) return res.status(500).json({ error: "DB error" });
        return res.json({ removed: true, city });
      });
    } else {
      db.run(
        `INSERT INTO favorites (city, lat, lon) VALUES (?, ?, ?)`,
        [city, lat ?? null, lon ?? null],
        function (err3) {
          if (err3) return res.status(500).json({ error: "DB error" });
          db.get(
            `SELECT * FROM favorites WHERE id = ?`,
            [this.lastID],
            (e2, row2) => {
              if (e2) return res.status(500).json({ error: "DB error" });
              res.json({ created: true, ...row2 });
            }
          );
        }
      );
    }
  });
});

// GET /favorites
app.get("/favorites", (_req, res) => {
  db.all(
    `SELECT * FROM favorites ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

// GET /favorites/search?city=texto
app.get("/favorites/search", (req, res) => {
  const q = `%${String(req.query.city || "").trim()}%`;
  db.all(
    `SELECT * FROM favorites WHERE city LIKE ? ORDER BY created_at DESC`,
    [q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json(rows);
    }
  );
});

// GET /favorites/:id
app.get("/favorites/:id", (req, res) => {
  db.get(
    `SELECT * FROM favorites WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "No existe" });
      res.json(row);
    }
  );
});

// DELETE /favorites/:id
app.delete("/favorites/:id", (req, res) => {
  db.run(`DELETE FROM favorites WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: "DB error" });
    if (this.changes === 0) return res.status(404).json({ error: "No existe" });
    res.json({ ok: true, deleted: req.params.id });
  });
});

// ---- Start
app.listen(PORT, () => {
  console.log(`API lista en http://localhost:${PORT}`);
});
