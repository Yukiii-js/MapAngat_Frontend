import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';
import { jsPDF } from 'jspdf';
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

function buildCertificatePdf(certificate, qrImage, formatDate) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pageWidth = 210;
  const blue = [24, 58, 128];
  const dark = [23, 35, 60];
  const muted = [73, 87, 117];
  const left = 16;
  const right = 194;
  const width = right - left;
  const valueX = 64;
  const valueWidth = right - valueX;
  const reference = String(certificate.qrReference || 'certificate');
  pdf.setProperties({
    title: `${certificate.certificateType} - ${reference}`,
    subject: `Location clearance ${certificate.applicationId}`,
    author: 'Municipal Planning and Development Office, Baco',
  });
  pdf.setDrawColor(...blue);
  pdf.setLineWidth(0.8);
  pdf.rect(8, 8, 194, 281);
  pdf.setLineWidth(0.25);
  pdf.rect(10, 10, 190, 277);

  pdf.setTextColor(...blue);
  pdf.setLineWidth(0.7);
  pdf.circle(pageWidth / 2, 24, 5.5);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text('B', pageWidth / 2, 28.5, { align: 'center' });
  pdf.setFontSize(10);
  pdf.text('REPUBLIC OF THE PHILIPPINES', pageWidth / 2, 37, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text('PROVINCE OF ORIENTAL MINDORO', pageWidth / 2, 42, { align: 'center' });
  pdf.text('MUNICIPALITY OF BACO', pageWidth / 2, 46, { align: 'center' });
  pdf.text('MUNICIPAL PLANNING AND DEVELOPMENT OFFICE', pageWidth / 2, 50, { align: 'center' });
  pdf.setDrawColor(174, 187, 210);
  pdf.line(left, 56, right, 56);

  pdf.setTextColor(...blue);
  pdf.setFont('times', 'bold');
  pdf.setFontSize(18);
  pdf.text(String(certificate.certificateType || 'Location Clearance').toUpperCase(), pageWidth / 2, 68, { align: 'center' });

  const applicant = certificate.applicantName || 'Applicant not recorded';
  const certificateType = String(certificate.certificateType || 'location clearance').toLowerCase();
  const introduction = `Following approval, this ${certificateType} is issued to ${applicant} for the proposed development below, subject to applicable laws, regulations, and the conditions of the approved land use.`;
  pdf.setTextColor(...dark);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9.5);
  const introLines = pdf.splitTextToSize(introduction, width);
  pdf.text(introLines, left, 78);
  let y = 78 + introLines.length * 4.3 + 4;

  const area = Number(certificate.area);
  const details = [
    ['APPLICATION ID', certificate.applicationId || 'Not available'],
    ['APPLICANT', applicant],
    ['PROJECT / DEVELOPMENT', certificate.projectType || 'Not available'],
    ['LOCATION', `Barangay ${certificate.barangay || 'Not available'}, Baco, Oriental Mindoro`],
    ['APPROVED LAND USE', certificate.landUse || 'Not available'],
    ['PARCEL AREA', Number.isFinite(area) && area > 0 ? `${area.toLocaleString()} m2` : 'Not available'],
    ['ISSUED', formatDate(new Date().toISOString().slice(0, 10))],
    ['VALID UNTIL', formatDate(certificate.validUntil)],
    ['CERTIFICATE REFERENCE', reference],
  ];
  details.forEach(([label, value]) => {
    const lines = pdf.splitTextToSize(String(value), valueWidth);
    const rowHeight = Math.max(8, lines.length * 4.1 + 3);
    pdf.setDrawColor(220, 226, 236);
    pdf.line(left, y + rowHeight, right, y + rowHeight);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.2);
    pdf.setTextColor(...muted);
    pdf.text(label, left + 1, y + 5.2);
    pdf.setFontSize(9);
    pdf.setTextColor(...dark);
    pdf.text(lines, valueX, y + 5.2);
    y += rowHeight;
  });

  const note = 'This certificate applies only to the location and land use recorded above. Confirm the current approval and validity using the certificate reference.';
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(...dark);
  const noteLines = pdf.splitTextToSize(note, width);
  y += 7;
  pdf.text(noteLines, left, y);
  y += noteLines.length * 4 + 5;

  const verificationY = Math.max(y, 205);
  pdf.setDrawColor(220, 226, 236);
  pdf.rect(left, verificationY, width, 43);
  pdf.addImage(qrImage, 'PNG', left + 5, verificationY + 3.5, 36, 36);
  pdf.setTextColor(...blue);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('FIELD VERIFICATION', left + 48, verificationY + 10);
  pdf.setTextColor(...dark);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text(pdf.splitTextToSize(`Scan the QR code or provide this reference: ${reference}`, width - 58), left + 48, verificationY + 17);
  pdf.text(pdf.splitTextToSize('For PDF integrity, upload this downloaded file to the MapAngat document fingerprint ledger.', width - 58), left + 48, verificationY + 29);

  const signatureY = Math.min(verificationY + 57, 265);
  pdf.setDrawColor(...dark);
  pdf.line(left + 5, signatureY, left + 78, signatureY);
  pdf.line(right - 78, signatureY, right - 5, signatureY);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(...muted);
  pdf.text('PREPARED BY - MPDO', left + 41.5, signatureY + 5, { align: 'center' });
  pdf.text('AUTHORIZED SIGNATURE', right - 41.5, signatureY + 5, { align: 'center' });
  pdf.setFontSize(7);
  pdf.text('Issued through MapAngat - Baco, Oriental Mindoro', pageWidth / 2, 281, { align: 'center' });
  return pdf;
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
      dialog.querySelector('#certificate-preview').innerHTML = `
        <section class="certificate-preview"><img src="${qrImage}" alt="QR code for ${escapeHtml(certificate.qrReference)}">
          <div><p class="eyebrow">ISSUED DOCUMENT</p><strong>${escapeHtml(certificate.certificateType)}</strong>
            <p>Reference: <code>${escapeHtml(certificate.qrReference)}</code></p>
            <p>Permit status: ${escapeHtml(certificate.permitStatus || 'Valid')} · Expires ${escapeHtml(validUntil)}</p>
            <div class="certificate-actions"><button type="button" id="print-certificate" class="button button-outline">Download certificate PDF</button>
              <button type="button" id="fingerprint-certificate" class="button button-outline">Record PDF fingerprint</button></div>
            <p class="certificate-ledger-help">Download the PDF, then select that exact file in the fingerprint ledger. You can print the downloaded PDF from your PDF viewer.</p></div></section>`;
      dialog.querySelector('#print-certificate').addEventListener('click', () => {
        const downloadButton = dialog.querySelector('#print-certificate');
        const feedback = dialog.querySelector('#dialog-feedback');
        downloadButton.disabled = true;
        try {
          const pdf = buildCertificatePdf(certificate, qrImage, formatDate);
          const fileName = `${String(certificate.qrReference || 'certificate').replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`;
          pdf.save(fileName);
          feedback.textContent = 'Certificate PDF download started. Upload this exact PDF to record its fingerprint.';
          feedback.classList.remove('error');
        } catch (error) {
          feedback.textContent = error.message || 'Unable to generate the certificate PDF.';
          feedback.classList.add('error');
        } finally {
          downloadButton.disabled = false;
        }
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
