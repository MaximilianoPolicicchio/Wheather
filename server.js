// server.js — ESM
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

/* =========================
   SQLite init
   ========================= */
const db = await open({
  filename: "./weather.db",
  driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT,
  place TEXT,
  lat REAL,
  lon REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT UNIQUE,
  lat REAL,
  lon REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

/* =========================
   Helpers
   ========================= */

// quita diacríticos: "Seúl" -> "Seul"
function stripAccents(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function placeFromParts(name, admin1, country) {
  return [name, admin1, country].filter(Boolean).join(", ");
}

// fetch con timeout simple
async function fetchJSON(url, { signal, timeoutMs = 12000, headers } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);

  // compone señales si te pasaron una
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  const res = await fetch(url, { signal: ctrl.signal, headers });
  clearTimeout(t);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Geocoder Open-Meteo (search) */
async function geocodeOpenMeteo(q, signal) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    q
  )}&count=1&language=es&format=json`;
  try {
    const data = await fetchJSON(url, { signal });
    if (data.results?.length) {
      const { latitude, longitude, name, admin1, country } = data.results[0];
      return {
        latitude,
        longitude,
        place: placeFromParts(name, admin1, country),
      };
    }
  } catch {
    // ignoro para fallback
  }
  return null;
}

/** Fallback: Nominatim (OpenStreetMap) */
async function geocodeFallbackNominatim(q, signal) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
    q
  )}`;
  try {
    const arr = await fetchJSON(url, {
      signal,
      headers: { "User-Agent": "weather-app (learning project)" },
    });
    if (Array.isArray(arr) && arr.length) {
      const { lat, lon, display_name } = arr[0];
      return {
        latitude: Number(lat),
        longitude: Number(lon),
        place: display_name,
      };
    }
  } catch {
    // ignoro
  }
  return null;
}

/** Reverse geocode Open-Meteo */
async function reverseOpenMeteo(lat, lon, signal) {
  const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=es&format=json`;
  try {
    const data = await fetchJSON(url, { signal });
    if (data.results?.length) {
      const { name, admin1, country } = data.results[0];
      return placeFromParts(name, admin1, country);
    }
  } catch {
    // ignoro, mando coords
  }
  return `(${Number(lat).toFixed(2)}, ${Number(lon).toFixed(2)})`;
}

/** Pronóstico Open-Meteo */
async function fetchForecast(lat, lon, signal) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,relative_humidity_2m,precipitation,pressure_msl` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum` +
    `&timezone=auto`;
  return fetchJSON(url, { signal });
}

/* =========================
   Rutas
   ========================= */

app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// GET /weather?city=...
app.get("/weather", async (req, res) => {
  const controller = new AbortController();
  const { signal } = controller;

  try {
    const raw = String(req.query.city || "").trim();
    if (!raw) return res.status(400).json({ error: "Falta ?city" });

    // 1) candidatos: texto completo, primer tramo (antes de coma), y sin acentos
    const first = raw.split(",")[0].trim();
    const candidates = [raw, first];
    const noAccents = stripAccents(first);
    if (noAccents.toLowerCase() !== first.toLowerCase())
      candidates.push(noAccents);

    // 2) probar Open-Meteo con candidatos
    let geo = null;
    for (const q of candidates) {
      geo = await geocodeOpenMeteo(q, signal);
      if (geo) break;
    }

    // 3) fallback a Nominatim
    if (!geo) {
      geo = await geocodeFallbackNominatim(first, signal);
    }

    if (!geo) return res.status(404).json({ error: "Ciudad no encontrada" });

    // 4) pronóstico
    const f = await fetchForecast(geo.latitude, geo.longitude, signal);

    // 5) persistimos última búsqueda (opcional)
    try {
      await db.run(
        `INSERT INTO searches (city, place, lat, lon) VALUES (?, ?, ?, ?)`,
        raw,
        geo.place,
        geo.latitude,
        geo.longitude
      );
    } catch {}

    // Devuelvo también coordenadas (contrato alineado con el frontend)
    res.json({
      place: geo.place,
      current: f.current,
      daily: f.daily,
      lat: geo.latitude,
      lon: geo.longitude,
    });
  } catch (e) {
    console.error(e);
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || "Error";
    res.status(500).json({ error: msg });
  }
});

// GET /weather/coords?lat&lon
app.get("/weather/coords", async (req, res) => {
  const controller = new AbortController();
  const { signal } = controller;

  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lat/Lon inválidos" });
    }

    const place = await reverseOpenMeteo(lat, lon, signal);
    const f = await fetchForecast(lat, lon, signal);

    // incluyo lat/lon por consistencia
    res.json({ place, current: f.current, daily: f.daily, lat, lon });
  } catch (e) {
    console.error(e);
    const msg = e?.name === "AbortError" ? "timeout" : e?.message || "Error";
    res.status(500).json({ error: msg });
  }
});

/* ===== Favoritos ===== */

// GET /favorites
app.get("/favorites", async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, city, lat, lon, created_at FROM favorites ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

// POST /favorites/toggle  { city, lat, lon }
app.post("/favorites/toggle", async (req, res) => {
  try {
    const { city, lat, lon } = req.body || {};
    if (!city) return res.status(400).json({ error: "Falta city" });

    const existing = await db.get(
      `SELECT id FROM favorites WHERE city = ?`,
      city
    );
    if (existing) {
      await db.run(`DELETE FROM favorites WHERE id = ?`, existing.id);
      return res.json({ removed: true });
    } else {
      await db.run(
        `INSERT OR IGNORE INTO favorites (city, lat, lon) VALUES (?, ?, ?)`,
        city,
        Number.isFinite(lat) ? lat : null,
        Number.isFinite(lon) ? lon : null
      );
      const row = await db.get(`SELECT * FROM favorites WHERE city = ?`, city);
      return res.json({ added: true, row });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB error" });
  }
});

/* =========================
   Start
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend escuchando en http://localhost:${PORT}`);
});
