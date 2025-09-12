// main.js — versión saneada

/* ============================
   CONFIG + ESTADO
============================ */
const BACKEND_URL = "http://localhost:3000";

const state = {
  unit: localStorage.getItem("unit") || "C",   // 'C' | 'F'
  currentPlace: "",                            // "Ciudad, Región, País"
  lastCoords: { lat: null, lon: null }         // coords del último resultado
};

const GEO_PREF_KEY = "geo-consent";            // 'granted' | 'denied'
let hasSearched = false;                       // para ocultar/mostrar al inicio
let lastResult = null;                         // { place, lat, lon }

/* ============================
   FORMATTERS + UTILS
============================ */
const nf1     = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });
const nf0     = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nfPerc0 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nf1raw  = (n) => (Math.round(n * 10) / 10).toString();

const toF = (c) => (c * 9) / 5 + 32;
const kmhToMph = (k) => k * 0.621371;

const asTemp = (n) =>
  state.unit === "C" ? `${nf1.format(n)}°C` : `${nf1.format(toF(n))}°F`;
const asWind = (kmh) =>
  state.unit === "C" ? `${nf0.format(kmh)} km/h` : `${nf0.format(kmhToMph(kmh))} mph`;

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

const cache = new Map(); // clave: ciudad o "lat,lon"

/* ============================
   DOM
============================ */
const form      = document.getElementById("search-form");
const input     = document.getElementById("city");
const loader    = document.getElementById("loader");
const statusEl  = document.getElementById("status");
const currentEl = document.getElementById("current");
const dailyEl   = document.getElementById("daily");
const unitCBtn  = document.getElementById("unit-c");
const unitFBtn  = document.getElementById("unit-f");
const historyEl = document.getElementById("history");
const recentEl  = document.getElementById("recent");
const favBtn    = document.getElementById("btn-fav");
const favsEl    = document.getElementById("favs");

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
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); };
}

/* ============================
   HTTP HELPERS
============================ */
async function fetchJSON(url, { signal, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);

  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      // <- NUEVO: intentamos leer el cuerpo para mostrar el mensaje real
      let msg = res.statusText || `Error ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    if (!navigator.onLine) throw new Error("Estás sin conexión. Verificá tu internet.");
    if (e.name === "AbortError" || e.message === "timeout") throw e;
    throw new Error(e.message || "No se pudo conectar con el servidor.");
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

/* ============================
   BACKEND API
============================ */
function apiWeatherByCity(city, signal) {
  return fetchJSON(`${BACKEND_URL}/weather?city=${encodeURIComponent(city)}`, { signal });
}
function apiWeatherByCoords(lat, lon, signal) {
  return fetchJSON(`${BACKEND_URL}/weather/coords?lat=${lat}&lon=${lon}`, { signal });
}
function apiListFavorites(signal) {
  return fetchJSON(`${BACKEND_URL}/favorites`, { signal });
}
function apiToggleFavorite({ city, lat, lon }, signal) {
  return postJSON(`${BACKEND_URL}/favorites/toggle`, { city, lat, lon }, { signal });
}

/* ============================
   REVERSE GEOCODING (fallback)
============================ */
async function getPlaceFromCoords(lat, lon, signal) {
  try {
    const u = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=es`;
    const d = await fetchJSON(u, { signal });
    const city    = d.city || d.locality || d.principalSubdivision || "";
    const region  = d.principalSubdivision || "";
    const country = d.countryName || "";
    const place   = [city, region, country].filter(Boolean).join(", ");
    if (place) return place;
  } catch {}
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const d = await fetchJSON(u, { signal });
    const a = d.address || {};
    const city    = a.city || a.town || a.village || a.hamlet || "";
    const region  = a.state || a.region || "";
    const country = a.country || "";
    const place   = [city, region, country].filter(Boolean).join(", ");
    if (place) return place;
  } catch {}
  return `(${lat.toFixed(2)}, ${lon.toFixed(2)})`;
}

/* ============================
   HISTORIAL (localStorage)
============================ */
const HISTORY_KEY = "city-history";
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? []; }
  catch { return []; }
}
function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}
function renderHistory() {
  if (!historyEl) return;
  const list = getHistory();
  historyEl.innerHTML = list.length
    ? list.map(c => `<button type="button" data-city="${c}">${c}</button>`).join("")
    : "";
}
function addToHistory(city) {
  const key = city.trim(); if (!key) return;
  let list = getHistory().filter(c => c.toLowerCase() !== key.toLowerCase());
  list.unshift(key); list = list.slice(0, 5);
  saveHistory(list); renderHistory();
}
historyEl?.addEventListener("click", e => {
  const btn = e.target.closest("button[data-city]"); if (!btn) return;
  input.value = btn.dataset.city; searchCity(input.value);
});

