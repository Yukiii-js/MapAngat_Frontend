import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';
import { geodesicArea } from './geometry.js';

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

export async function mountClearances({ data, apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatCard, renderStatus, renderClearanceTable, refresh, openFingerprintLedger }) {
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
    const screeningResults = Array.isArray(record.screening_results)
      ? record.screening_results
      : (() => {
        try {
          return JSON.parse(record.screening_results || '[]');
        } catch {
          return [];
        }
      })();
    dialog.innerHTML = `
      <form method="dialog" class="dialog-close-form"><button class="dialog-close" aria-label="Close">×</button></form>
      <p class="eyebrow">CLEARANCE WORKFLOW</p><h2>${escapeHtml(record.application_id || 'Application')}</h2>
      <p>${escapeHtml(record.applicant_name || 'Applicant not recorded')} · ${escapeHtml(record.barangay || 'Barangay not recorded')}</p>
      <dl class="dialog-facts"><div><dt>Development</dt><dd>${escapeHtml(record.project_type || '—')}</dd></div>
        <div><dt>Proposed land use</dt><dd>${escapeHtml(record.land_use_category || '—')}</dd></div>
        <div><dt>Parcel area</dt><dd>${record.area_sqm ? `${Number(record.area_sqm).toLocaleString()} m²` : 'Not available'}</dd></div>
        <div><dt>Current status</dt><dd>${renderStatus(record.status)}</dd></div></dl>
      ${screeningResults.length ? `<div class="screening-summary">${renderScreening(screeningResults, 1, escapeHtml)}</div>` : ''}
      ${record.application_id ? `<form id="clearance-status-form" class="form-stack compact-form">
        <label for="workflow-status">Lifecycle status</label><select id="workflow-status">${lifecycleStatuses.map((status) => `<option ${String(record.status).toLowerCase() === status.toLowerCase() ? 'selected' : ''}>${status}</option>`).join('')}</select>
        <button class="button button-outline" type="submit">Save status</button>
      </form>` : '<p class="notice notice-amber">This older record has no stable reference; workflow actions are unavailable until its application ID is migrated.</p>'}
      ${record.parcel_geojson && record.application_id && String(record.status).toLowerCase() === 'approved' ? `<form id="issue-certificate-form" class="form-stack compact-form">
        <label for="approved-land-use">Approved land use</label><input id="approved-land-use" value="${escapeHtml(record.approved_land_use || record.land_use_category || '')}" maxlength="100" required>
        <label for="certificate-type">Document type</label><select id="certificate-type"><option ${record.certificate_type === 'Locational Certificate' ? 'selected' : ''}>Locational Certificate</option><option ${record.certificate_type === 'Zoning Clearance' ? 'selected' : ''}>Zoning Clearance</option></select>
        <label for="permit-valid-until">Valid until</label><input id="permit-valid-until" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${escapeHtml(record.permit_valid_until || '')}" required>
        <button class="button button-primary" type="submit">${record.qr_reference ? 'Re-issue certificate' : 'Issue locational certificate'}</button>
      </form>` : record.parcel_geojson && record.application_id
        ? '<p class="notice notice-amber">Approve this application and save its status before issuing a certificate.</p>'
        : '<p class="notice notice-amber">Certificate issuance requires a parcel recorded by the location-clearance form.</p>'}
      <div id="certificate-preview"></div>
      <p id="dialog-feedback" class="form-message" aria-live="polite"></p>`;
    dialog.showModal();
    dialog.querySelector('.dialog-close-form').addEventListener('submit', () => dialog.close());
    dialog.querySelector('#clearance-status-form')?.addEventListener('submit', async (event) => {
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
        await showCertificate({
          applicationId: record.application_id,
          applicantName: record.applicant_name,
          projectType: record.project_type,
          barangay: record.barangay,
          area: record.area_sqm,
          landUse: dialog.querySelector('#approved-land-use').value.trim(),
          certificateType: dialog.querySelector('#certificate-type').value,
          validUntil: dialog.querySelector('#permit-valid-until').value,
          qrReference: result.qr_reference,
          permitStatus: result.permit_status,
        });
        Object.assign(record, {
          status: 'Approved',
          approved_land_use: dialog.querySelector('#approved-land-use').value.trim(),
          certificate_type: dialog.querySelector('#certificate-type').value,
          permit_valid_until: dialog.querySelector('#permit-valid-until').value,
          qr_reference: result.qr_reference,
          permit_status: result.permit_status,
        });
        feedback.textContent = 'Locational certificate issued and QR reference ready.';
      } catch (error) {
        feedback.textContent = error.message || 'Unable to issue the digital clearance.';
        feedback.classList.add('error');
      }
    });
    if (record.qr_reference) {
      showCertificate({
        applicationId: record.application_id,
        applicantName: record.applicant_name,
        projectType: record.project_type,
        barangay: record.barangay,
        area: record.area_sqm,
        landUse: record.approved_land_use || record.land_use_category,
        certificateType: record.certificate_type || 'Locational Certificate',
        validUntil: record.permit_valid_until,
        qrReference: record.qr_reference,
        permitStatus: record.permit_status || 'Valid',
      }).catch((error) => {
        console.error('Unable to render the existing clearance QR code.', error);
      });
    }

    async function showCertificate(certificate) {
      const qrImage = await QRCode.toDataURL(certificate.qrReference, { width: 180, margin: 1 });
      if (!dialog.open) return;
      const validUntil = formatDate(certificate.validUntil);
      const area = Number(certificate.area);
      dialog.querySelector('#certificate-preview').innerHTML = `
        <section class="certificate-preview"><img src="${qrImage}" alt="QR code for ${escapeHtml(certificate.qrReference)}">
          <div><p class="eyebrow">ISSUED DOCUMENT</p><strong>${escapeHtml(certificate.certificateType)}</strong>
            <p>Reference: <code>${escapeHtml(certificate.qrReference)}</code></p>
            <p>Permit status: ${escapeHtml(certificate.permitStatus || 'Valid')} · Expires ${escapeHtml(validUntil)}</p>
            <div class="certificate-actions"><button type="button" id="print-certificate" class="button button-outline">Print / Save as PDF</button>
              <button type="button" id="fingerprint-certificate" class="button button-outline">Record PDF fingerprint</button></div>
            <p class="certificate-ledger-help">Save the printed certificate as a PDF, then select that exact file in the fingerprint ledger.</p></div></section>`;
      dialog.querySelector('#print-certificate').addEventListener('click', () => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
          const printFeedback = dialog.querySelector('#dialog-feedback');
          printFeedback.textContent = 'Allow pop-ups to open the printable certificate.';
          printFeedback.classList.add('error');
          return;
        }
        printWindow.opener = null;
        printWindow.addEventListener('load', () => {
          printWindow.focus();
          printWindow.print();
        }, { once: true });
        printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(certificate.certificateType)} - ${escapeHtml(certificate.qrReference)}</title>
          <style>
            @page { size: A4; margin: 18mm; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #17233c; font: 14px Arial, sans-serif; }
            .certificate { min-height: 250mm; border: 5px double #183a80; padding: 18mm 16mm; position: relative; }
            .header { text-align: center; border-bottom: 1px solid #aebbd2; padding-bottom: 14px; }
            .seal { display: inline-flex; width: 48px; height: 48px; align-items: center; justify-content: center; border: 2px solid #183a80; border-radius: 50%; color: #183a80; font-size: 23px; font-weight: bold; }
            .header h1 { margin: 10px 0 3px; font-size: 19px; letter-spacing: 1.2px; }
            .header p { margin: 3px 0; color: #495775; font-size: 11px; }
            h2 { margin: 25px 0 20px; color: #183a80; font: bold 23px Georgia, serif; text-align: center; text-transform: uppercase; }
            .intro { margin: 0 0 17px; line-height: 1.8; text-align: justify; }
            .facts { border-collapse: collapse; width: 100%; margin: 10px 0 22px; }
            .facts th, .facts td { border-bottom: 1px solid #dce2ec; padding: 10px 7px; text-align: left; vertical-align: top; }
            .facts th { width: 34%; color: #455371; font-size: 11px; text-transform: uppercase; }
            .facts td { font-weight: bold; }
            .verify { display: flex; align-items: center; gap: 16px; margin-top: 20px; padding: 12px; border: 1px solid #dce2ec; }
            .verify img { width: 112px; height: 112px; }
            .verify p { margin: 5px 0; font-size: 10px; overflow-wrap: anywhere; }
            .signatures { display: flex; justify-content: space-between; gap: 35px; margin-top: 42px; }
            .signature { width: 45%; border-top: 1px solid #263149; padding-top: 7px; text-align: center; font-size: 10px; }
            .footer { margin-top: 22px; color: #59657b; font-size: 9px; line-height: 1.5; text-align: center; }
          </style></head><body><main class="certificate">
          <header class="header"><span class="seal">B</span><h1>REPUBLIC OF THE PHILIPPINES</h1><p>PROVINCE OF ORIENTAL MINDORO</p><p>MUNICIPALITY OF BACO</p><p>MUNICIPAL PLANNING AND DEVELOPMENT OFFICE</p></header>
          <h2>${escapeHtml(certificate.certificateType)}</h2>
          <p class="intro">Following approval, this ${escapeHtml(certificate.certificateType.toLowerCase())} is issued to <strong>${escapeHtml(certificate.applicantName || '—')}</strong> for the proposed development below, subject to applicable laws, regulations, and the conditions of the approved land use.</p>
          <table class="facts"><tbody>
            <tr><th>Application ID</th><td>${escapeHtml(certificate.applicationId)}</td></tr>
            <tr><th>Project / development</th><td>${escapeHtml(certificate.projectType || '—')}</td></tr>
            <tr><th>Location</th><td>Barangay ${escapeHtml(certificate.barangay || '—')}, Baco, Oriental Mindoro</td></tr>
            <tr><th>Approved land use</th><td>${escapeHtml(certificate.landUse || '—')}</td></tr>
            <tr><th>Parcel area</th><td>${Number.isFinite(area) && area > 0 ? `${area.toLocaleString()} m²` : 'Not available'}</td></tr>
            <tr><th>Issued</th><td>${escapeHtml(formatDate(new Date().toISOString().slice(0, 10)))}</td></tr>
            <tr><th>Valid until</th><td>${escapeHtml(validUntil)}</td></tr>
            <tr><th>Certificate reference</th><td>${escapeHtml(certificate.qrReference)}</td></tr>
          </tbody></table>
          <p class="intro">This certificate applies only to the location and land use recorded above. The QR code provides a linkable reference for field verification; confirm current permit status with the Municipality of Baco.</p>
          <section class="verify"><img src="${qrImage}" alt="Certificate verification QR code"><div><strong>FIELD VERIFICATION</strong><p>Scan the QR code or provide this reference: <strong>${escapeHtml(certificate.qrReference)}</strong></p><p>For PDF integrity verification, record the saved PDF in the MapAngat document fingerprint ledger.</p></div></section>
          <div class="signatures"><div class="signature">Prepared by · MPDO</div><div class="signature">Authorized signature</div></div>
          <p class="footer">Issued through MapAngat · Baco, Oriental Mindoro · Verify approval and validity using the certificate reference.</p>
          </main></body></html>`);
        printWindow.document.close();
      });
      dialog.querySelector('#fingerprint-certificate').addEventListener('click', () => {
        openFingerprintLedger(certificate.qrReference);
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
