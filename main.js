// main.js — Frontend completo

/* ============================
   CONFIG + ESTADO
============================ */
const BACKEND_URL = "http://localhost:3000";

const state = {
  unit: localStorage.getItem("unit") || "C", // 'C' | 'F'
};

const GEO_PREF_KEY = "geo-consent"; // 'granted' | 'denied'
let hasSearched = false; // se activa en cada búsqueda
let lastResult = null; // { place, lat, lon }

// Formatters
const nf1 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nfPerc0 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nf1raw = (n) => (Math.round(n * 10) / 10).toString();

const toF = (c) => (c * 9) / 5 + 32;
const kmhToMph = (k) => k * 0.621371;

const asTemp = (n) =>
  state.unit === "C" ? `${nf1.format(n)}°C` : `${nf1.format(toF(n))}°F`;
const asWind = (kmh) =>
  state.unit === "C"
    ? `${nf0.format(kmh)} km/h`
    : `${nf0.format(kmhToMph(kmh))} mph`;

// Emoji simple por código WMO
const WMO_ICON = (code) => {
  if (code === 0) return "☀️";
  if (code >= 1 && code <= 3) return "⛅";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code === 85 || code === 86) return "❄️";
  if (code === 95 || code === 96 || code === 99) return "⛈️";
  return "🌤️";
};

// Cache en memoria (clave: ciudad o "lat,lon")
const cache = new Map();

/* ============================
   SELECTORES DEL DOM
============================ */
const form = document.getElementById("search-form");
const input = document.getElementById("city");
const loader = document.getElementById("loader");
const statusEl = document.getElementById("status");
const currentEl = document.getElementById("current");
const dailyEl = document.getElementById("daily");
const unitCBtn = document.getElementById("unit-c");
const unitFBtn = document.getElementById("unit-f");
const historyEl = document.getElementById("history");
const recentEl = document.getElementById("recent");
const favBtn = document.getElementById("btn-fav");
const favsEl = document.getElementById("favs");

