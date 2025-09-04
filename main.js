/* =========================================================
   ESTADO GLOBAL, FORMATTERS Y UTILIDADES
   ========================================================= */

// Persistimos unidad seleccionada (°C por defecto)
const state = {
  unit: localStorage.getItem('unit') || 'C', // 'C' o 'F'
};

// Formatters de números
const nf1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

// Conversión de unidades
const toF = (c) => (c * 9) / 5 + 32;
const kmhToMph = (k) => k * 0.621371;

/** Formatea temperatura según unidad */
function asTemp(n) {
  return state.unit === 'C' ? `${nf1.format(n)}°C` : `${nf1.format(toF(n))}°F`;
}
/** Formatea viento según unidad */
function asWind(kmh) {
  return state.unit === 'C' ? `${nf0.format(kmh)} km/h` : `${nf0.format(kmhToMph(kmh))} mph`;
}

/** Debounce simple para inputs */
function debounce(fn, delay = 400) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

/** Mapa simple de códigos WMO -> emojis (podés reemplazar por íconos SVG) */
const WMO_ICON = (code) => {
  if (code === 0) return '☀️';
  if (code >= 1 && code <= 3) return '⛅';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '🌨️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code === 85 || code === 86) return '❄️';
  if (code === 95 || code === 96 || code === 99) return '⛈️';
  return '🌤️';
};

// Cache de respuestas crudas (en °C y km/h, tal como devuelve Open-Meteo)
const cache = new Map();

/* =========================================================
   SELECTORES DEL DOM
   ========================================================= */
const form = document.getElementById('search-form');
const input = document.getElementById('city');
const loader = document.getElementById('loader');
const statusEl = document.getElementById('status');
const currentEl = document.getElementById('current');
const dailyEl = document.getElementById('daily');

// Botones de unidad
const unitCBtn = document.getElementById('unit-c');
const unitFBtn = document.getElementById('unit-f');

// Historial
const HISTORY_KEY = 'city-history';
const historyEl = document.getElementById('history');

/* =========================================================
   FUNCIONES DE UI (estado de carga / mensajes / botones)
   ========================================================= */
function setLoading(isLoading) {
  loader.hidden = !isLoading;
}

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg || '';
  statusEl.className = 'status ' + (type === 'error' ? 'error' : 'info');
}

function updateUnitButtons() {
  const isC = state.unit === 'C';
  if (unitCBtn && unitFBtn) {
    unitCBtn.setAttribute('aria-pressed', String(isC));
    unitFBtn.setAttribute('aria-pressed', String(!isC));
    unitCBtn.disabled = isC;
    unitFBtn.disabled = !isC;
  }
}

/* =========================================================
   HISTORIAL (localStorage)
   ========================================================= */
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
  if (!list.length) { historyEl.innerHTML = ''; return; }
  historyEl.innerHTML = list
    .map(c => `<button type="button" data-city="${c}">${c}</button>`)
    .join('');
}
function addToHistory(city) {
  const key = city.trim();
  if (!key) return;
  let list = getHistory().filter(c => c.toLowerCase() !== key.toLowerCase());
  list.unshift(key);       // al principio
  list = list.slice(0, 5); // límite 5
  saveHistory(list);
  renderHistory();
}

// Click en botón del historial
historyEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-city]');
  if (!btn) return;
  input.value = btn.dataset.city;
  searchCity(input.value);
});

/* =========================================================
   LLAMADAS A API (geocoding + forecast)
   ========================================================= */
async function geocodeCity(city, signal) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('No se pudo geocodificar la ciudad');
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error('Ciudad no encontrada');
  const { latitude, longitude, name, country, admin1 } = data.results[0];
  return { latitude, longitude, place: [name, admin1, country].filter(Boolean).join(', ') };
}

