import './style.css';

const app = document.querySelector('#app');
const navigation = [
  { id: 'overview', label: 'Overview', icon: '▦' },
  { id: 'map', label: 'Web-GIS Map', icon: '⌖' },
  { id: 'spatial', label: 'Spatial Analysis', icon: '◈' },
  { id: 'clearances', label: 'Location Clearance', icon: '▤' },
  { id: 'projects', label: 'Program Monitoring', icon: '▥' },
  { id: 'verification', label: 'QR Field Verification', icon: '▧' },
];

const state = {
  token: localStorage.getItem('mapangat_token') || '',
  refreshToken: localStorage.getItem('mapangat_refresh_token') || '',
  user: JSON.parse(localStorage.getItem('mapangat_user') || 'null'),
  baseUrl: import.meta.env.VITE_API_BASE_URL || '',
  activeView: 'overview',
  data: null,
  dataRequest: null,
  map: null,
  mapLayers: null,
  viewRequest: 0,
};

const pageDetails = {
  overview: ['Municipal overview', 'A quick view of location-clearance activity and the municipal project portfolio.'],
  map: ['Web-GIS Map', 'Explore clearance sites and municipal project locations.'],
  spatial: ['Spatial Intelligence & Analysis', 'Review the planning layers available for preliminary site screening.'],
  clearances: ['Location Clearance', 'Register and track development-location clearance applications.'],
  projects: ['Program & Project Monitoring', 'Track implementation progress and upcoming field inspections.'],
  verification: ['QR Field Verification', 'Look up a permit or project record for field verification.'],
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatDate(value) {
  if (!value) return 'Not scheduled';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? 'Not scheduled'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'approved' || normalized === 'on track') return 'success';
  if (normalized === 'for review' || normalized === 'under review') return 'info';
  if (normalized === 'delayed' || normalized === 'needs info' || normalized === 'rejected') return 'danger';
  if (normalized === 'at risk' || normalized === 'pending') return 'warning';
  return 'neutral';
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 180).replace(/\s+/g, ' ');
    throw new Error(`The server returned an invalid response: ${snippet || 'empty response'}`);
  }
}

async function refreshAccessToken() {
  if (!state.refreshToken) return false;
  const response = await fetch(`${state.baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: state.refreshToken }),
  });
  const result = await parseJsonResponse(response);
  if (!response.ok) return false;
  state.token = result.tokens.access_token;
  state.refreshToken = result.tokens.refresh_token;
  localStorage.setItem('mapangat_token', state.token);
  localStorage.setItem('mapangat_refresh_token', state.refreshToken);
  return true;
}

async function apiFetch(path, retry = true) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${state.token}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401 && retry && await refreshAccessToken()) {
    return apiFetch(path, false);
  }

  const result = await parseJsonResponse(response);
  if (response.status === 401) {
    logout();
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

async function loadDashboardData(force = false) {
  if (state.data && !force) return state.data;
  if (state.dataRequest && !force) return state.dataRequest;

  state.dataRequest = Promise.all([
    apiFetch('/api/projects'),
    apiFetch('/api/clearances'),
  ]).then(([projectResult, clearanceResult]) => {
    const projects = projectResult.projects || [];
    const clearances = clearanceResult.clearances || [];
    const countStatus = (records, values) => records.filter((record) => values.includes(String(record.status || '').toLowerCase())).length;

    state.data = {
      counts: {
        projects_total: projects.length,
        projects_on_track: countStatus(projects, ['on track']),
        projects_at_risk: countStatus(projects, ['at risk']),
        projects_delayed: countStatus(projects, ['delayed']),
        clearance_pending: countStatus(clearances, ['pending']),
        clearance_review: countStatus(clearances, ['for review', 'under review']),
        clearance_approved: countStatus(clearances, ['approved']),
      },
      projects,
      clearances,
    };
    return state.data;
  }).finally(() => {
    state.dataRequest = null;
  });

  return state.dataRequest;
}

function renderLogin(errorMessage = '') {
  destroyMap();
  app.innerHTML = `
    <main class="auth-shell">
      <section class="auth-card">
        <div class="brand">
          <div class="brand-badge">M</div>
          <div><h1>MapAngat</h1><p>MPDO · Baco, Oriental Mindoro</p></div>
        </div>
        <p class="auth-intro">Municipal spatial intelligence and program monitoring.</p>
        <form id="login-form" class="form-stack">
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="username" required>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button class="button button-primary" type="submit">Sign in</button>
        </form>
        <p id="login-message" class="form-message ${errorMessage ? 'error' : ''}" role="alert">${escapeHtml(errorMessage)}</p>
      </section>
    </main>
  `;

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const message = document.querySelector('#login-message');
    button.disabled = true;
    button.textContent = 'Signing in…';
    message.textContent = '';
    message.classList.remove('error');

    try {
      const response = await fetch(`${state.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.elements.username.value.trim(),
          password: form.elements.password.value,
        }),
      });
      const result = await parseJsonResponse(response);
      if (!response.ok) throw new Error(result.error || 'Unable to sign in.');

      state.token = result.tokens.access_token;
      state.refreshToken = result.tokens.refresh_token;
      state.user = result.user;
      state.data = null;
      localStorage.setItem('mapangat_token', state.token);
      localStorage.setItem('mapangat_refresh_token', state.refreshToken);
      localStorage.setItem('mapangat_user', JSON.stringify(state.user));
      renderDashboard();
    } catch (error) {
      message.textContent = error.message || 'Unable to reach the backend.';
      message.classList.add('error');
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}