/* ============================
   UI HELPERS
============================ */
function setLoading(is) {
  if (loader) loader.hidden = !is;
}
function setStatus(msg, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.className = "status " + (type === "error" ? "error" : "info");
}
function updateUnitButtons() {
  const isC = state.unit === "C";
  if (unitCBtn && unitFBtn) {
    unitCBtn.setAttribute("aria-pressed", String(isC));
    unitFBtn.setAttribute("aria-pressed", String(!isC));
    unitCBtn.disabled = isC;
    unitFBtn.disabled = !isC;
  }
}
function debounce(fn, delay = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/* ============================
   FETCH JSON con timeout
============================ */
async function fetchJSON(url, { signal, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);

  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Error ${res.status}: ${res.statusText}`);
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    if (!navigator.onLine)
      throw new Error("Estás sin conexión. Verificá tu internet.");
    if (e.name === "AbortError" || e.message === "timeout") throw e;
    throw new Error("No se pudo conectar con el servidor.");
  }
}
async function postJSON(url, body, { signal, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Error ${res.status}: ${res.statusText}`);
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function apiListFavorites(signal) {
  return fetchJSON(`${BACKEND_URL}/favorites`, { signal });
}

function apiToggleFavorite({ city, lat, lon }, signal) {
  return postJSON(
    `${BACKEND_URL}/favorites/toggle`,
    { city, lat, lon },
    { signal }
  );
}

/* ============================
   BACKEND API (clima)
============================ */
function fetchWeatherByCityFromBackend(city, signal) {
  const url = `${BACKEND_URL}/weather?city=${encodeURIComponent(city)}`;
  return fetchJSON(url, { signal });
}
function fetchWeatherByCoordsFromBackend(lat, lon, signal) {
  const url = `${BACKEND_URL}/weather/coords?lat=${lat}&lon=${lon}`;
  return fetchJSON(url, { signal });
}
// ===== Favoritos API =====
async function apiListFavorites(signal) {
  return fetchJSON(`${BACKEND_URL}/favorites`, { signal });
}

async function apiToggleFavorite({ city, lat, lon }, signal) {
  return fetchJSON(`${BACKEND_URL}/favorites/toggle`, {
    signal,
    // fetchJSON actual no acepta body; hacemos un pequeño helper inline:
    // Para simplificar, agregamos una variante POST mínima:
  }).catch(() => {}); // placeholder
}

/* ============================
   REVERSE GEOCODING helper
============================ */
async function getPlaceFromCoords(lat, lon, signal) {
  // 1) BigDataCloud
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=es`;
    const data = await fetchJSON(url, { signal });
    const city = data.city || data.locality || data.principalSubdivision || "";
    const region = data.principalSubdivision || "";
    const country = data.countryName || "";
    const place = [city, region, country].filter(Boolean).join(", ");
    if (place) return place;
  } catch {}
  // 2) Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const data = await fetchJSON(url, { signal });
    const a = data.address || {};
    const city = a.city || a.town || a.village || a.hamlet || "";
    const region = a.state || a.region || "";
    const country = a.country || "";
    const place = [city, region, country].filter(Boolean).join(", ");
    if (place) return place;
  } catch {}
  return `(${lat.toFixed(2)}, ${lon.toFixed(2)})`;
}

/* ============================
   HISTORIAL (localStorage)
============================ */
const HISTORY_KEY = "city-history";

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}
function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}
function renderHistory() {
  if (!historyEl) return;
  const list = getHistory();
  historyEl.innerHTML = !list.length
    ? ""
    : list
        .map((c) => `<button type="button" data-city="${c}">${c}</button>`)
        .join("");
}
async function refreshFavoritesUI() {
  if (!favsEl) return;
  try {
    const list = await apiListFavorites();
    if (!list.length) {
      favsEl.innerHTML = "";
      return;
    }
    favsEl.innerHTML = list
      .map(
        (f) => `
      <button type="button" class="fav-chip" data-city="${f.city}">
        ★ ${f.city}
      </button>
    `
      )
      .join("");
  } catch (e) {
    // ignoramos errores de red silenciosamente
  }
}

// click en un favorito = buscarlo
favsEl?.addEventListener("click", (e) => {
  const btn = e.target.closest(".fav-chip");
  if (!btn) return;
  input.value = btn.dataset.city;
  searchCity(input.value);
});

function addToHistory(city) {
  const key = city.trim();
  if (!key) return;
  let list = getHistory().filter((c) => c.toLowerCase() !== key.toLowerCase());
  list.unshift(key);
  list = list.slice(0, 5);
  saveHistory(list);
  renderHistory();
}
historyEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-city]");
  if (!btn) return;
  input.value = btn.dataset.city;
  searchCity(input.value);
});
async function setFavButtonFor(place) {
  if (!favBtn) {
    return;
  }
  if (!place) {
    favBtn.hidden = true;
    return;
  }
  favBtn.hidden = false;

  // ¿Está en favoritos?
  try {
    const list = await apiListFavorites();
    const isFav = list.some(
      (f) => (f.city || "").toLowerCase() === place.toLowerCase()
    );
    favBtn.textContent = isFav ? "★ Favorito" : "☆ Favorito";
    favBtn.classList.toggle("active", isFav);
  } catch {
    // si falla la red, mostramos el botón igual “apagado”
    favBtn.textContent = "☆ Favorito";
    favBtn.classList.remove("active");
  }
}
favBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  toggleCurrentFavorite();
});

async function toggleCurrentFavorite() {
  if (!lastResult || !lastResult.place) return;
  try {
    await apiToggleFavorite({
      city: lastResult.place,
      lat: lastResult.lat ?? null,
      lon: lastResult.lon ?? null,
    });
    await setFavButtonFor(lastResult.place);
    await refreshFavoritesUI();
  } catch (e) {
    setStatus("No se pudo actualizar favoritos", "error");
  }
}

/* ============================
   RENDER
============================ */
function renderCurrent(el, place, current) {
  const items = [
    { label: "Temperatura", val: asTemp(current.temperature_2m) },
    { label: "Sensación", val: asTemp(current.apparent_temperature) },
    { label: "Viento", val: asWind(current.wind_speed_10m) },
  ];
  if (typeof current.relative_humidity_2m === "number")
    items.push({
      label: "Humedad",
      val: `${nfPerc0.format(current.relative_humidity_2m)}%`,
    });
  if (typeof current.precipitation === "number")
    items.push({
      label: "Precipitación",
      val: `${nf1raw(current.precipitation)} mm`,
    });
  if (typeof current.pressure_msl === "number")
    items.push({
      label: "Presión",
      val: `${nf0.format(current.pressure_msl)} hPa`,
    });

  el.innerHTML = `
    <div class="row" style="justify-content: space-between;">
      <div>
        <h2 class="place">${place}</h2>
        <div class="muted">${new Date().toLocaleString("es-AR")}</div>
      </div>
      <div class="emoji" aria-hidden="true">${WMO_ICON(
        current.weather_code
      )}</div>
    </div>
    <div class="kv">
      ${items
        .map(
          ({ label, val }) => `
          <div>
            <div class="label">${label}</div>
            <div class="${
              label === "Temperatura" || label === "Sensación" ? "big" : ""
            }">${val}</div>
          </div>`
        )
        .join("")}
    </div>
  `;
}

function renderDaily(el, daily) {
  const days = daily.time.slice(0, 5).map((date, i) => ({
    date,
    tmax: daily.temperature_2m_max[i],
    tmin: daily.temperature_2m_min[i],
    code: daily.weather_code[i],
    pprob: daily.precipitation_probability_max?.[i],
    psum: daily.precipitation_sum?.[i],
  }));

  el.innerHTML = days
    .map(
      (d) => `
      <article class="day">
        <div class="row" style="justify-content: space-between;">
          <strong>${new Date(d.date).toLocaleDateString("es-AR", {
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
          })}</strong>
          <span class="emoji" aria-hidden="true">${WMO_ICON(d.code)}</span>
        </div>
        <div class="row" style="justify-content: space-between; margin-top:8px;">
          <span class="muted">Mín</span><span>${asTemp(d.tmin)}</span>
        </div>
        <div class="row" style="justify-content: space-between;">
          <span class="muted">Máx</span><span>${asTemp(d.tmax)}</span>
        </div>
        ${
          typeof d.pprob === "number"
            ? `<div class="row" style="justify-content: space-between;">
                 <span class="muted">Lluvia (prob.)</span><span>${nfPerc0.format(
                   d.pprob
                 )}%</span>
               </div>`
            : ""
        }
        ${
          typeof d.psum === "number"
            ? `<div class="row" style="justify-content: space-between;">
                 <span class="muted">Lluvia (acum.)</span><span>${nf1raw(
                   d.psum
                 )} mm</span>
               </div>`
            : ""
        }
      </article>`
    )
    .join("");
}

function render(place, data) {
  currentEl.hidden = false;
  dailyEl.hidden = false;
  renderCurrent(currentEl, place, data.current);
  renderDaily(dailyEl, data.daily);
}

/* ============================
   BÚSQUEDA
============================ */
let controller; // AbortController para cancelar en curso

async function searchCity(city) {
  const key = (city || "").trim().toLowerCase();
  if (!key) return;
  hasSearched = true;

  // Cache
  if (cache.has(key)) {
    const { place, data } = cache.get(key);
    cache.set(place.toLowerCase(), { place, data });
    render(place, data);
    addToHistory(place);
    renderRecentFromHistory();
    setStatus("");
    return;
  }

  controller?.abort();
  controller = new AbortController();
  try {
    setLoading(true);
    setStatus("Buscando…");
    const resp = await fetchWeatherByCityFromBackend(key, controller.signal);

    const place = resp.place;
    const data = { current: resp.current, daily: resp.daily };

    cache.set(key, { place, data });
    cache.set(place.toLowerCase(), { place, data });

    // Guardamos el último resultado (para el botón de favoritos)
    lastResult = { place, lat: resp.lat ?? null, lon: resp.lon ?? null };

    render(place, data);
    addToHistory(place);
    renderRecentFromHistory();
    setStatus("");

    // Actualizamos el botón de favorito según si ya está en DB
    setFavButtonFor(place);
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "Ocurrió un error", "error");
    currentEl.hidden = true;
    dailyEl.hidden = true;
  } finally {
    setLoading(false);
  }
}

async function searchByCoords(lat, lon) {
  hasSearched = true;
  controller?.abort();
  controller = new AbortController();
  try {
    setLoading(true);
    setStatus("Buscando por ubicación…");

    const resp = await fetchWeatherByCoordsFromBackend(
      lat,
      lon,
      controller.signal
    );
    const place =
      resp.place || (await getPlaceFromCoords(lat, lon, controller.signal));
    const data = { current: resp.current, daily: resp.daily };

    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`.toLowerCase();
    cache.set(key, { place, data });
    cache.set(place.toLowerCase(), { place, data });

    lastResult = { place, lat, lon };
    render(place, data);
    addToHistory(place);
    renderRecentFromHistory();
    setStatus("");
    setFavButtonFor(place); // 👈 nuevo
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "No se pudo obtener tu ubicación", "error");
    if (!hasSearched) {
      currentEl.hidden = true;
      dailyEl.hidden = true;
    }
  } finally {
    setLoading(false);
  }
}