async function fetchForecast({ latitude, longitude }, signal) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=America%2FArgentina%2FBuenos_Aires`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('No se pudo cargar el pronóstico');
  return res.json();
}

/* =========================================================
   RENDERIZADO DE UI (clima actual + pronóstico diario)
   ========================================================= */
function renderCurrent(el, place, current) {
  el.innerHTML = `
    <div class="row" style="justify-content: space-between;">
      <div>
        <h2 class="place">${place}</h2>
        <div class="muted">${new Date().toLocaleString('es-AR')}</div>
      </div>
      <div class="emoji" aria-hidden="true">${WMO_ICON(current.weather_code)}</div>
    </div>
    <div class="kv">
      <div>
        <div class="label">Temperatura</div>
        <div class="big">${asTemp(current.temperature_2m)}</div>
      </div>
      <div>
        <div class="label">Sensación</div>
        <div class="big">${asTemp(current.apparent_temperature)}</div>
      </div>
      <div>
        <div class="label">Viento</div>
        <div>${asWind(current.wind_speed_10m)}</div>
      </div>
      <div>
        <div class="label">Código</div>
        <div>${current.weather_code}</div>
      </div>
    </div>
  `;
}

function renderDaily(el, daily) {
  const days = daily.time.slice(0, 5).map((date, i) => ({
    date,
    tmax: daily.temperature_2m_max[i],
    tmin: daily.temperature_2m_min[i],
    code: daily.weather_code[i],
  }));

  el.innerHTML = days.map(d => `
    <article class="day">
      <div class="row" style="justify-content: space-between;">
        <strong>${new Date(d.date).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</strong>
        <span class="emoji" aria-hidden="true">${WMO_ICON(d.code)}</span>
      </div>
      <div class="row" style="justify-content: space-between; margin-top:8px;">
        <span class="muted">Mín</span><span>${asTemp(d.tmin)}</span>
      </div>
      <div class="row" style="justify-content: space-between;">
        <span class="muted">Máx</span><span>${asTemp(d.tmax)}</span>
      </div>
    </article>
  `).join('');
}

function render(place, data) {
  currentEl.hidden = false;
  dailyEl.hidden = false;
  renderCurrent(currentEl, place, data.current);
  renderDaily(dailyEl, data.daily);
}

/* =========================================================
   LÓGICA DE BÚSQUEDA / EVENT LOOP
   ========================================================= */
let controller; // AbortController para cancelar requests en curso

async function searchCity(city) {
  const key = city.trim().toLowerCase();
  if (!key) return;

  // Si ya existe en cache, evitamos pedir de nuevo
  if (cache.has(key)) {
    const { place, data } = cache.get(key);
    render(place, data);
    addToHistory(place);  // <<--- importante: también desde cache
    setStatus('');
    return;
  }

  // Cancelamos cualquier request anterior en curso
  controller?.abort();
  controller = new AbortController();

  try {
    setLoading(true);
    setStatus('Buscando…');
    const geo = await geocodeCity(key, controller.signal);
    const data = await fetchForecast(geo, controller.signal);
    cache.set(key, { place: geo.place, data }); // guardamos en cache
    render(geo.place, data);
    addToHistory(geo.place); // <<--- importante: al completar fetch OK
    setStatus('');
  } catch (err) {
    if (err.name === 'AbortError') return; // se canceló por una nueva búsqueda
    setStatus(err.message || 'Ocurrió un error', 'error');
    currentEl.hidden = true;
    dailyEl.hidden = true;
  } finally {
    setLoading(false);
  }
}

/* =========================================================
   EVENTOS DEL FORM / INPUT / TOGGLE UNIDADES
   ========================================================= */

// Enviar form = buscar
form.addEventListener('submit', (e) => {
  e.preventDefault();
  searchCity(input.value);
});

// Búsqueda reactiva con debounce (no dispara si el input está en foco escribiendo)
const debounced = debounce(() => {
  if (document.activeElement === input) return;
  searchCity(input.value);
}, 600);

input.addEventListener('change', () => searchCity(input.value));
input.addEventListener('keyup', debounced);

// Toggle de unidades (°C / °F) con persistencia y re-render
if (unitCBtn && unitFBtn) {
  unitCBtn.addEventListener('click', () => {
    state.unit = 'C';
    localStorage.setItem('unit', 'C');
    updateUnitButtons();
    const cached = cache.get(input.value.trim().toLowerCase());
    if (cached) render(cached.place, cached.data);
  });

  unitFBtn.addEventListener('click', () => {
    state.unit = 'F';
    localStorage.setItem('unit', 'F');
    updateUnitButtons();
    const cached = cache.get(input.value.trim().toLowerCase());
    if (cached) render(cached.place, cached.data);
  });
}

/* =========================================================
   INICIALIZACIÓN
   ========================================================= */
updateUnitButtons();                    // refleja unidad guardada
renderHistory();                        // pinta historial guardado (si hay)
setStatus('Escribí una ciudad y presioná Buscar.'); // mensaje inicial
