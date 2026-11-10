import './style.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';
import { mountClearances } from './modules/location-clearance.js';
import { mountProjects } from './modules/program-monitoring.js';
import { mountVerification } from './modules/qr-verification.js';
import { mountSpatialAnalysis } from './modules/spatial-analysis.js';
import { mountAnalytics } from './modules/analytics.js';

const app = document.querySelector('#app');
const navigation = [
  { id: 'overview', label: 'Overview', icon: '▦' },
  { id: 'map', label: 'Web-GIS Map', icon: '⌖' },
  { id: 'spatial', label: 'Spatial Analysis', icon: '◈' },
  { id: 'clearances', label: 'Location Clearance', icon: '▤' },
  { id: 'projects', label: 'Program Monitoring', icon: '▥' },
  { id: 'verification', label: 'QR Field Verification', icon: '▧' },
  { id: 'analytics', label: 'Spatial Analytics & Exports', icon: '▤' },
];

const state = {
  token: localStorage.getItem('mapangat_token') || '',
  refreshToken: localStorage.getItem('mapangat_refresh_token') || '',
  user: JSON.parse(localStorage.getItem('mapangat_user') || 'null'),
  baseUrl: (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, ''),
  activeView: 'overview',
  data: null,
  dataRequest: null,
  map: null,
  mapLayers: null,
  viewRequest: 0,
  viewCleanup: null,
};