function destroyMap() {
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.mapLayers = null;
  }
}

function renderDashboard() {
  app.innerHTML = `
    <div class="dashboard-shell">
      <aside class="sidebar">
        <a class="brand sidebar-brand" href="#" aria-label="MapAngat home">
          <span class="brand-badge">M</span>
          <span><strong>MapAngat</strong><small>MPDO · Baco, Oriental Mindoro</small></span>
        </a>
        <p class="sidebar-label">WORKSPACE</p>
        <nav class="navigation" aria-label="Main navigation">
          ${navigation.map(({ id, label, icon }) => `
            <button type="button" class="nav-button ${id === state.activeView ? 'active' : ''}" data-view="${id}">
              <span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span>
            </button>
          `).join('')}
        </nav>
        <div class="sidebar-footer">
          <span class="avatar">${escapeHtml((state.user?.username || 'A').slice(0, 1).toUpperCase())}</span>
          <span class="user-summary"><small>Signed in as</small><strong>${escapeHtml(state.user?.username || 'Admin')}</strong></span>
          <button type="button" id="logout-button" class="logout-button" aria-label="Sign out" title="Sign out">↗</button>
        </div>
      </aside>
      <main class="main-shell">
        <header class="topbar">
          <div><span class="topbar-kicker">MUNICIPAL PLANNING &amp; DEVELOPMENT OFFICE</span><strong>MapAngat Spatial Intelligence</strong></div>
          <div class="topbar-user"><span>Welcome, ${escapeHtml(state.user?.username || 'Administrator')}</span><span class="avatar">${escapeHtml((state.user?.username || 'A').slice(0, 1).toUpperCase())}</span></div>
        </header>
        <section id="page-content" class="page-content" aria-live="polite"></section>
      </main>
    </div>
  `;

  document.querySelectorAll('.nav-button').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeView = button.dataset.view;
      document.querySelectorAll('.nav-button').forEach((item) => item.classList.toggle('active', item === button));
      renderView(state.activeView);
    });
  });
  document.querySelector('.sidebar-brand').addEventListener('click', (event) => {
    event.preventDefault();
    state.activeView = 'overview';
    document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === 'overview'));
    renderView('overview');
  });
  document.querySelector('#logout-button').addEventListener('click', logout);
  renderView(state.activeView);
}

function renderPageHeading(view, refresh = true) {
  const [title, description] = pageDetails[view];
  return `
    <div class="page-heading">
      <div><p class="eyebrow">${escapeHtml(view === 'map' ? 'MUNICIPAL GIS' : 'MAPANGAT WORKSPACE')}</p>
        <h1>${escapeHtml(title)}</h1><p class="page-description">${escapeHtml(description)}</p>
      </div>
      ${refresh ? '<button id="refresh-data" class="button button-outline" type="button"><span aria-hidden="true">↻</span> Refresh data</button>' : ''}
    </div>
  `;
}

