import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';

function isPermitValid(record) {
  if (record.permit_validity !== 'Valid') return false;
  return !record.permit_valid_until || record.permit_valid_until >= new Date().toISOString().slice(0, 10);
}

export async function mountVerification({ apiFetch, escapeHtml, formatDate, renderPageHeading, renderStatus, state, sha256File, verifyPdf }) {
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('verification', false)}
    <div class="content-grid verification-grid">
      <section class="panel verification-panel">
        <div class="scan-placeholder"><span class="qr-icon">▧</span><h2>Field permit verification</h2><p>Scan a clearance QR code or enter its application / QR reference.</p></div>
        <div class="scanner-actions"><button id="start-qr-camera" class="button button-primary" type="button">Start QR camera</button><button id="stop-qr-camera" class="button button-outline" type="button" disabled>Stop camera</button></div>
        <video id="qr-video" class="qr-video" playsinline muted hidden aria-label="QR scanner camera preview"></video>
        <form id="record-lookup" class="lookup-form"><label class="sr-only" for="record-code">Application or QR reference</label><input id="record-code" placeholder="e.g. LC-2026-AD12F4" required><button class="button button-primary">Find record</button></form>
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

  const video = document.querySelector('#qr-video');
  const startButton = document.querySelector('#start-qr-camera');
  const stopButton = document.querySelector('#stop-qr-camera');
  const lookupFeedback = document.querySelector('#lookup-feedback');
  let stream = null;
  let detector = null;
  let scanFrame = 0;
  let map = null;

  const stopCamera = () => {
    if (scanFrame) cancelAnimationFrame(scanFrame);
    scanFrame = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
    startButton.disabled = false;
    stopButton.disabled = true;
  };
  stopButton.addEventListener('click', stopCamera);
  startButton.addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      lookupFeedback.textContent = 'Camera access is not available. Enter the printed reference manually.';
      lookupFeedback.classList.add('error');
      return;
    }
    if (!('BarcodeDetector' in window)) {
      lookupFeedback.textContent = 'This browser cannot decode QR codes from camera video. Enter the printed reference manually.';
      lookupFeedback.classList.add('error');
      return;
    }
    try {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      startButton.disabled = true;
      stopButton.disabled = false;
      lookupFeedback.textContent = 'Camera active. Center the clearance QR code in view.';
      lookupFeedback.classList.remove('error');
      const detectFrame = async () => {
        if (!stream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length && codes[0].rawValue) {
            document.querySelector('#record-code').value = codes[0].rawValue.trim();
            stopCamera();
            await lookup(codes[0].rawValue.trim());
            return;
          }
        } catch (error) {
          lookupFeedback.textContent = error.message || 'The camera could not decode a QR code.';
          lookupFeedback.classList.add('error');
          stopCamera();
          return;
        }
        scanFrame = requestAnimationFrame(detectFrame);
      };
      scanFrame = requestAnimationFrame(detectFrame);
    } catch (error) {
      stopCamera();
      lookupFeedback.textContent = error.message || 'Unable to start the camera. Check browser permission and HTTPS.';
      lookupFeedback.classList.add('error');
    }
  });

  async function lookup(reference) {
    const details = document.querySelector('#record-details');
    if (map) {
      map.remove();
      map = null;
    }
    details.hidden = true;
    lookupFeedback.textContent = 'Looking up permit…';
    lookupFeedback.classList.remove('error');
    try {
      const result = await apiFetch(`/api/clearances/lookup?reference=${encodeURIComponent(reference)}`);
      if (!details.isConnected) return;
      const record = result.clearance;
      const validity = record.permit_validity || 'Not issued';
      const geojson = typeof record.parcel_geojson === 'string'
        ? JSON.parse(record.parcel_geojson)
        : record.parcel_geojson;
      details.innerHTML = `
        <p class="eyebrow">VERIFIED LOCATION CLEARANCE</p><h3>${escapeHtml(record.application_id)}</h3>
        <div class="verification-validity ${isPermitValid(record) ? 'valid' : 'invalid'}"><strong>${escapeHtml(validity)}</strong><span>${record.permit_valid_until ? `Valid through ${escapeHtml(formatDate(record.permit_valid_until))}` : 'No issued validity date'}</span></div>
        <dl><div><dt>Applicant</dt><dd>${escapeHtml(record.applicant_name || '—')}</dd></div>
          <div><dt>Approved land use</dt><dd>${escapeHtml(record.approved_land_use || 'Not issued')}</dd></div>
          <div><dt>Barangay</dt><dd>${escapeHtml(record.barangay || '—')}</dd></div>
          <div><dt>Application status</dt><dd>${renderStatus(record.status)}</dd></div>
          <div><dt>Permit reference</dt><dd>${escapeHtml(record.qr_reference || 'Not issued')}</dd></div>
          <div><dt>Parcel area</dt><dd>${record.area_sqm ? `${Number(record.area_sqm).toLocaleString()} m²` : 'Not available'}</dd></div></dl>
        ${geojson ? '<div id="parcel-preview-map" class="parcel-preview-map" aria-label="Permit parcel map preview"></div>' : '<p class="notice notice-amber">No parcel geometry was recorded for this clearance.</p>'}
        <form id="field-inspection-form" class="form-stack compact-form">
          <h3>On-site field inspection</h3>
          <label for="inspector-name">Inspector name</label><input id="inspector-name" name="inspector_name" maxlength="150" value="${escapeHtml(state.user?.full_name || state.user?.username || '')}" required>
          <label for="inspection-findings">Inspection findings</label><textarea id="inspection-findings" name="findings" rows="3" maxlength="5000" required></textarea>
          <label for="inspection-photo-url">Photo attachment URL <span class="label-muted">(optional)</span></label><input id="inspection-photo-url" name="photo_url" type="url" maxlength="2048" placeholder="https://…">
          <div class="geo-fields"><label for="inspection-latitude">Latitude</label><input id="inspection-latitude" name="latitude" type="number" step="any" placeholder="Optional"><label for="inspection-longitude">Longitude</label><input id="inspection-longitude" name="longitude" type="number" step="any" placeholder="Optional"></div>
          <button type="button" id="use-inspection-location" class="button button-outline">Use current location</button>
          <button type="submit" class="button button-primary">Submit inspection log</button>
          <p id="inspection-feedback" class="form-message" aria-live="polite"></p>
        </form>`;
      details.hidden = false;
      lookupFeedback.textContent = 'Record found. Confirm site details and permit validity before proceeding.';
      const form = details.querySelector('#field-inspection-form');
      details.querySelector('#use-inspection-location').addEventListener('click', () => {
        const feedback = details.querySelector('#inspection-feedback');
        if (!navigator.geolocation) {
          feedback.textContent = 'Geolocation is not available in this browser.';
          feedback.classList.add('error');
          return;
        }
        navigator.geolocation.getCurrentPosition(({ coords }) => {
          details.querySelector('#inspection-latitude').value = coords.latitude.toFixed(7);
          details.querySelector('#inspection-longitude').value = coords.longitude.toFixed(7);
          feedback.textContent = 'Current location added.';
          feedback.classList.remove('error');
        }, (error) => {
          feedback.textContent = error.message || 'Unable to read the current location.';
          feedback.classList.add('error');
        }, { enableHighAccuracy: true, timeout: 10000 });
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('[type="submit"]');
        const feedback = details.querySelector('#inspection-feedback');
        button.disabled = true;
        try {
          await apiFetch('/api/inspections', true, {
            method: 'POST',
            body: {
              application_id: record.application_id,
              inspector_name: form.elements.inspector_name.value.trim(),
              findings: form.elements.findings.value.trim(),
              photo_url: form.elements.photo_url.value.trim(),
              latitude: form.elements.latitude.value || null,
              longitude: form.elements.longitude.value || null,
            },
          });
          feedback.textContent = 'Field inspection log submitted.';
          form.reset();
          form.elements.inspector_name.value = state.user?.full_name || state.user?.username || '';
        } catch (error) {
          feedback.textContent = error.message || 'Unable to submit the inspection log.';
          feedback.classList.add('error');
        } finally {
          button.disabled = false;
        }
      });
      if (geojson) {
        const parcelMap = L.map('parcel-preview-map', { zoomControl: false, dragging: false, scrollWheelZoom: false }).setView([13.3182, 121.0925], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(parcelMap);
        const parcelLayer = L.geoJSON(geojson, { style: { color: '#0038de', fillColor: '#5d7cff', fillOpacity: 0.3 } }).addTo(parcelMap);
        if (parcelLayer.getBounds().isValid()) parcelMap.fitBounds(parcelLayer.getBounds().pad(0.25));
        map = parcelMap;
      }
    } catch (error) {
      if (!details.isConnected) return;
      lookupFeedback.textContent = error.message || 'Unable to find a clearance record.';
      lookupFeedback.classList.add('error');
    }
  }

  document.querySelector('#record-lookup').addEventListener('submit', (event) => {
    event.preventDefault();
    lookup(document.querySelector('#record-code').value.trim());
  });

  const fileError = (file) => !file
    ? 'Select a PDF file first.'
    : (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name) ? 'Select a PDF file.' : '');
  const describeBlock = (block) => `
    <strong>Ledger block ${escapeHtml(block.index)}</strong><br>
    SHA-256: <code>${escapeHtml(block.documentHash)}</code><br>
    Block hash: <code>${escapeHtml(block.currentHash)}</code>`;

  document.querySelector('#ledger-verify-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = document.querySelector('#ledger-verify-message');
    const file = form.elements['ledger-verify-file'].files[0];
    if (fileError(file)) {
      feedback.textContent = fileError(file);
      feedback.classList.add('error');
      return;
    }
    feedback.textContent = 'Calculating and checking the document fingerprint…';
    feedback.classList.remove('error');
    try {
      const result = await verifyPdf(form.elements['ledger-verify-reference'].value.trim(), file);
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
    if (fileError(file)) {
      feedback.textContent = fileError(file);
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
      const qrImage = await QRCode.toDataURL(form.elements['ledger-anchor-reference'].value.trim(), { width: 180, margin: 1 });
      feedback.insertAdjacentHTML('beforeend', `<div class="ledger-qr"><img src="${qrImage}" alt="QR code for ${escapeHtml(form.elements['ledger-anchor-reference'].value.trim())}"></div>`);
    } catch (error) {
      feedback.textContent = error.message || 'Unable to add this document to the ledger.';
      feedback.classList.add('error');
    }
  });

  return () => {
    stopCamera();
    map?.remove();
  };
}