const pageDetails = {
  overview: ['Municipal overview', 'A quick view of location-clearance activity and the municipal project portfolio.'],
  map: ['Web-GIS Map', 'Explore clearance sites and municipal project locations.'],
  spatial: ['Spatial Intelligence & Analysis', 'Review the planning layers available for preliminary site screening.'],
  clearances: ['Location Clearance', 'Register and track development-location clearance applications.'],
  projects: ['Program & Project Monitoring', 'Track implementation progress and upcoming field inspections.'],
  verification: ['QR Field Verification', 'Look up a permit or project record for field verification.'],
  analytics: ['Spatial Analytics & Executive Reports', 'Filter clearance and infrastructure data for MPDC reviews and Sangguniang Bayan sessions.'],
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

async function sha256File(file) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure browser cryptography is unavailable. Open this site over HTTPS.');
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

async function apiFetch(path, retry = true, request = {}) {
  const response = await fetch(`${state.baseUrl}${path}`, {
    method: request.method || 'GET',
    headers: {
      ...(request.headers || {}),
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });

  if (response.status === 401 && retry && await refreshAccessToken()) {
    return apiFetch(path, false, request);
  }

  const result = await parseJsonResponse(response);
  if (response.status === 401) {
    logout();
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

async function verifyPdf(reference, file) {
  const documentHash = await sha256File(file);
  return apiFetch('/api/ledger/verify', true, {
    method: 'POST',
    body: {
      document_reference: reference,
      document_hash: documentHash,
    },
  });
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
        clearance_pending: countStatus(clearances, ['pending', 'submitted']),
        clearance_review: countStatus(clearances, ['for review', 'under review', 'field inspection scheduled']),
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
        <a class="auth-home-link" href="#" id="public-home">← Return to the public home page</a>
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

  document.querySelector('#public-home').addEventListener('click', (event) => {
    event.preventDefault();
    renderLanding();
  });

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

function renderLanding() {
  destroyMap();
  const verificationReference = new URLSearchParams(window.location.search).get('verify') || '';
  app.innerHTML = `
    <main class="public-site">
      <header class="public-header">
        <a class="public-brand" href="#" aria-label="MapAngat home">
          <span class="public-seal" aria-hidden="true">B</span>
          <span><strong>Municipality of Baco</strong><small>Oriental Mindoro · Philippines</small></span>
        </a>
        <nav class="public-nav" aria-label="Public navigation">
          <a href="#about">About</a><a href="#stories">Planning stories</a><a href="#news">News &amp; updates</a>
          <a href="https://municipalityofbaco.com/" target="_blank" rel="noopener noreferrer">Official website ↗</a>
        </nav>
        <button class="button public-portal-button" type="button" data-open-login>MPDO staff portal <span aria-hidden="true">→</span></button>
      </header>

      <section class="public-hero" aria-labelledby="public-title">
        <div class="hero-orbit hero-orbit-one" aria-hidden="true"></div>
        <div class="hero-orbit hero-orbit-two" aria-hidden="true"></div>
        <div class="hero-landscape" aria-hidden="true"><span></span><i></i><b></b></div>
        <div class="hero-content">
          <p class="public-eyebrow"><span></span> MAPANGAT · MUNICIPAL PLANNING &amp; DEVELOPMENT</p>
          <h1 id="public-title">A clearer view.<br><em>A stronger Baco.</em></h1>
          <p class="hero-description">Explore MapAngat, a planning companion for municipal projects, location records and a more connected picture of Baco.</p>
          <div class="hero-actions">
            <a class="button hero-primary" href="#about">Discover MapAngat <span aria-hidden="true">↓</span></a>
            <button class="button hero-secondary" type="button" data-open-login>Open the MPDO workspace <span aria-hidden="true">→</span></button>
          </div>
          <div class="hero-location"><span aria-hidden="true">⌖</span> Baco, Oriental Mindoro <i></i> Planning for people and place</div>
        </div>
        <div class="hero-stamp" aria-hidden="true"><span>MAPANGAT</span><strong>Baco</strong><small>PLAN · CONNECT · GROW</small></div>
      </section>

      ${verificationReference ? `
        <section class="public-verify" aria-labelledby="public-verify-title">
          <div><p class="public-eyebrow dark-eyebrow">PUBLIC DOCUMENT CHECK</p><h2 id="public-verify-title">Verify a permit fingerprint.</h2><p>Choose the issued PDF. It is hashed in your browser and is not uploaded.</p></div>
          <form id="public-ledger-verify" class="form-stack">
            <label for="public-verify-reference">Document reference</label><input id="public-verify-reference" name="document_reference" value="${escapeHtml(verificationReference)}" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._\\x2f\\x2d]{0,119}" required>
            <label for="public-verify-file">PDF copy</label><input id="public-verify-file" name="document_file" type="file" accept="application/pdf,.pdf" required>
            <button class="button button-primary" type="submit">Check fingerprint</button>
            <p id="public-verify-message" class="form-message" aria-live="polite">A match confirms the file bytes only, not permit approval or legal status.</p>
          </form>
        </section>
      ` : ''}

      <section class="public-intro" id="about">
        <div class="intro-heading"><p class="public-eyebrow dark-eyebrow">A LOCAL VIEW, BUILT FOR BACO</p><h2>Make room for better decisions.</h2></div>
        <p>MapAngat brings municipal planning information into one useful place. Follow project progress, explore mapped records and support informed conversations about how Baco grows.</p>
        <a class="intro-link" href="#" data-open-login>Visit the planning workspace <span aria-hidden="true">↗</span></a>
      </section>

      <section class="stories-section" id="stories">
        <div class="section-heading">
          <div><p class="public-eyebrow dark-eyebrow">THE MAPANGAT JOURNAL</p><h2>Planning, made more visible.</h2></div>
          <p>Short guides to the ideas behind a connected, community-minded planning process.</p>
        </div>
        <div class="story-grid">
          <article class="story-card story-blue"><span class="story-number">01 / PLACE</span><span class="story-art art-contour" aria-hidden="true"></span><div><p>LOCAL PLANNING</p><h3>Start with the places people call home.</h3><span>Good planning begins with understanding locations, local context and the people who use them.</span></div></article>
          <article class="story-card story-gold"><span class="story-number">02 / PROGRESS</span><span class="story-art art-progress" aria-hidden="true"></span><div><p>PUBLIC PROJECTS</p><h3>Follow the work from plan to progress.</h3><span>A shared project view helps teams keep milestones, site visits and implementation status in focus.</span></div></article>
          <article class="story-card story-ink"><span class="story-number">03 / TRUST</span><span class="story-art art-ledger" aria-hidden="true"></span><div><p>DOCUMENT INTEGRITY</p><h3>Keep a fingerprint, not a copy.</h3><span>MapAngat can record a permit PDF's SHA-256 fingerprint so a later copy can be checked for changes.</span></div></article>
        </div>
      </section>

      <section class="public-updates" id="news">
        <div><p class="public-eyebrow">FROM THE MUNICIPALITY</p><h2>News and announcements belong to their official source.</h2><p>For current municipal notices, programs and community updates, visit the Municipality of Baco's official website.</p></div>
        <a class="button updates-link" href="https://municipalityofbaco.com/" target="_blank" rel="noopener noreferrer">Visit official news &amp; updates <span aria-hidden="true">↗</span></a>
      </section>

      <footer class="public-footer">
        <a class="public-brand footer-brand" href="#"><span class="public-seal" aria-hidden="true">B</span><span><strong>MapAngat</strong><small>Municipal planning for Baco</small></span></a>
        <span>Public information and planning tools · Baco, Oriental Mindoro</span>
        <button class="footer-login" type="button" data-open-login>MPDO staff sign in</button>
      </footer>
    </main>
  `;

  document.querySelectorAll('[data-open-login]').forEach((button) => {
    button.addEventListener('click', () => renderLogin());
  });

  const publicVerifyForm = document.querySelector('#public-ledger-verify');
  publicVerifyForm?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  publicVerifyForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#public-verify-message');
    const file = form.elements['document_file'].files[0];
    const fileError = file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))
      ? ''
      : 'Select a PDF file first.';
    if (fileError) {
      feedback.textContent = fileError;
      feedback.classList.add('error');
      return;
    }

    feedback.textContent = 'Calculating and checking the document fingerprint…';
    feedback.classList.remove('error');
    try {
      const result = await verifyPdf(form.elements['document_reference'].value.trim(), file);
      feedback.innerHTML = result.verified
        ? `Fingerprint matches the ledger. <strong>Block ${escapeHtml(result.block.index)}</strong><br>SHA-256: <code>${escapeHtml(result.block.documentHash)}</code>`
        : 'No matching fingerprint was found for this reference and PDF. Check the reference and try the original issued document.';
      feedback.classList.toggle('error', !result.verified);
    } catch (error) {
      feedback.textContent = error.message || 'Unable to verify this document.';
      feedback.classList.add('error');
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
  state.viewCleanup?.();
  state.viewCleanup = null;
  destroyMap();
  const requestId = ++state.viewRequest;
  renderLoading(view);

  try {
    const data = await loadDashboardData(force);
    if (requestId !== state.viewRequest) return;
    if (view === 'overview') renderOverview(data);
    else if (view === 'map') await renderMap(data, requestId);
    else if (view === 'clearances') {
      state.viewCleanup = await mountClearances({
        data, apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatCard, renderStatus,
        renderClearanceTable, refresh: () => renderView(view, true),
      });
    } else if (view === 'projects') {
      state.viewCleanup = await mountProjects({
        data, apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatCard, renderStatus,
        refresh: () => renderView(view, true),
      });
    } else if (view === 'spatial') {
      await mountSpatialAnalysis({ data, apiFetch, escapeHtml, renderPageHeading, state, requestId });
    } else if (view === 'verification') {
      state.viewCleanup = await mountVerification({
        apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatus, state, sha256File, verifyPdf,
      });
    } else if (view === 'analytics') {
      mountAnalytics({ data, escapeHtml, formatDate, renderPageHeading, renderStatus });
    }
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
  if (!document.querySelector('#map')) return;

  state.map = L.map('map').setView([13.3182, 121.0925], 12);
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
      <section class="panel report-panel ledger-panel"><h2>Document fingerprint ledger</h2><p class="panel-description">Only the PDF's SHA-256 hash is recorded; the document stays on your device.</p>
        ${['admin', 'mpdo'].includes(String(state.user?.role || '').toLowerCase()) ? `
          <form id="ledger-anchor-form" class="form-stack">
            <label for="ledger-anchor-reference">Permit / document reference</label><input id="ledger-anchor-reference" name="ledger-anchor-reference" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._\\x2f\\x2d]{0,119}" placeholder="e.g. BCO-2026-001" required>
            <label for="ledger-document-type">Document type</label><select id="ledger-document-type" name="ledger-document-type"><option value="permit">Permit</option><option value="location_clearance">Location clearance</option><option value="other">Other</option></select>
            <label for="ledger-anchor-file">Issued PDF</label><input id="ledger-anchor-file" name="ledger-anchor-file" type="file" accept="application/pdf,.pdf" required>
            <button class="button button-primary" type="submit">Add fingerprint to ledger</button>
          </form>
          <p id="ledger-anchor-message" class="form-message" aria-live="polite"></p>
        ` : '<p class="notice notice-amber">Only MPDO staff can add a document fingerprint.</p>'}
        <form id="ledger-verify-form" class="form-stack ledger-verify-form">
          <label for="ledger-verify-reference">Document reference to verify</label><input id="ledger-verify-reference" name="ledger-verify-reference" maxlength="120" pattern="[A-Za-z0-9][A-Za-z0-9._\\x2f\\x2d]{0,119}" placeholder="Enter the printed permit reference" required>
          <label for="ledger-verify-file">PDF copy</label><input id="ledger-verify-file" name="ledger-verify-file" type="file" accept="application/pdf,.pdf" required>
          <button class="button button-outline" type="submit">Verify document fingerprint</button>
        </form>
        <p id="ledger-verify-message" class="form-message" aria-live="polite">Verification compares this local PDF with the recorded ledger entry.</p>
      </section>
    </div>
    <p class="notice notice-amber">A matching hash confirms the PDF bytes match the recorded fingerprint. It does not establish permit validity, approval or legal status.</p>`;

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

  const showFileError = (file) => !file
    ? 'Select a PDF file first.'
    : (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)
      ? 'Select a PDF file.'
      : '');
  const describeBlock = (block) => `
    <strong>Ledger block ${escapeHtml(block.index)}</strong><br>
    SHA-256: <code>${escapeHtml(block.documentHash)}</code><br>
    Block hash: <code>${escapeHtml(block.currentHash)}</code>`;

  document.querySelector('#ledger-verify-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#ledger-verify-message');
    const file = form.elements['ledger-verify-file'].files[0];
    const fileError = showFileError(file);
    if (fileError) {
      feedback.textContent = fileError;
      feedback.classList.add('error');
      return;
    }

    feedback.textContent = 'Calculating and checking the document fingerprint…';
    feedback.classList.remove('error');
    try {
      const reference = form.elements['ledger-verify-reference'].value.trim();
      const result = await verifyPdf(reference, file);
      feedback.innerHTML = result.verified
        ? `Fingerprint matches the ledger.<br>${describeBlock(result.block)}`
        : 'No matching fingerprint was found for this reference and PDF. Check the reference and try the original issued document.';
      feedback.classList.toggle('error', !result.verified);
    } catch (error) {
      feedback.textContent = error.message || 'Unable to verify this document.';
      feedback.classList.add('error');
    }
  });

  const anchorForm = document.querySelector('#ledger-anchor-form');
  anchorForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#ledger-anchor-message');
    const file = form.elements['ledger-anchor-file'].files[0];
    const fileError = showFileError(file);
    if (fileError) {
      feedback.textContent = fileError;
      feedback.classList.add('error');
      return;
    }

    feedback.textContent = 'Calculating and recording the document fingerprint…';
    feedback.classList.remove('error');
    try {
      const documentHash = await sha256File(file);
      const result = await apiFetch('/api/ledger/anchor', true, {
        method: 'POST',
        body: {
          document_reference: form.elements['ledger-anchor-reference'].value.trim(),
          document_type: form.elements['ledger-document-type'].value,
          document_hash: documentHash,
        },
      });
      feedback.innerHTML = `Fingerprint recorded. Keep the issued PDF for later checks.<br>${describeBlock(result.block)}`;
    } catch (error) {
      feedback.textContent = error.message || 'Unable to add this document to the ledger.';
      feedback.classList.add('error');
      return;
    }

    try {
      const verificationUrl = new URL(window.location.href);
      verificationUrl.search = '';
      verificationUrl.searchParams.set('verify', form.elements['ledger-anchor-reference'].value.trim());
      const qrImage = await QRCode.toDataURL(verificationUrl.toString(), {
        width: 180,
        margin: 1,
        color: { dark: '#092b84', light: '#ffffff' },
      });
      feedback.insertAdjacentHTML('beforeend', `<div class="ledger-qr"><img src="${escapeHtml(qrImage)}" alt="QR code for public document verification"><a href="${escapeHtml(verificationUrl.toString())}" target="_blank" rel="noopener noreferrer">Open public verification page ↗</a></div>`);
    } catch (error) {
      console.error('Document fingerprint was recorded, but QR generation failed.', error);
      feedback.insertAdjacentHTML('beforeend', '<br>The fingerprint was recorded, but the QR code could not be generated. Try again or use the manual verification form.');
    }
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
  renderLanding();
}

if (state.token && state.user && !new URLSearchParams(window.location.search).has('verify')) renderDashboard();
else renderLanding();