function renderLoading(view) {
  const content = document.querySelector('#page-content');
  content.innerHTML = `${renderPageHeading(view)}<div class="loading-panel"><span class="spinner"></span><span>Loading MapAngat records…</span></div>`;
  document.querySelector('#refresh-data')?.addEventListener('click', () => renderView(view, true));
}

function renderError(view, error) {
  const content = document.querySelector('#page-content');
  content.innerHTML = `${renderPageHeading(view, false)}
    <section class="empty-state error-state" role="alert">
      <span class="empty-icon">!</span><h2>We couldn’t load the records</h2>
      <p>${escapeHtml(error.message || 'Check that the LavaLust backend is running on port 8000, then retry.')}</p>
      <button id="retry-data" class="button button-primary" type="button">Try again</button>
    </section>`;
  document.querySelector('#retry-data').addEventListener('click', () => renderView(view, true));
}

async function renderView(view, force = false) {
  if (view !== 'map') destroyMap();
  const requestId = ++state.viewRequest;
  renderLoading(view);

  try {
    const data = await loadDashboardData(force);
    if (requestId !== state.viewRequest) return;
    if (view === 'overview') renderOverview(data);
    else if (view === 'map') await renderMap(data, requestId);
    else if (view === 'clearances') renderClearances(data);
    else if (view === 'projects') renderProjects(data);
    else if (view === 'spatial') renderSpatialAnalysis();
    else if (view === 'verification') renderVerification(data);
    document.querySelector('#refresh-data')?.addEventListener('click', () => renderView(view, true));
  } catch (error) {
    if (requestId === state.viewRequest && state.user) renderError(view, error);
  }
}

function renderStatCard(label, value, icon, tone) {
  return `<article class="stat-card">
    <div><p>${escapeHtml(label)}</p><strong>${escapeHtml(value ?? 0)}</strong></div>
    <span class="stat-icon ${tone}" aria-hidden="true">${icon}</span>
  </article>`;
}

function renderStatus(status) {
  return `<span class="status-badge ${statusClass(status)}">${escapeHtml(status || 'Pending')}</span>`;
}

