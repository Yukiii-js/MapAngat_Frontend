import { parseGeoJson } from './geometry.js';

const categories = [
  ['zoning', 'Zoning'],
  ['hazard', 'Hazard'],
  ['waterbody', 'Waterbody / protected area'],
];

export async function mountSpatialAnalysis({ data, apiFetch, escapeHtml, renderPageHeading, state, requestId }) {
  const geocodedClearances = data.clearances.filter((record) => record.parcel_geojson);
  const canManageLayers = ['admin', 'mpdo'].includes(String(state.user?.role || '').toLowerCase());
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('spatial', false)}
    <div class="content-grid spatial-grid">
      <section class="panel form-panel">
        <div class="panel-heading"><div><h2>Run a parcel screening</h2><p>Review zoning and hazard intersections for a saved clearance parcel.</p></div></div>
        <form id="screening-form" class="form-stack">
          <label for="screening-application">Clearance application</label><select id="screening-application" required>
            <option value="">Select a parcel application</option>${geocodedClearances.map((record) => `<option value="${escapeHtml(record.application_id)}">${escapeHtml(record.application_id)} · ${escapeHtml(record.barangay)}</option>`).join('')}
          </select>
          <button class="button button-primary" type="submit" ${geocodedClearances.length ? '' : 'disabled'}>Run spatial intersection check</button>
        </form>
        <div id="screening-results" class="screening-notice" aria-live="polite"><span class="empty-icon">i</span><p>Intersection results are decision support only. Verify authoritative zoning and hazard sources before permitting decisions.</p></div>
      </section>
      ${canManageLayers ? `<section class="panel form-panel">
        <div class="panel-heading"><div><h2>Configure planning layers</h2><p>Import official municipal GeoJSON datasets to enable spatial intersections.</p></div></div>
        <form id="spatial-layer-form" class="form-stack">
          <label for="layer-name">Layer name</label><input id="layer-name" maxlength="120" placeholder="e.g. CLUP 2025 zoning" required>
          <label for="layer-category">Layer category</label><select id="layer-category">${categories.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select>
          <label for="layer-file">GeoJSON file (maximum 5 MB)</label><input id="layer-file" type="file" accept=".json,.geojson,application/geo+json,application/json" required>
          <button class="button button-primary" type="submit">Save planning layer</button>
          <p id="layer-feedback" class="form-message" aria-live="polite"></p>
        </form>
      </section>` : '<section class="panel notice-panel"><p class="notice notice-amber">Only MPDO staff can configure planning layers.</p></section>'}
    </div>
    <section class="panel layer-catalog"><div class="panel-heading"><div><h2>Connected planning layers</h2><p>Intersection checks use only layers configured here.</p></div></div><div id="spatial-layer-list" class="catalog-grid"></div></section>`;

  const renderLayers = (layers) => {
    const root = document.querySelector('#spatial-layer-list');
    if (!root) return;
    root.innerHTML = layers.length ? layers.map((layer) => `
      <article><span class="catalog-icon ${layer.category === 'hazard' ? 'amber' : 'blue'}">⌖</span>
        <h3>${escapeHtml(layer.layer_name)}</h3><p>${escapeHtml(categories.find(([value]) => value === layer.category)?.[1] || layer.category)}</p>
        <span class="dataset-state dataset-connected">Connected · ${escapeHtml(String(layer.updated_at || '').slice(0, 10) || 'current')}</span></article>
    `).join('') : '<p class="table-empty">No official planning datasets have been configured. Screening results will remain unavailable until layers are imported.</p>';
  };
  try {
    const result = await apiFetch('/api/spatial/layers');
    if (requestId !== state.viewRequest) return;
    renderLayers(result.layers || []);
  } catch (error) {
    if (requestId !== state.viewRequest) return;
    const root = document.querySelector('#spatial-layer-list');
    if (root) root.innerHTML = `<p class="table-empty" role="alert">${escapeHtml(error.message || 'Unable to load planning layers.')}</p>`;
  }

  if (requestId !== state.viewRequest) return;
  document.querySelector('#screening-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const applicationId = document.querySelector('#screening-application').value;
    const record = geocodedClearances.find((item) => item.application_id === applicationId);
    const panel = document.querySelector('#screening-results');
    if (!record) return;
    panel.innerHTML = '<span class="spinner"></span><p>Checking configured intersections…</p>';
    try {
      const parcel = typeof record.parcel_geojson === 'string' ? JSON.parse(record.parcel_geojson) : record.parcel_geojson;
      const result = await apiFetch('/api/spatial/screen', true, {
        method: 'POST',
        body: { parcel_geojson: parcel },
      });
      if (!result.layers_available) {
        panel.innerHTML = '<span class="empty-icon">i</span><p>No planning layers are configured. This is not a “no risk” or zoning determination.</p>';
      } else if (!result.matches.length) {
        panel.innerHTML = '<span class="empty-icon">✓</span><p>No intersection was found in the configured layers. Confirm layer currency and coverage with MPDO.</p>';
      } else {
        panel.innerHTML = `<span class="empty-icon">!</span><div><strong>${result.matches.length} intersection(s) found</strong>${result.matches.map((match) => `<p><strong>${escapeHtml(match.layer)}</strong> · ${escapeHtml(match.classification)} <small>(${escapeHtml(match.category)})</small></p>`).join('')}</div>`;
      }
    } catch (error) {
      panel.innerHTML = `<span class="empty-icon">!</span><p>${escapeHtml(error.message || 'Unable to run the spatial check.')}</p>`;
    }
  });

  const uploadForm = document.querySelector('#spatial-layer-form');
  uploadForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = uploadForm.elements['layer-file'].files[0];
    const feedback = document.querySelector('#layer-feedback');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      feedback.textContent = 'GeoJSON files must not exceed 5 MB.';
      feedback.classList.add('error');
      return;
    }
    feedback.textContent = 'Reading and validating GeoJSON…';
    feedback.classList.remove('error');
    try {
      const geojson = JSON.parse(await file.text());
      const features = parseGeoJson(geojson);
      if (!features.length || features.some((feature) => !['Polygon', 'MultiPolygon', 'Point'].includes(feature.geometry.type))) {
        throw new Error('Provide GeoJSON features containing Polygon, MultiPolygon, or Point geometry.');
      }
      await apiFetch('/api/spatial/layers', true, {
        method: 'POST',
        body: {
          layer_name: uploadForm.elements['layer-name'].value.trim(),
          category: uploadForm.elements['layer-category'].value,
          geojson,
        },
      });
      feedback.textContent = 'Planning layer saved.';
      const result = await apiFetch('/api/spatial/layers');
      renderLayers(result.layers || []);
    } catch (error) {
      feedback.textContent = error.message || 'Unable to save this planning layer.';
      feedback.classList.add('error');
    }
  });
}