/* ============================
   RECIENTES (cards)
============================ */
function splitPlace(place) {
  const parts = place.split(",").map((s) => s.trim());
  return {
    city: parts[0] || place,
    region: parts[1] || "",
    country: parts[2] || parts[1] || "",
  };
}
function renderRecentFromHistory() {
  if (!recentEl) return;
  const list = getHistory();
  if (!list.length) {
    recentEl.innerHTML = "";
    return;
  }
  const top = list.slice(0, 4);
  recentEl.innerHTML = top
    .map((place) => {
      const key = place.toLowerCase();
      const cached = cache.get(key);
      const { city, country } = splitPlace(place);
      let tempHtml = `<span class="rc-temp">—</span>`;
      let metaHtml = `<span class="rc-meta">RealFeel —</span>`;
      let icon = "⛅";
      if (cached?.data?.current) {
        const cur = cached.data.current;
        tempHtml = `<span class="rc-temp">${asTemp(cur.temperature_2m)}</span>`;
        metaHtml = `<span class="rc-meta">RealFeel ${asTemp(
          cur.apparent_temperature
        )}</span>`;
        icon = WMO_ICON(cur.weather_code);
      }
      return `
        <article class="recent-card" data-city="${place}">
          <h4 class="rc-title">${city}</h4>
          <div class="rc-sub">${country}</div>
          <div class="rc-row">
            <span class="emoji" aria-hidden="true">${icon}</span>
            ${tempHtml}
          </div>
          <div>${metaHtml}</div>
        </article>`;
    })
    .join("");
}
recentEl?.addEventListener("click", (e) => {
  const card = e.target.closest(".recent-card");
  if (!card) return;
  input.value = card.dataset.city;
  searchCity(input.value);
});