function renderOverview(data) {
  const { counts, clearances, projects } = data;
  const recentClearances = clearances.slice(0, 5);
  const activeProjects = projects.slice(0, 4);
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('overview')}
    <div class="stats-grid">
      ${renderStatCard('Total projects', counts.projects_total, '▥', 'blue')}
      ${renderStatCard('On track', counts.projects_on_track, '✓', 'green')}
      ${renderStatCard('Clearances pending', counts.clearance_pending, '◷', 'amber')}
      ${renderStatCard('At-risk projects', counts.projects_at_risk, '!', 'rose')}
    </div>
    <div class="content-grid overview-grid">
      <section class="panel">
        <div class="panel-heading"><div><h2>Recent clearance applications</h2><p>Latest activity in the application register</p></div><button class="text-button" data-open-view="clearances">View all <span aria-hidden="true">→</span></button></div>
        ${renderClearanceTable(recentClearances, 'No recent clearance applications.', true)}
      </section>
      <section class="panel project-overview">
        <div class="panel-heading"><div><h2>Project portfolio</h2><p>Implementation progress and status</p></div><button class="text-button" data-open-view="projects">View all <span aria-hidden="true">→</span></button></div>
        ${activeProjects.length ? activeProjects.map((project) => `
          <article class="mini-project">
            <div class="mini-project-title"><strong>${escapeHtml(project.project_name)}</strong>${renderStatus(project.status)}</div>
            <p>${escapeHtml(project.barangay)} · Next inspection ${escapeHtml(formatDate(project.inspection_date))}</p>
            <div class="progress-row"><div class="progress-track"><span style="width:${Math.max(0, Math.min(100, Number(project.progress) || 0))}%"></span></div><strong>${escapeHtml(project.progress || 0)}%</strong></div>
          </article>`).join('') : '<p class="table-empty">No projects are available yet.</p>'}
      </section>
    </div>
    <div class="overview-footer"><span class="status-dot"></span> Data synced with the MapAngat API <span class="muted-separator">·</span> ${clearances.length} clearance records <span class="muted-separator">·</span> ${projects.length} projects</div>
  `;
  document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => {
    const view = button.dataset.openView;
    state.activeView = view;
    document.querySelectorAll('.nav-button').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === view));
    renderView(view);
  }));
}

function renderClearanceTable(rows, emptyMessage, compact = false) {
  return `<div class="table-wrap"><table class="data-table ${compact ? 'compact-table' : ''}">
    <thead><tr><th>Application ID</th><th>Applicant / project</th><th>Barangay</th><th>Submitted</th><th>Status</th></tr></thead>
    <tbody>${rows.length ? rows.map((row) => `
      <tr class="clearance-row" data-search="${escapeHtml(`${row.application_id} ${row.applicant_name} ${row.project_type} ${row.barangay}`.toLowerCase())}" data-status="${escapeHtml(row.status)}">
        <td class="table-id">${escapeHtml(row.application_id || 'N/A')}</td>
        <td><strong>${escapeHtml(row.applicant_name || 'N/A')}</strong><small>${escapeHtml(row.project_type || 'Location clearance')}</small></td>
        <td>${escapeHtml(row.barangay || 'N/A')}</td><td>${escapeHtml(formatDate(row.created_at))}</td><td>${renderStatus(row.status)}</td>
      </tr>`).join('') : `<tr><td class="table-empty" colspan="5">${escapeHtml(emptyMessage)}</td></tr>`}</tbody>
  </table></div>`;
}

function renderClearances(data) {
  const { clearances, counts } = data;
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('clearances')}
    <div class="stats-grid three-cards">
      ${renderStatCard('Pending', counts.clearance_pending, '◷', 'amber')}
      ${renderStatCard('For review', counts.clearance_review, '⌕', 'blue')}
      ${renderStatCard('Approved', counts.clearance_approved, '✓', 'green')}
    </div>
    <section class="panel">
      <div class="panel-heading panel-heading-wrap"><div><h2>Application register</h2><p>${clearances.length} application${clearances.length === 1 ? '' : 's'} in the register</p></div>
        <div class="table-filters"><input id="clearance-search" type="search" placeholder="Search ID, applicant, barangay" aria-label="Search clearance applications"><select id="clearance-status" aria-label="Filter by status"><option value="">All statuses</option><option>Pending</option><option>For review</option><option>Approved</option><option>Needs info</option><option>Rejected</option></select></div>
      </div>
      <div id="clearance-table">${renderClearanceTable(clearances, 'No applications have been submitted yet.')}</div>
    </section>`;

  const search = document.querySelector('#clearance-search');
  const status = document.querySelector('#clearance-status');
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    const chosenStatus = status.value.toLowerCase();
    document.querySelectorAll('#clearance-table .clearance-row').forEach((row) => {
      row.hidden = !(row.dataset.search.includes(query) && (!chosenStatus || row.dataset.status.toLowerCase() === chosenStatus));
    });
  };
  search.addEventListener('input', filter);
  status.addEventListener('change', filter);
}

