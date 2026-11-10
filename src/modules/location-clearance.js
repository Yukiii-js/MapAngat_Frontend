import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';
import { geodesicArea, normalizeGeometry } from './geometry.js';

const defaultCenter = [13.3182, 121.0925];
const lifecycleStatuses = ['Submitted', 'Under Review', 'Field Inspection Scheduled', 'Approved', 'Rejected'];

function asGeoJson(geometry) {
  return { type: 'Feature', properties: {}, geometry };
}

function makePolygonGeoJson(points) {
  if (points.length < 3) return null;
  const ring = points.map(({ lat, lng }) => [lng, lat]);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

function renderScreening(matches, layersAvailable, escapeHtml) {
  if (!layersAvailable) {
    return '<p class="notice notice-amber">No official zoning or hazard layers are configured. The application can be saved, but no spatial screening conclusion is available.</p>';
  }
  if (!matches.length) return '<p class="notice notice-green">No intersection was found in the configured planning layers.</p>';
  return `<div class="screening-hit-list">${matches.map((match) => `
    <p><strong>${escapeHtml(match.layer)}</strong> · ${escapeHtml(match.category)}<small>${escapeHtml(match.classification || '')}</small></p>
  `).join('')}</div>`;
}

export async function mountClearances({ data, apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatCard, renderStatus, renderClearanceTable, refresh }) {
  const { clearances, counts } = data;
  const content = document.querySelector('#page-content');
  content.innerHTML = `
    ${renderPageHeading('clearances')}
    <div class="stats-grid three-cards">
      ${renderStatCard('Submitted / pending', counts.clearance_pending, '◷', 'amber')}
      ${renderStatCard('Under review', counts.clearance_review, '⌕', 'blue')}
      ${renderStatCard('Approved', counts.clearance_approved, '✓', 'green')}
    </div>
    <div class="content-grid clearance-workspace">
      <section class="panel clearance-form-panel">
        <div class="panel-heading"><div><h2>New location clearance</h2><p>Draw a parcel or place a site pin. Parcel area is measured geodesically.</p></div></div>
        <form id="clearance-form" class="form-stack">
          <label for="applicant-name">Applicant name</label><input id="applicant-name" name="applicant_name" maxlength="150" required>
          <label for="project-type">Project / development</label><input id="project-type" name="project_type" maxlength="150" required>
          <label for="clearance-barangay">Barangay</label><input id="clearance-barangay" name="barangay" maxlength="100" required>
          <label for="land-use">Proposed land use</label><select id="land-use" name="land_use_category" required>
            <option value="">Select a category</option><option>Agriculture</option><option>Commercial</option><option>Residential</option><option>Institutional</option><option>Industrial</option><option>Other</option>
          </select>
          <div class="map-draw-tools" role="group" aria-label="Parcel drawing tools">
            <button type="button" class="button button-outline active" data-draw-mode="polygon">Draw parcel</button>
            <button type="button" class="button button-outline" data-draw-mode="point">Place pin</button>
            <button type="button" id="undo-parcel" class="button button-outline">Undo</button>
            <button type="button" id="clear-parcel" class="button button-outline">Clear</button>
          </div>
          <div id="clearance-map" class="leaflet-map clearance-map" role="application" aria-label="Draw a parcel polygon or place a clearance location pin"></div>
          <p id="parcel-area" class="parcel-area">Draw a polygon or place a pin on the map.</p>
          <div id="clearance-screening" class="screening-summary" aria-live="polite">Planning layers will be checked when the application is submitted.</div>
          <button class="button button-primary" type="submit">Submit clearance application</button>
          <p id="clearance-feedback" class="form-message" aria-live="polite"></p>
        </form>
      </section>
      <section class="panel">
        <div class="panel-heading panel-heading-wrap"><div><h2>Application register</h2><p>${clearances.length} application${clearances.length === 1 ? '' : 's'} in the register</p></div>
          <div class="table-filters"><input id="clearance-search" type="search" placeholder="Search ID, applicant, barangay" aria-label="Search clearance applications"><select id="clearance-status" aria-label="Filter by status"><option value="">All statuses</option>${lifecycleStatuses.map((status) => `<option>${escapeHtml(status)}</option>`).join('')}<option>Pending</option><option>For review</option></select></div>
        </div>
        <div id="clearance-table">${renderClearanceTable(clearances, 'No applications have been submitted yet.')}</div>
      </section>
    </div>
    <dialog id="clearance-dialog" class="workflow-dialog"></dialog>
  `;

  const map = L.map('clearance-map', { doubleClickZoom: false }).setView(defaultCenter, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const drawingLayer = L.featureGroup().addTo(map);
  let mode = 'polygon';
  let points = [];
  let pointGeometry = null;
  let parcelGeometry = null;

  const updateGeometry = () => {
    drawingLayer.clearLayers();
    parcelGeometry = pointGeometry || makePolygonGeoJson(points);
    if (pointGeometry) {
      L.circleMarker([pointGeometry.coordinates[1], pointGeometry.coordinates[0]], {
        radius: 8, color: '#0038de', fillColor: '#0038de', fillOpacity: 0.9,
      }).addTo(drawingLayer);
    } else if (points.length) {
      points.forEach(({ lat, lng }) => L.circleMarker([lat, lng], {
        radius: 4, color: '#0038de', fillColor: '#fff', fillOpacity: 1,
      }).addTo(drawingLayer));
      if (points.length > 2) {
        L.polygon(points.map(({ lat, lng }) => [lat, lng]), {
          color: '#0038de', fillColor: '#5d7cff', fillOpacity: 0.2,
        }).addTo(drawingLayer);
      } else {
        L.polyline(points.map(({ lat, lng }) => [lat, lng]), { color: '#0038de' }).addTo(drawingLayer);
      }
    }
    const area = parcelGeometry?.type === 'Point' ? 0 : geodesicArea(parcelGeometry);
    document.querySelector('#parcel-area').textContent = parcelGeometry
      ? (parcelGeometry.type === 'Point' ? 'Point location selected · parcel area not applicable' : `Estimated parcel area: ${area.toLocaleString(undefined, { maximumFractionDigits: 2 })} m²`)
      : 'Draw a polygon or place a pin on the map.';
  };

  map.on('click', (event) => {
    if (mode === 'point') {
      pointGeometry = { type: 'Point', coordinates: [event.latlng.lng, event.latlng.lat] };
      points = [];
    } else {
      pointGeometry = null;
      points.push(event.latlng);
    }
    updateGeometry();
  });
  document.querySelectorAll('[data-draw-mode]').forEach((button) => button.addEventListener('click', () => {
    mode = button.dataset.drawMode;
    document.querySelectorAll('[data-draw-mode]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  document.querySelector('#undo-parcel').addEventListener('click', () => {
    if (pointGeometry) pointGeometry = null;
    else points.pop();
    updateGeometry();
  });
  document.querySelector('#clear-parcel').addEventListener('click', () => {
    points = [];
    pointGeometry = null;
    updateGeometry();
  });

  const filterRows = () => {
    const query = document.querySelector('#clearance-search').value.trim().toLowerCase();
    const selected = document.querySelector('#clearance-status').value.toLowerCase();
    document.querySelectorAll('#clearance-table .clearance-row').forEach((row) => {
      row.hidden = !(row.dataset.search.includes(query)
        && (!selected || row.dataset.status.toLowerCase() === selected));
    });
  };
  document.querySelector('#clearance-search').addEventListener('input', filterRows);
  document.querySelector('#clearance-status').addEventListener('change', filterRows);

  const dialog = document.querySelector('#clearance-dialog');
  document.querySelectorAll('.clearance-row').forEach((row, index) => {
    const record = clearances[index];
    row.tabIndex = 0;
    row.title = 'Open application actions';
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, select, a')) return;
      openApplication(record);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openApplication(record);
    });
  });

  function openApplication(record) {
    dialog.innerHTML = `
      <form method="dialog" class="dialog-close-form"><button class="dialog-close" aria-label="Close">×</button></form>
      <p class="eyebrow">CLEARANCE WORKFLOW</p><h2>${escapeHtml(record.application_id || 'Application')}</h2>
      <p>${escapeHtml(record.applicant_name || '')} · ${escapeHtml(record.barangay || '')}</p>
      <dl class="dialog-facts"><div><dt>Development</dt><dd>${escapeHtml(record.project_type || '—')}</dd></div>
        <div><dt>Proposed land use</dt><dd>${escapeHtml(record.land_use_category || '—')}</dd></div>
        <div><dt>Parcel area</dt><dd>${record.area_sqm ? `${Number(record.area_sqm).toLocaleString()} m²` : 'Not available'}</dd></div>
        <div><dt>Current status</dt><dd>${renderStatus(record.status)}</dd></div></dl>
      ${record.screening_results ? `<div class="screening-summary">${renderScreening(JSON.parse(record.screening_results), 1, escapeHtml)}</div>` : ''}
      <form id="clearance-status-form" class="form-stack compact-form">
        <label for="workflow-status">Lifecycle status</label><select id="workflow-status">${lifecycleStatuses.map((status) => `<option ${String(record.status).toLowerCase() === status.toLowerCase() ? 'selected' : ''}>${status}</option>`).join('')}</select>
        <button class="button button-outline" type="submit">Save status</button>
      </form>
      ${record.parcel_geojson ? `<form id="issue-certificate-form" class="form-stack compact-form">
        <label for="approved-land-use">Approved land use</label><input id="approved-land-use" value="${escapeHtml(record.approved_land_use || record.land_use_category || '')}" maxlength="100" required>
        <label for="certificate-type">Document type</label><select id="certificate-type"><option>Zoning Clearance</option><option>Locational Certificate</option></select>
        <label for="permit-valid-until">Valid until</label><input id="permit-valid-until" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${escapeHtml(record.permit_valid_until || '')}" required>
        <button class="button button-primary" type="submit">${record.qr_reference ? 'Re-issue certificate' : 'Approve & issue certificate'}</button>
      </form>` : '<p class="notice notice-amber">Certificate issuance requires a parcel recorded by the location-clearance form.</p>'}
      <div id="certificate-preview"></div>
      <p id="dialog-feedback" class="form-message" aria-live="polite"></p>`;
    dialog.showModal();
    dialog.querySelector('.dialog-close-form').addEventListener('submit', () => dialog.close());
    dialog.querySelector('#clearance-status-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const feedback = dialog.querySelector('#dialog-feedback');
      try {
        await apiFetch('/api/clearances/status', true, {
          method: 'POST',
          body: { application_id: record.application_id, status: dialog.querySelector('#workflow-status').value },
        });
        feedback.textContent = 'Application status saved.';
        await refresh();
      } catch (error) {
        feedback.textContent = error.message || 'Unable to update this application.';
        feedback.classList.add('error');
      }
    });
    dialog.querySelector('#issue-certificate-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const feedback = dialog.querySelector('#dialog-feedback');
      try {
        const result = await apiFetch('/api/clearances/issue', true, {
          method: 'POST',
          body: {
            application_id: record.application_id,
            approved_land_use: dialog.querySelector('#approved-land-use').value.trim(),
            certificate_type: dialog.querySelector('#certificate-type').value,
            valid_until: dialog.querySelector('#permit-valid-until').value,
          },
        });
        const qrImage = await QRCode.toDataURL(result.qr_reference, { width: 180, margin: 1 });
        dialog.querySelector('#certificate-preview').innerHTML = `
          <section class="certificate-preview"><img src="${qrImage}" alt="QR code for ${escapeHtml(result.qr_reference)}">
            <div><p class="eyebrow">DIGITAL DOCUMENT READY</p><strong>${escapeHtml(dialog.querySelector('#certificate-type').value)}</strong>
              <p>Reference: <code>${escapeHtml(result.qr_reference)}</code></p>
              <p>${escapeHtml(dialog.querySelector('#approved-land-use').value)}</p>
              <button type="button" id="print-certificate" class="button button-outline">Print certificate</button></div></section>`;
        dialog.querySelector('#print-certificate').addEventListener('click', () => {
          const printWindow = window.open('', '_blank');
          if (!printWindow) {
            const printFeedback = dialog.querySelector('#dialog-feedback');
            printFeedback.textContent = 'Allow pop-ups to open the printable digital clearance.';
            printFeedback.classList.add('error');
            return;
          }
          printWindow.opener = null;
          printWindow.document.write(`<title>${escapeHtml(result.qr_reference)}</title><main style="font:16px Arial;max-width:760px;margin:50px auto;text-align:center"><h1>BACO · ${escapeHtml(dialog.querySelector('#certificate-type').value)}</h1><h2>${escapeHtml(record.applicant_name)}</h2><p>${escapeHtml(dialog.querySelector('#approved-land-use').value)} · ${escapeHtml(record.barangay)}</p><p>Reference ${escapeHtml(result.qr_reference)} · Valid until ${escapeHtml(dialog.querySelector('#permit-valid-until').value)}</p><img width="180" src="${qrImage}" alt="QR code"><p>Present this reference for field verification.</p></main>`);
          printWindow.document.close();
          printWindow.focus();
          printWindow.print();
        });
        feedback.textContent = 'Clearance approved and QR reference issued.';
        await refresh();
      } catch (error) {
        feedback.textContent = error.message || 'Unable to issue the digital clearance.';
        feedback.classList.add('error');
      }
    });
    if (record.qr_reference) {
      QRCode.toDataURL(record.qr_reference, { width: 180, margin: 1 }).then((qrImage) => {
        if (!dialog.open) return;
        dialog.querySelector('#certificate-preview').innerHTML = `<section class="certificate-preview"><img src="${qrImage}" alt="QR code for ${escapeHtml(record.qr_reference)}"><div><p class="eyebrow">ISSUED DOCUMENT</p><strong>${escapeHtml(record.certificate_type || 'Clearance')}</strong><p>Reference: <code>${escapeHtml(record.qr_reference)}</code></p><p>Permit status: ${escapeHtml(record.permit_status || 'Valid')} · Expires ${escapeHtml(formatDate(record.permit_valid_until))}</p></div></section>`;
      }).catch((error) => {
        console.error('Unable to render the existing clearance QR code.', error);
      });
    }
  }

  document.querySelector('#clearance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#clearance-feedback');
    const screeningPanel = document.querySelector('#clearance-screening');
    if (!parcelGeometry) {
      feedback.textContent = 'Draw a parcel or place a location pin before submitting.';
      feedback.classList.add('error');
      return;
    }
    const body = {
      applicant_name: form.elements.applicant_name.value.trim(),
      project_type: form.elements.project_type.value.trim(),
      barangay: form.elements.barangay.value.trim(),
      land_use_category: form.elements.land_use_category.value,
      parcel_geojson: asGeoJson(parcelGeometry),
    };
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    feedback.textContent = 'Checking configured planning layers and saving the application…';
    feedback.classList.remove('error');
    try {
      const screen = await apiFetch('/api/spatial/screen', true, { method: 'POST', body: { parcel_geojson: body.parcel_geojson } });
      screeningPanel.innerHTML = renderScreening(screen.matches || [], Number(screen.layers_available) || 0, escapeHtml);
      const result = await apiFetch('/api/clearances', true, { method: 'POST', body });
      feedback.textContent = `Application ${result.application_id} submitted. ${result.layers_available ? `${(result.screening || []).length} planning-layer intersection(s) recorded.` : 'No planning layers are configured yet; screening is unavailable.'}`;
      await refresh();
    } catch (error) {
      feedback.textContent = error.message || 'Unable to submit the location clearance.';
      feedback.classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });
  map.invalidateSize();
  return () => map.remove();
}