/* ============================
   GEO (permiso + intento único)
============================ */
function getGeoPref() {
  return localStorage.getItem(GEO_PREF_KEY) || "";
}
function setGeoPref(v) {
  localStorage.setItem(GEO_PREF_KEY, v);
}

async function tryGeolocateOnce() {
  if (!("geolocation" in navigator)) return false;

  const pref = getGeoPref();
  if (pref === "denied") return false;

  setStatus("Obteniendo tu ubicación…");

  try {
    const pos = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timeout")), 10000);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          clearTimeout(to);
          resolve(p);
        },
        (e) => {
          clearTimeout(to);
          reject(e);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    });

    setGeoPref("granted");
    await searchByCoords(pos.coords.latitude, pos.coords.longitude);
    return true;
  } catch (e) {
    setGeoPref("denied");
    setStatus(
      "No se pudo usar tu ubicación (permiso denegado o tiempo agotado).",
      "error"
    );
    if (!hasSearched) {
      currentEl.hidden = true;
      dailyEl.hidden = true;
    }
    return false;
  }
}

function loadLastHistoryFallback() {
  const list = getHistory();
  const last =
    Array.isArray(list) && list[0]
      ? typeof list[0] === "string"
        ? list[0]
        : list[0].place
      : "";
  if (last) {
    input.value = last;
    searchCity(last);
    return true;
  }
  return false;
}