function renderProjects(data) {
  const { projects, counts } = data;
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('projects')}
    <div class="stats-grid">
      ${renderStatCard('Total projects', counts.projects_total, '▥', 'blue')}
      ${renderStatCard('On track', counts.projects_on_track, '✓', 'green')}
      ${renderStatCard('At risk', counts.projects_at_risk, '!', 'amber')}
      ${renderStatCard('Delayed', counts.projects_delayed, '↘', 'rose')}
    </div>
    <section class="panel">
      <div class="panel-heading panel-heading-wrap"><div><h2>Active municipal projects</h2><p>Progress and upcoming inspection schedules</p></div>
        <select id="project-status-filter" aria-label="Filter projects by status"><option value="">All statuses</option><option>On track</option><option>At risk</option><option>Delayed</option></select>
      </div>
      <div id="project-list" class="project-list">
        ${projects.length ? projects.map((project) => `
          <article class="project-row" data-status="${escapeHtml(project.status)}">
            <div class="project-main">
              <div class="project-title"><h3>${escapeHtml(project.project_name)}</h3>${renderStatus(project.status)}</div>
              <p>${escapeHtml(project.barangay)} <span class="muted-separator">·</span> Municipal project</p>
              <div class="progress-row"><div class="progress-track"><span style="width:${Math.max(0, Math.min(100, Number(project.progress) || 0))}%"></span></div><strong>${escapeHtml(project.progress || 0)}%</strong></div>
            </div>
            <div class="inspection-date"><small>NEXT INSPECTION</small><strong>${escapeHtml(formatDate(project.inspection_date))}</strong></div>
          </article>`).join('') : '<p class="table-empty">No projects are available yet.</p>'}
      </div>
    </section>`;
  document.querySelector('#project-status-filter').addEventListener('change', (event) => {
    document.querySelectorAll('.project-row').forEach((row) => {
      row.hidden = Boolean(event.target.value) && row.dataset.status !== event.target.value;
    });
  });
}

async function renderMap(data, requestId) {
  const mapResult = await apiFetch('/api/map/points');
  if (requestId !== state.viewRequest) return;
  const points = (mapResult.points || []).map((point) => ({
    ...point,
    latitude: Number(point.lat),
    longitude: Number(point.lng),
  })).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && point.latitude !== 0 && point.longitude !== 0);
  const counts = {
    clearances: points.filter((point) => point.type === 'clearance').length,
    projects: points.filter((point) => point.type === 'project').length,
    permits: points.filter((point) => point.type === 'permit').length,
    reports: points.filter((point) => point.type === 'report').length,
  };

  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('map')}
    <form id="map-search-form" class="map-search-form">
      <label class="sr-only" for="map-search">Search locations</label>
      <input id="map-search" type="search" placeholder="Search a barangay or site">
      <button class="button button-primary" type="submit">Search</button>
    </form>
    <div class="map-layout">
      <section class="panel map-panel">
        <div class="map-panel-heading"><div><h2>Baco, Oriental Mindoro</h2><p>${points.length} mapped records · select a marker for details</p></div><span class="map-status"><i></i> Map ready</span></div>
        <div id="map" class="leaflet-map" role="application" aria-label="Map of municipal projects, permits, and hazard reports"></div>
      </section>
      <aside class="map-sidebar">
        <section class="panel map-control-panel">
          <h2>Map layers</h2><p class="panel-description">Toggle the location groups shown on the map.</p>
          <label class="layer-option"><input class="map-layer" type="checkbox" data-layer="clearances" checked><span class="legend-dot clearance-dot"></span><span>Location clearances</span><strong>${counts.clearances}</strong></label>
          <label class="layer-option"><input class="map-layer" type="checkbox" data-layer="projects" checked><span class="legend-dot project-dot"></span><span>Municipal projects</span><strong>${counts.projects}</strong></label>
          <label class="layer-option"><input class="map-layer" type="checkbox" data-layer="permits" checked><span class="legend-dot permit-dot"></span><span>Field permits</span><strong>${counts.permits}</strong></label>
          <label class="layer-option"><input class="map-layer" type="checkbox" data-layer="reports" checked><span class="legend-dot report-dot"></span><span>Hazard reports</span><strong>${counts.reports}</strong></label>
          <div class="legend-block"><h3>Map legend</h3><p><span class="legend-dot clearance-dot"></span> Clearance application</p><p><span class="legend-dot project-dot"></span> Municipal project</p><p><span class="legend-dot permit-dot"></span> Field compliance permit</p><p><span class="legend-dot report-dot"></span> Community hazard report</p></div>
        </section>
        <section class="panel visible-records"><h2>Mapped records</h2><p class="panel-description">${points.length} records have coordinates</p>
          ${points.length ? points.slice(0, 6).map((point) => `
            <article class="visible-record"><span class="record-bar ${point.type}"></span><div><strong>${escapeHtml(point.reference || point.name)}</strong><small>${escapeHtml(point.barangay)} · ${escapeHtml(point.status)}${point.severity ? ` · ${escapeHtml(point.severity)} severity` : ''}</small></div></article>`).join('') : '<p class="table-empty">No records have map coordinates yet.</p>'}
          <p class="map-disclaimer">Hazard markers represent community reports; confirm details with authorized personnel before acting on them.</p>
        </section>
      </aside>
    </div>`;

  if (requestId !== state.viewRequest) return;
  const [{ default: L }] = await Promise.all([
    import('leaflet/dist/leaflet.css').then(() => import('leaflet')),
  ]);
  if (requestId !== state.viewRequest || !document.querySelector('#map')) return;

  state.map = L.map('map').setView([13.3182, 121.2825], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);

  const layerColors = {
    clearance: '#2563eb',
    project: '#10b981',
    permit: '#7c3aed',
    report: '#dc2626',
  };
  state.mapLayers = {
    clearances: L.layerGroup().addTo(state.map),
    projects: L.layerGroup().addTo(state.map),
    permits: L.layerGroup().addTo(state.map),
    reports: L.layerGroup().addTo(state.map),
  };
  points.forEach((point) => {
    const layerName = `${point.type}s`;
    const layer = state.mapLayers[layerName];
    if (!layer) return;
    const color = layerColors[point.type];
    const marker = L.circleMarker([point.latitude, point.longitude], {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(layer);
    marker.bindPopup(`<strong>${escapeHtml(point.reference || point.name)}</strong><br>${escapeHtml(point.barangay)}<br>${escapeHtml(point.status)}${point.severity ? `<br>${escapeHtml(point.severity)} severity` : ''}`);
    point.marker = marker;
  });

  if (points.length > 1) {
    state.map.fitBounds(L.latLngBounds(points.map((point) => [point.latitude, point.longitude])).pad(0.15));
  } else if (points.length === 1) {
    state.map.setView([points[0].latitude, points[0].longitude], 14);
  }

  document.querySelectorAll('.map-layer').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const layer = state.mapLayers[checkbox.dataset.layer];
      if (checkbox.checked) state.map.addLayer(layer);
      else state.map.removeLayer(layer);
    });
  });

  document.querySelector('#map-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const search = document.querySelector('#map-search');
    const query = search.value.trim().toLowerCase();
    search.setCustomValidity('');
    const match = points.find((point) => `${point.name} ${point.reference || ''} ${point.barangay}`.toLowerCase().includes(query));
    if (match) {
      state.map.setView([match.latitude, match.longitude], 15);
      match.marker.openPopup();
    } else {
      search.setCustomValidity(query ? 'No mapped record matched that search.' : 'Enter a barangay or site to search.');
      search.reportValidity();
    }
  });
  state.map.invalidateSize();
}

