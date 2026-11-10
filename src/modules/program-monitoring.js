import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const defaultCenter = [13.3182, 121.0925];

export async function mountProjects({ data, apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatCard, renderStatus, refresh }) {
  const { projects, counts } = data;
  const barangays = [...new Set(projects.map((project) => project.barangay).filter(Boolean))].sort();
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('projects')}
    <div class="stats-grid">
      ${renderStatCard('Total projects', counts.projects_total, '▥', 'blue')}
      ${renderStatCard('On track', counts.projects_on_track, '✓', 'green')}
      ${renderStatCard('At risk', counts.projects_at_risk, '!', 'amber')}
      ${renderStatCard('Delayed', counts.projects_delayed, '↘', 'rose')}
    </div>
    <div class="content-grid project-workspace">
      <section class="panel project-map-panel">
        <div class="panel-heading panel-heading-wrap"><div><h2>Infrastructure portfolio map</h2><p>Filter sites by barangay and implementation status.</p></div>
          <div class="table-filters">
            <select id="project-barangay-filter" aria-label="Filter by barangay"><option value="">All barangays</option>${barangays.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select>
            <select id="project-status-filter" aria-label="Filter projects by status"><option value="">All statuses</option><option>On track</option><option>At risk</option><option>Delayed</option></select>
          </div>
        </div>
        <div id="project-map" class="leaflet-map" role="application" aria-label="Map of Baco infrastructure projects"></div>
      </section>
      <section class="panel project-portfolio-panel">
        <div class="panel-heading"><div><h2>Project portfolio</h2><p>Target vs. actual completion and budget execution</p></div></div>
        <div id="project-list" class="project-list">
          ${projects.length ? projects.map((project) => {
            const progress = Math.max(0, Math.min(100, Number(project.progress) || 0));
            const target = Math.max(0, Math.min(100, Number(project.target_progress) || 0));
            const allocated = Number(project.allocated_budget) || 0;
            const spent = Number(project.spent_budget) || 0;
            const budgetRatio = allocated > 0 ? Math.min(100, spent / allocated * 100) : 0;
            return `<article class="project-row project-detail-row" data-project-id="${escapeHtml(project.id)}" data-status="${escapeHtml(project.status)}" data-barangay="${escapeHtml(project.barangay)}">
              <div class="project-main">
                <div class="project-title"><h3>${escapeHtml(project.project_name)}</h3>${renderStatus(project.status)}</div>
                <p>${escapeHtml(project.barangay)} · Next inspection ${escapeHtml(formatDate(project.inspection_date))}</p>
                <div class="completion-comparison"><span>Actual <strong>${progress}%</strong></span><span>Target <strong>${target}%</strong></span></div>
                <div class="progress-track"><span style="width:${progress}%"></span></div>
                <div class="budget-comparison"><span>Budget execution</span><strong>${allocated ? `${budgetRatio.toFixed(1)}% · ₱${spent.toLocaleString()} / ₱${allocated.toLocaleString()}` : 'Budget not recorded'}</strong></div>
              </div>
              <div class="project-actions"><button type="button" class="button button-outline" data-project-update="${escapeHtml(project.id)}">Progress update</button><small>${escapeHtml(project.project_name)}</small></div>
            </article>`;
          }).join('') : '<p class="table-empty">No projects are available yet.</p>'}
        </div>
      </section>
    </div>
    <dialog id="project-update-dialog" class="workflow-dialog"></dialog>
  `;

  const map = L.map('project-map').setView(defaultCenter, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const markers = L.layerGroup().addTo(map);
  const colorByStatus = { 'On track': '#159456', 'At risk': '#c58a11', Delayed: '#d34b54' };
  projects.forEach((project) => {
    const latitude = Number(project.lat);
    const longitude = Number(project.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !latitude || !longitude) return;
    const color = colorByStatus[project.status] || '#647087';
    const marker = L.circleMarker([latitude, longitude], {
      radius: 8, color, fillColor: color, fillOpacity: 0.9, weight: 2,
    }).bindPopup(`<strong>${escapeHtml(project.project_name)}</strong><br>${escapeHtml(project.barangay)}<br>${escapeHtml(project.status)} · ${Number(project.progress) || 0}%`);
    marker.project = project;
    marker.addTo(markers);
  });
  const applyFilters = () => {
    const barangay = document.querySelector('#project-barangay-filter').value;
    const status = document.querySelector('#project-status-filter').value;
    document.querySelectorAll('.project-detail-row').forEach((row) => {
      row.hidden = Boolean((barangay && row.dataset.barangay !== barangay)
        || (status && row.dataset.status !== status));
    });
    markers.eachLayer((marker) => {
      const visible = (!barangay || marker.project.barangay === barangay)
        && (!status || marker.project.status === status);
      if (visible && !map.hasLayer(marker)) marker.addTo(map);
      if (!visible && map.hasLayer(marker)) map.removeLayer(marker);
    });
  };
  document.querySelector('#project-barangay-filter').addEventListener('change', applyFilters);
  document.querySelector('#project-status-filter').addEventListener('change', applyFilters);

  const dialog = document.querySelector('#project-update-dialog');
  document.querySelectorAll('[data-project-update]').forEach((button) => {
    button.addEventListener('click', () => openUpdateForm(
      projects.find((project) => String(project.id) === button.dataset.projectUpdate),
    ));
  });

  async function openUpdateForm(project) {
    if (!project) return;
    let updateHistory;
    try {
      const result = await apiFetch(`/api/projects/updates?project_id=${encodeURIComponent(project.id)}`);
      if (!dialog.isConnected) return;
      updateHistory = result.updates || [];
    } catch (error) {
      dialog.innerHTML = `<p class="eyebrow">PROJECT PROGRESS</p><h2>${escapeHtml(project.project_name)}</h2><p class="form-message error" role="alert">${escapeHtml(error.message || 'Unable to load project history.')}</p><form method="dialog"><button class="button button-outline">Close</button></form>`;
      dialog.showModal();
      return;
    }

    dialog.innerHTML = `
      <form method="dialog" class="dialog-close-form"><button class="dialog-close" aria-label="Close">×</button></form>
      <p class="eyebrow">PROGRAM MONITORING</p><h2>${escapeHtml(project.project_name)}</h2>
      <p>${escapeHtml(project.barangay)} · Current completion ${Number(project.progress) || 0}%</p>
      <form id="project-progress-form" class="form-stack compact-form">
        <label for="update-completion">Actual physical completion (%)</label><input id="update-completion" name="completion" type="number" min="0" max="100" step="0.1" value="${escapeHtml(project.progress || 0)}" required>
        <label for="target-progress">Target physical completion (%)</label><input id="target-progress" name="target_progress" type="number" min="0" max="100" step="0.1" value="${escapeHtml(project.target_progress ?? 100)}" required>
        <label for="allocated-budget">Allocated budget (PHP)</label><input id="allocated-budget" name="allocated_budget" type="number" min="0" step="0.01" value="${escapeHtml(project.allocated_budget || 0)}" required>
        <label for="budget-spent">Budget executed (PHP)</label><input id="budget-spent" name="budget_spent" type="number" min="0" step="0.01" value="${escapeHtml(project.spent_budget || 0)}" required>
        <label for="project-status">Status</label><select id="project-status" name="status"><option ${project.status === 'On track' ? 'selected' : ''}>On track</option><option ${project.status === 'At risk' ? 'selected' : ''}>At risk</option><option ${project.status === 'Delayed' ? 'selected' : ''}>Delayed</option></select>
        <label for="update-note">Progress notes</label><textarea id="update-note" name="update_note" rows="3" maxlength="5000" required></textarea>
        <label for="progress-photo-url">Inspection photo URL <span class="label-muted">(optional)</span></label><input id="progress-photo-url" name="photo_url" type="url" maxlength="2048" placeholder="https://…">
        <div class="geo-fields"><label for="progress-latitude">Latitude</label><input id="progress-latitude" name="latitude" type="number" step="any" placeholder="Optional"><label for="progress-longitude">Longitude</label><input id="progress-longitude" name="longitude" type="number" step="any" placeholder="Optional"></div>
        <button id="use-project-location" type="button" class="button button-outline">Use current location</button>
        <button class="button button-primary" type="submit">Save progress update</button>
        <p id="project-update-feedback" class="form-message" aria-live="polite"></p>
      </form>
      <section class="update-history"><h3>Recent progress updates</h3>${updateHistory.length ? updateHistory.slice(0, 5).map((update) => `<article><strong>${escapeHtml(update.completion)}% · ${escapeHtml(update.created_by)}</strong><p>${escapeHtml(update.update_note)}</p><small>${escapeHtml(formatDate(update.created_at))}${update.photo_url ? ` · <a href="${escapeHtml(update.photo_url)}" target="_blank" rel="noopener noreferrer">Inspection photo</a>` : ''}</small></article>`).join('') : '<p class="panel-description">No progress updates have been recorded.</p>'}</section>`;
    dialog.showModal();
    dialog.querySelector('.dialog-close-form').addEventListener('submit', () => dialog.close());
    dialog.querySelector('#use-project-location').addEventListener('click', () => {
      const feedback = dialog.querySelector('#project-update-feedback');
      if (!navigator.geolocation) {
        feedback.textContent = 'Geolocation is not available in this browser.';
        feedback.classList.add('error');
        return;
      }
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        dialog.querySelector('#progress-latitude').value = coords.latitude.toFixed(7);
        dialog.querySelector('#progress-longitude').value = coords.longitude.toFixed(7);
        feedback.textContent = 'Current location added.';
        feedback.classList.remove('error');
      }, (error) => {
        feedback.textContent = error.message || 'Unable to read the current location.';
        feedback.classList.add('error');
      }, { enableHighAccuracy: true, timeout: 10000 });
    });
    dialog.querySelector('#project-progress-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const feedback = dialog.querySelector('#project-update-feedback');
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await apiFetch('/api/projects/update', true, {
          method: 'POST',
          body: {
            project_id: Number(project.id),
            completion: Number(form.elements.completion.value),
            target_progress: Number(form.elements.target_progress.value),
            allocated_budget: Number(form.elements.allocated_budget.value),
            budget_spent: Number(form.elements.budget_spent.value),
            status: form.elements.status.value,
            update_note: form.elements.update_note.value.trim(),
            photo_url: form.elements.photo_url.value.trim(),
            latitude: form.elements.latitude.value || null,
            longitude: form.elements.longitude.value || null,
          },
        });
        feedback.textContent = 'Progress update saved.';
        await refresh();
      } catch (error) {
        feedback.textContent = error.message || 'Unable to save the progress update.';
        feedback.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });
  }

  map.invalidateSize();
  return () => map.remove();
}
