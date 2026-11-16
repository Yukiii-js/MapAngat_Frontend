function formatTimestamp(value) {
  if (!value) return 'Never synced';
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function statusMarkup(status, escapeHtml) {
  const normalized = String(status || 'idle').toLowerCase();
  const label = normalized === 'success' ? 'Online' : normalized === 'error' ? 'Error' : 'Not synced';
  const tone = normalized === 'success' ? 'success' : normalized === 'error' ? 'danger' : 'neutral';
  return `<span class="status-badge ${tone}">${escapeHtml(label)}</span>`;
}

export async function mountExternalApis({ apiFetch, escapeHtml, renderPageHeading }) {
  const content = document.querySelector('#page-content');
  const send = (path, request) => apiFetch(path, true, request);

  const load = async (notice = '') => {
    const result = await apiFetch('/api/admin/external-apis');
    const apis = result.apis || [];
    const events = result.events || [];
    const datasets = result.datasets || [];
    content.innerHTML = `
      ${renderPageHeading('external-apis')}
      ${notice ? `<p class="form-message ${notice.type === 'error' ? 'error' : ''}" role="status">${escapeHtml(notice.message)}</p>` : ''}
      <div class="external-api-grid">
        ${apis.map((api) => {
          const bounds = api.bounding_box || {};
          const radius = bounds.maxradiuskm ?? bounds.buffer_km ?? 500;
          return `<article class="panel external-api-card" data-api="${escapeHtml(api.api_key)}">
            <div class="external-api-card-heading">
              <div><p class="eyebrow">EXTERNAL DATA SOURCE</p><h2>${escapeHtml(api.display_name)}</h2></div>
              ${statusMarkup(api.last_status, escapeHtml)}
            </div>
            <p class="panel-description">${escapeHtml(api.endpoint_url)}</p>
            <div class="external-api-metrics"><span><strong>${escapeHtml(api.current_record_count)}</strong> cached records</span><span>Last sync: ${escapeHtml(formatTimestamp(api.last_synced_at))}</span><span>Last request: ${api.last_latency_ms ? `${escapeHtml(api.last_latency_ms)} ms` : 'Not measured'}</span></div>
            ${api.last_error_message ? `<p class="external-api-error">${escapeHtml(api.last_error_message)}</p>` : ''}
            <label class="external-enable"><input type="checkbox" data-enable-api ${api.is_enabled ? 'checked' : ''}><span>Automatic sync enabled</span></label>
            <form class="external-config-form" data-api="${escapeHtml(api.api_key)}">
              <label>Sync interval (minutes)<input name="sync_interval_minutes" type="number" min="5" max="1440" step="5" value="${escapeHtml(api.sync_interval_minutes)}" required></label>
              ${api.api_key === 'usgs' ? `
                <label>Minimum magnitude<input name="min_magnitude" type="number" min="1" max="6" step="0.1" value="${escapeHtml(api.min_magnitude)}"></label>
                <label>Search radius (km)<input name="radius" type="number" min="1" max="1000" value="${escapeHtml(radius)}"></label>
              ` : ''}
              ${api.api_key === 'gdacs' ? `
                <label>Alert levels<input name="alert_levels" value="${escapeHtml(api.alert_levels)}" aria-describedby="gdacs-level-help"></label>
                <small id="gdacs-level-help">Comma-separated: Green, Orange, Red</small>
                <label>Regional buffer (km)<input name="radius" type="number" min="1" max="1000" value="${escapeHtml(radius)}"></label>
              ` : ''}
              <button class="button button-outline" type="submit">Save settings</button>
              <button class="button button-primary external-sync-button" type="button" data-sync="${escapeHtml(api.api_key)}">Sync now</button>
            </form>
          </article>`;
        }).join('')}
      </div>
      <section class="panel external-dataset-panel">
        <div class="panel-heading"><div><h2>HDX spatial datasets</h2><p>Toggle cached GeoJSON layers shown in the Web-GIS map.</p></div></div>
        <div class="external-dataset-list">
          ${datasets.length ? datasets.map((dataset) => `<label class="external-dataset-row">
            <input type="checkbox" data-dataset-id="${escapeHtml(dataset.id)}" ${dataset.is_active_layer ? 'checked' : ''}>
            <span><strong>${escapeHtml(dataset.title)}</strong><small>${escapeHtml(dataset.category)} · ${escapeHtml(dataset.dataset_slug)}</small></span>
            <span class="status-badge ${dataset.geojson?.type === 'FeatureCollection' || dataset.geojson?.type === 'Feature' ? 'success' : 'neutral'}">${dataset.geojson?.type === 'FeatureCollection' || dataset.geojson?.type === 'Feature' ? 'GeoJSON' : 'Metadata only'}</span>
          </label>`).join('') : '<p class="table-empty">No HDX datasets are cached. Run an HDX sync to discover available datasets.</p>'}
        </div>
      </section>
      <section class="panel external-events-panel">
        <div class="panel-heading"><div><h2>External event moderation</h2><p>Manage which cached USGS and GDACS events appear in the resident feed.</p></div></div>
        <div class="external-event-list">
          ${events.length ? events.map((event) => `<article class="external-event-row">
            <div class="external-event-details">
              <div><span class="external-source-badge">${escapeHtml(event.source.toUpperCase())}</span><span class="status-badge ${event.severity_level === 'red' ? 'danger' : event.severity_level === 'orange' ? 'warning' : 'success'}">${escapeHtml(event.severity_level)}</span></div>
              <strong>${escapeHtml(event.title)}</strong>
              <small>${escapeHtml(event.hazard_type)} · ${escapeHtml(event.distance_to_municipality_km)} km · ${escapeHtml(formatTimestamp(event.event_timestamp))}${event.affected_population ? ` · ${escapeHtml(event.affected_population)} GDACS-reported population` : ''}</small>
            </div>
            <button type="button" class="button ${event.is_published_to_residents ? 'button-outline' : 'button-primary'}" data-event-id="${escapeHtml(event.id)}" data-published="${event.is_published_to_residents ? '1' : '0'}">
              ${event.is_published_to_residents ? 'Hide from resident feed' : 'Publish to resident feed'}
            </button>
          </article>`).join('') : '<p class="table-empty">No external events have been cached yet. Sync USGS or GDACS to populate this queue.</p>'}
        </div>
      </section>`;

    content.querySelectorAll('.external-config-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const key = form.dataset.api;
        const body = {
          sync_interval_minutes: Number(form.elements.sync_interval_minutes.value),
        };
        if (key === 'usgs') {
          body.min_magnitude = Number(form.elements.min_magnitude.value);
          body.bounding_box = {
            latitude: 13.3578,
            longitude: 121.0978,
            maxradiuskm: Number(form.elements.radius.value),
          };
        }
        if (key === 'gdacs') {
          body.alert_levels = form.elements.alert_levels.value;
          body.bounding_box = {
            latitude: 13.3578,
            longitude: 121.0978,
            buffer_km: Number(form.elements.radius.value),
          };
        }
        const button = form.querySelector('[type="submit"]');
        button.disabled = true;
        try {
          await send(`/api/admin/external-apis/${encodeURIComponent(key)}/config`, {
            method: 'PATCH',
            body,
          });
          await load({ message: 'API settings saved.', type: 'success' });
        } catch (error) {
          button.disabled = false;
          const feedback = document.createElement('p');
          feedback.className = 'external-api-error';
          feedback.setAttribute('role', 'alert');
          feedback.textContent = error.message || 'Unable to save API settings.';
          form.append(feedback);
        }
      });
    });

    content.querySelectorAll('[data-enable-api]').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        const key = checkbox.closest('[data-api]').dataset.api;
        checkbox.disabled = true;
        try {
          await send(`/api/admin/external-apis/${encodeURIComponent(key)}/config`, {
            method: 'PATCH',
            body: { is_enabled: checkbox.checked },
          });
          await load({ message: `Automatic sync ${checkbox.checked ? 'enabled' : 'disabled'} for ${key.toUpperCase()}.`, type: 'success' });
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          checkbox.disabled = false;
          window.alert(error.message || 'Unable to update API status.');
        }
      });
    });

    content.querySelectorAll('[data-sync]').forEach((button) => {
      button.addEventListener('click', async () => {
        const key = button.dataset.sync;
        button.disabled = true;
        button.textContent = 'Syncing…';
        try {
          await send(`/api/admin/external-apis/${encodeURIComponent(key)}/sync`, {
            method: 'POST',
            body: {},
          });
          await load({ message: `${key.toUpperCase()} sync completed.`, type: 'success' });
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Sync now';
          const feedback = document.createElement('p');
          feedback.className = 'external-api-error';
          feedback.setAttribute('role', 'alert');
          feedback.textContent = error.message || 'Sync failed. Cached records remain available.';
          button.after(feedback);
        }
      });
    });

    content.querySelectorAll('[data-event-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await send(`/api/admin/external-events/${encodeURIComponent(button.dataset.eventId)}/visibility`, {
            method: 'PATCH',
            body: { is_published_to_residents: button.dataset.published !== '1' },
          });
          await load({ message: 'Resident feed visibility updated.', type: 'success' });
        } catch (error) {
          button.disabled = false;
          window.alert(error.message || 'Unable to update event visibility.');
        }
      });
    });

    content.querySelectorAll('[data-dataset-id]').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true;
        try {
          await send(`/api/admin/hdx-datasets/${encodeURIComponent(checkbox.dataset.datasetId)}/visibility`, {
            method: 'PATCH',
            body: { is_active_layer: checkbox.checked },
          });
          await load({ message: 'HDX map layer visibility updated.', type: 'success' });
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          checkbox.disabled = false;
          window.alert(error.message || 'Unable to update HDX layer visibility.');
        }
      });
    });
  };

  await load();
}