function renderSpatialAnalysis() {
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('spatial', false)}
    <div class="content-grid spatial-grid">
      <section class="panel form-panel">
        <div class="panel-heading"><div><h2>Preliminary site check</h2><p>Enter a proposed site to review available screening layers.</p></div></div>
        <form id="screening-form" class="form-stack">
          <label for="screening-reference">Application / reference ID</label><input id="screening-reference" value="LC-NEW" required>
          <label for="screening-type">Proposed project type</label><select id="screening-type"><option>Residential development</option><option>Small commercial site</option><option>Roadside facility</option><option>Public infrastructure</option></select>
          <label for="screening-barangay">Barangay</label><select id="screening-barangay"><option>San Andres</option><option>Poblacion</option><option>Bangkatan</option><option>Lantuyang</option></select>
          <label for="screening-coordinates">Coordinates <span class="label-muted">(optional)</span></label><input id="screening-coordinates" placeholder="13.3182, 121.2825">
          <button class="button button-primary" type="submit">Review available layers</button>
        </form>
      </section>
      <section class="panel screening-panel"><div class="panel-heading"><div><h2>Screening decision support</h2><p>Available data coverage for the selected site</p></div></div>
        <div id="screening-results" class="screening-notice"><span class="empty-icon">i</span><p>Official zoning, hazard, and setback datasets are not connected to the API yet. This screen will not infer or present a permitting decision.</p></div>
      </section>
    </div>
    <section class="panel layer-catalog"><div class="panel-heading"><div><h2>Planning layers</h2><p>Data sources needed to enable municipal screening.</p></div></div>
      <div class="catalog-grid"><article><span class="catalog-icon blue">⌖</span><h3>CLUP zoning</h3><p>Land-use classification and zoning boundaries.</p><span class="dataset-state">Dataset not connected</span></article>
      <article><span class="catalog-icon cyan">≈</span><h3>Hazard exposure</h3><p>Verified flood and other hazard reference layers.</p><span class="dataset-state">Dataset not connected</span></article>
      <article><span class="catalog-icon amber">↔</span><h3>Setback buffers</h3><p>Mapped waterways, easements, and restrictions.</p><span class="dataset-state">Dataset not connected</span></article></div>
    </section>`;
  document.querySelector('#screening-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const reference = document.querySelector('#screening-reference').value.trim();
    document.querySelector('#screening-results').innerHTML = `<span class="empty-icon">i</span><p><strong>${escapeHtml(reference)}</strong> is recorded for review, but no official planning datasets are connected. Verify with authorized MPDO personnel before any decision.</p>`;
  });
}

function renderVerification(data) {
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('verification', false)}
    <div class="content-grid verification-grid">
      <section class="panel verification-panel"><div class="scan-placeholder"><span class="qr-icon">▧</span><h2>Find a permit or project</h2><p>Camera scanning is not connected. Enter a clearance application ID to retrieve its current record.</p></div>
        <form id="record-lookup" class="lookup-form"><label class="sr-only" for="record-code">Application ID</label><input id="record-code" placeholder="e.g. LC-2025-AD12F4" required><button class="button button-primary">Find record</button></form>
        <p id="lookup-feedback" class="form-message" aria-live="polite">No record selected.</p>
        <section id="record-details" class="record-details" hidden></section>
      </section>
      <section class="panel report-panel"><h2>Field inspection report</h2><p class="panel-description">Inspection reporting is not yet connected to a persistence API.</p>
        <label for="inspection-notes">Inspection findings</label><textarea id="inspection-notes" rows="5" disabled placeholder="An inspection report endpoint is not available yet."></textarea>
        <label for="inspection-date">Inspection date</label><input id="inspection-date" type="date" disabled>
        <button class="button button-disabled" type="button" disabled>Submit field report</button>
      </section>
    </div>
    <p class="notice notice-amber">A QR lookup only retrieves a record; it does not determine compliance or approval. Field inspections remain subject to authorized review.</p>`;

  document.querySelector('#record-lookup').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = document.querySelector('#record-code').value.trim().toLowerCase();
    const record = data.clearances.find((item) => String(item.application_id).toLowerCase() === code);
    const details = document.querySelector('#record-details');
    if (!record) {
      details.hidden = true;
      document.querySelector('#lookup-feedback').textContent = 'No matching clearance record was found.';
      return;
    }
    details.innerHTML = `<p class="eyebrow">RETRIEVED RECORD</p><h3>${escapeHtml(record.application_id)}</h3><dl>
      <div><dt>Applicant</dt><dd>${escapeHtml(record.applicant_name)}</dd></div><div><dt>Project type</dt><dd>${escapeHtml(record.project_type)}</dd></div>
      <div><dt>Barangay</dt><dd>${escapeHtml(record.barangay)}</dd></div><div><dt>Status</dt><dd>${renderStatus(record.status)}</dd></div></dl>`;
    details.hidden = false;
    document.querySelector('#lookup-feedback').textContent = 'Record found. Verify the site details before field inspection.';
  });
}

function logout() {
  state.token = '';
  state.refreshToken = '';
  state.user = null;
  state.data = null;
  state.activeView = 'overview';
  localStorage.removeItem('mapangat_token');
  localStorage.removeItem('mapangat_refresh_token');
  localStorage.removeItem('mapangat_user');
  renderLogin();
}

if (state.token && state.user) renderDashboard();
else renderLogin();