/* ============================
   FAVORITOS (UI)
============================ */
async function refreshFavoritesUI() {
  if (!favsEl) return;
  try {
    const list = await apiListFavorites();
    favsEl.innerHTML = !list.length
      ? ""
      : list.map(f => `
          <button type="button" class="fav-chip" data-city="${f.city}">
            ★ ${f.city}
          </button>
        `).join("");
  } catch {/* ignore */}
}
favsEl?.addEventListener("click", e => {
  const btn = e.target.closest(".fav-chip"); if (!btn) return;
  input.value = btn.dataset.city; searchCity(input.value);
});
async function setFavButtonFor(place) {
  if (!favBtn) return;
  if (!place) { favBtn.hidden = true; return; }
  favBtn.hidden = false;
  try {
    const list = await apiListFavorites();
    const isFav = list.some(f => (f.city || "").toLowerCase() === place.toLowerCase());
    favBtn.textContent = isFav ? "★ Favorito" : "☆ Favorito";
    favBtn.classList.toggle("active", isFav);
  } catch {
    favBtn.textContent = "☆ Favorito";
    favBtn.classList.remove("active");
  }
}
favBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
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
});

/* ============================
   RENDER
============================ */
function renderCurrent(el, place, current) {
  const items = [
    { label: "Temperatura", val: asTemp(current.temperature_2m) },
    { label: "Sensación",   val: asTemp(current.apparent_temperature) },
    { label: "Viento",      val: asWind(current.wind_speed_10m) },
  ];
  if (typeof current.relative_humidity_2m === "number")
    items.push({ label: "Humedad", val: `${nfPerc0.format(current.relative_humidity_2m)}%` });
  if (typeof current.precipitation === "number")
    items.push({ label: "Precipitación", val: `${nf1raw(current.precipitation)} mm` });
  if (typeof current.pressure_msl === "number")
    items.push({ label: "Presión", val: `${nf0.format(current.pressure_msl)} hPa` });

  el.innerHTML = `
    <div class="row" style="justify-content: space-between;">
      <div>
        <h2 class="place">${place}</h2>
        <div class="muted">${new Date().toLocaleString("es-AR")}</div>
      </div>
      <div class="emoji" aria-hidden="true">${WMO_ICON(current.weather_code)}</div>
    </div>
    <div class="kv">
      ${items.map(({label,val}) => `
        <div>
          <div class="label">${label}</div>
          <div class="${label === "Temperatura" || label === "Sensación" ? "big" : ""}">${val}</div>
        </div>`).join("")}
    </div>`;
}
function renderDaily(el, daily) {
  const days = daily.time.slice(0, 5).map((date, i) => ({
    date,
    tmax: daily.temperature_2m_max[i],
    tmin: daily.temperature_2m_min[i],
    code: daily.weather_code[i],
    pprob: daily.precipitation_probability_max?.[i],
    psum:  daily.precipitation_sum?.[i]
  }));
  el.innerHTML = days.map(d => `
    <article class="day">
      <div class="row" style="justify-content: space-between;">
        <strong>${new Date(d.date).toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" })}</strong>
        <span class="emoji" aria-hidden="true">${WMO_ICON(d.code)}</span>
      </div>
      <div class="row" style="justify-content: space-between; margin-top:8px;">
        <span class="muted">Mín</span><span>${asTemp(d.tmin)}</span>
      </div>
      <div class="row" style="justify-content: space-between;">
        <span class="muted">Máx</span><span>${asTemp(d.tmax)}</span>
      </div>
      ${typeof d.pprob === "number" ? `
        <div class="row" style="justify-content: space-between;">
          <span class="muted">Lluvia (prob.)</span><span>${nfPerc0.format(d.pprob)}%</span>
        </div>` : ""}
      ${typeof d.psum === "number" ? `
        <div class="row" style="justify-content: space-between;">
          <span class="muted">Lluvia (acum.)</span><span>${nf1raw(d.psum)} mm</span>
        </div>` : ""}
    </article>`).join("");
}
function render(place, data) {
  state.currentPlace = place;
  currentEl.hidden = false;
  dailyEl.hidden = false;
  renderCurrent(currentEl, place, data.current);
  renderDaily(dailyEl, data.daily);
}

/* ============================
   BÚSQUEDA
============================ */
let controller; // AbortController