/* ============================
   EVENTOS + INIT
============================ */
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (input.value.trim()) searchCity(input.value);
});
const debounced = debounce(() => {
  if (document.activeElement === input) return;
  if (input.value.trim()) searchCity(input.value);
}, 600);
input?.addEventListener("change", () => {
  if (input.value.trim()) searchCity(input.value);
});
input?.addEventListener("keyup", debounced);

if (unitCBtn && unitFBtn) {
  const reRenderFromInput = () => {
    const k = input.value.trim().toLowerCase();
    const cached =
      cache.get(k) || cache.get((cache.get(k)?.place || "").toLowerCase());
    if (cached) render(cached.place, cached.data);
    renderRecentFromHistory();
  };
  unitCBtn.addEventListener("click", () => {
    state.unit = "C";
    localStorage.setItem("unit", "C");
    updateUnitButtons();
    reRenderFromInput();
  });
  unitFBtn.addEventListener("click", () => {
    state.unit = "F";
    localStorage.setItem("unit", "F");
    updateUnitButtons();
    reRenderFromInput();
  });
}
/* =========================================================
   FAVORITOS (DB vía backend)
   ========================================================= */

async function renderFavorites() {
  if (!favsEl) return;
  try {
    const res = await fetchJSON(`${BACKEND_URL}/favorites`);
    if (!Array.isArray(res) || !res.length) {
      favsEl.innerHTML = "<p class='muted'>No tenés favoritos guardados.</p>";
      return;
    }

    favsEl.innerHTML = res
      .map(
        (f) => `
        <article class="recent-card" data-city="${f.city}" data-lat="${
          f.lat
        }" data-lon="${f.lon}">
          <h4 class="rc-title">${f.city}</h4>
          <div class="rc-sub">${f.country || ""}</div>
          <div class="rc-row">
            <span class="emoji">⭐</span>
            <span class="rc-temp">${f.lat.toFixed(2)}, ${f.lon.toFixed(
          2
        )}</span>
          </div>
          <div class="rc-meta">Agregado: ${new Date(
            f.created_at
          ).toLocaleDateString("es-AR")}</div>
        </article>
      `
      )
      .join("");
  } catch (e) {
    favsEl.innerHTML = `<p class="status error">${e.message}</p>`;
  }
}

// Click en tarjeta de favoritos → buscar esa ciudad
favsEl?.addEventListener("click", (e) => {
  const card = e.target.closest(".recent-card");
  if (!card) return;
  input.value = card.dataset.city;
  searchCity(input.value);
});

// Inicio
updateUnitButtons();
renderHistory();
renderRecentFromHistory();
setStatus("Escribí una ciudad y presioná Buscar.");

(async () => {
  const usedGeo = await tryGeolocateOnce();
  if (!usedGeo) loadLastHistoryFallback();
})();