async function searchCity(city) {
  const key = (city || "").trim().toLowerCase();
  if (!key) return;
  hasSearched = true;

  // cache
  if (cache.has(key)) {
    const { place, data } = cache.get(key);
    cache.set(place.toLowerCase(), { place, data });
    render(place, data);
    addToHistory(place);
    renderRecentFromHistory();
    setStatus("");
    await setFavButtonFor(place);
    return;
  }

  controller?.abort();
  controller = new AbortController();
  try {
    setLoading(true);
    setStatus("Buscando…");
    const resp = await apiWeatherByCity(key, controller.signal);

    const place = resp.place;
    const data  = { current: resp.current, daily: resp.daily };

    cache.set(key, { place, data });
    cache.set(place.toLowerCase(), { place, data });

    lastResult = { place, lat: resp.lat ?? null, lon: resp.lon ?? null };
    state.lastCoords = { lat: lastResult.lat, lon: lastResult.lon };

    render(place, data);
    addToHistory(place);
    renderRecentFromHistory();
    setStatus("");
    await setFavButtonFor(place);
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "Ocurrió un error", "error");
    currentEl.hidden = true; dailyEl.hidden = true;
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

    const resp  = await apiWeatherByCoords(lat, lon, controller.signal);
    const place = resp.place || (await getPlaceFromCoords(lat, lon, controller.signal));
    const data  = { current: resp.current, daily: resp.daily };

    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`.toLowerCase();
    cache.set(key, { place, data });
    cache.set(place.toLowerCase(), { place, data });

    lastResult = { place, lat, lon };
    state.lastCoords = { lat, lon };

    render(place, data);
    addToHistory(place);
    renderRecentFromHistory();
    setStatus("");
    await setFavButtonFor(place);
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "No se pudo obtener tu ubicación", "error");
    if (!hasSearched) { currentEl.hidden = true; dailyEl.hidden = true; }
  } finally {
    setLoading(false);
  }
}

/* ============================
   RECIENTES (cards)
============================ */
function splitPlace(place) {
  const parts = place.split(",").map(s => s.trim());
  return { city: parts[0] || place, region: parts[1] || "", country: parts[2] || parts[1] || "" };
}
function renderRecentFromHistory() {
  if (!recentEl) return;
  const list = getHistory();
  if (!list.length) { recentEl.innerHTML = ""; return; }
  const top = list.slice(0, 4);
  recentEl.innerHTML = top.map(place => {
    const key    = place.toLowerCase();
    const cached = cache.get(key);
    const { city, country } = splitPlace(place);
    let temp = `<span class="rc-temp">—</span>`;
    let meta = `<span class="rc-meta">RealFeel —</span>`;
    let icon = "⛅";
    if (cached?.data?.current) {
      const cur = cached.data.current;
      temp = `<span class="rc-temp">${asTemp(cur.temperature_2m)}</span>`;
      meta = `<span class="rc-meta">RealFeel ${asTemp(cur.apparent_temperature)}</span>`;
      icon = WMO_ICON(cur.weather_code);
    }
    return `
      <article class="recent-card" data-city="${place}">
        <h4 class="rc-title">${city}</h4>
        <div class="rc-sub">${country}</div>
        <div class="rc-row"><span class="emoji" aria-hidden="true">${icon}</span>${temp}</div>
        <div>${meta}</div>
      </article>`;
  }).join("");
}
recentEl?.addEventListener("click", e => {
  const card = e.target.closest(".recent-card"); if (!card) return;
  input.value = card.dataset.city; searchCity(input.value);
});

/* ============================
   GEO (1 intento)
============================ */
function getGeoPref() { return localStorage.getItem(GEO_PREF_KEY) || ""; }
function setGeoPref(v) { localStorage.setItem(GEO_PREF_KEY, v); }

async function tryGeolocateOnce() {
  if (!("geolocation" in navigator)) return false;
  if (getGeoPref() === "denied") return false;

  setStatus("Obteniendo tu ubicación…");
  try {
    const pos = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 10000);
      navigator.geolocation.getCurrentPosition(
        p => { clearTimeout(t); res(p); },
        e => { clearTimeout(t); rej(e); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    });
    setGeoPref("granted");
    await searchByCoords(pos.coords.latitude, pos.coords.longitude);
    return true;
  } catch (e) {
    setGeoPref("denied");
    setStatus("No se pudo usar tu ubicación (permiso denegado o tiempo agotado).", "error");
    if (!hasSearched) { currentEl.hidden = true; dailyEl.hidden = true; }
    return false;
  }
}
function loadLastHistoryFallback() {
  const list = getHistory();
  const last = Array.isArray(list) && list[0] ? list[0] : "";
  if (last) { input.value = last; searchCity(last); return true; }
  return false;
}

/* ============================
   EVENTOS + INIT
============================ */
form?.addEventListener("submit", e => {
  e.preventDefault();
  if (input.value.trim()) searchCity(input.value);
});
const debounced = debounce(() => {
  if (document.activeElement === input) return;
  if (input.value.trim()) searchCity(input.value);
}, 600);
input?.addEventListener("change", () => input.value.trim() && searchCity(input.value));
input?.addEventListener("keyup", debounced);

if (unitCBtn && unitFBtn) {
  const reRender = () => {
    const k = input.value.trim().toLowerCase();
    const c = cache.get(k) || cache.get((cache.get(k)?.place || "").toLowerCase());
    if (c) render(c.place, c.data);
    renderRecentFromHistory();
  };
  unitCBtn.addEventListener("click", () => {
    state.unit = "C"; localStorage.setItem("unit", "C"); updateUnitButtons(); reRender();
  });
  unitFBtn.addEventListener("click", () => {
    state.unit = "F"; localStorage.setItem("unit", "F"); updateUnitButtons(); reRender();
  });
}

// Inicio
updateUnitButtons();
renderHistory();
renderRecentFromHistory();
setStatus("Escribí una ciudad y presioná Buscar.");

(async () => { try { await refreshFavoritesUI(); } catch {} })();
(async () => { const used = await tryGeolocateOnce(); if (!used) loadLastHistoryFallback(); })();
