function dateValue(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename, rows) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function mountAnalytics({ data, escapeHtml, formatDate, renderPageHeading, renderStatus }) {
  const barangays = [...new Set([
    ...data.clearances.map((item) => item.barangay),
    ...data.projects.map((item) => item.barangay),
  ].filter(Boolean))].sort();
  const landUses = [...new Set(data.clearances.map((item) => item.land_use_category).filter(Boolean))].sort();
  document.querySelector('#page-content').innerHTML = `
    ${renderPageHeading('analytics', false)}
    <section class="panel report-panel analytics-filters">
      <h2>Executive report filters</h2>
      <div class="report-filter-grid">
        <label for="report-from">Date from</label><input id="report-from" type="date">
        <label for="report-to">Date to</label><input id="report-to" type="date">
        <label for="report-barangay">Barangay</label><select id="report-barangay"><option value="">All barangays</option>${barangays.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select>
        <label for="report-land-use">Land use</label><select id="report-land-use"><option value="">All land uses</option>${landUses.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select>
        <label for="report-project-status">Project status</label><select id="report-project-status"><option value="">All project statuses</option><option>On track</option><option>At risk</option><option>Delayed</option></select>
      </div>
      <div class="report-actions"><button type="button" id="print-report" class="button button-primary">Print / Save PDF</button><button type="button" id="export-clearances" class="button button-outline">Export clearances CSV / Excel</button><button type="button" id="export-projects" class="button button-outline">Export projects CSV / Excel</button></div>
      <p class="panel-description">Use the browser print dialog to save a formatted PDF. CSV files are Excel-compatible and retain the filtered raw records.</p>
    </section>
    <section id="analytics-report" class="analytics-report">
      <div class="analytics-report-heading"><div><p class="eyebrow">MPDO · BACO, ORIENTAL MINDORO</p><h2>Spatial Intelligence &amp; Program Monitoring Report</h2></div><p id="report-generated"></p></div>
      <div id="report-summary" class="stats-grid three-cards"></div>
      <div class="content-grid analytics-tables">
        <section class="panel"><div class="panel-heading"><div><h2>Location clearances</h2><p id="clearance-report-count"></p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Reference</th><th>Applicant / project</th><th>Barangay</th><th>Land use</th><th>Area m²</th><th>Status</th><th>Submitted</th></tr></thead><tbody id="clearance-report-rows"></tbody></table></div></section>
        <section class="panel"><div class="panel-heading"><div><h2>Infrastructure projects</h2><p id="project-report-count"></p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Project</th><th>Barangay</th><th>Target</th><th>Actual</th><th>Budget execution</th><th>Status</th></tr></thead><tbody id="project-report-rows"></tbody></table></div></section>
      </div>
    </section>`;

  const filters = {
    from: document.querySelector('#report-from'),
    to: document.querySelector('#report-to'),
    barangay: document.querySelector('#report-barangay'),
    landUse: document.querySelector('#report-land-use'),
    status: document.querySelector('#report-project-status'),
  };
  let filteredClearances = [];
  let filteredProjects = [];
  const refresh = () => {
    filteredClearances = data.clearances.filter((record) => {
      const date = dateValue(record.created_at);
      return (!filters.from.value || (date && date >= filters.from.value))
        && (!filters.to.value || (date && date <= filters.to.value))
        && (!filters.barangay.value || record.barangay === filters.barangay.value)
        && (!filters.landUse.value || record.land_use_category === filters.landUse.value);
    });
    filteredProjects = data.projects.filter((project) => {
      const date = dateValue(project.created_at);
      return (!filters.from.value || (date && date >= filters.from.value))
        && (!filters.to.value || (date && date <= filters.to.value))
        && (!filters.barangay.value || project.barangay === filters.barangay.value)
        && (!filters.status.value || project.status === filters.status.value);
    });
    const avgProgress = filteredProjects.length
      ? filteredProjects.reduce((sum, project) => sum + (Number(project.progress) || 0), 0) / filteredProjects.length
      : 0;
    const budget = filteredProjects.reduce((result, project) => ({
      spent: result.spent + (Number(project.spent_budget) || 0),
      allocated: result.allocated + (Number(project.allocated_budget) || 0),
    }), { spent: 0, allocated: 0 });
    document.querySelector('#report-generated').textContent = `Generated ${new Date().toLocaleString()}`;
    document.querySelector('#report-summary').innerHTML = `
      <article class="stat-card"><div><p>Clearance applications</p><strong>${filteredClearances.length}</strong></div><span class="stat-icon blue">▤</span></article>
      <article class="stat-card"><div><p>Infrastructure projects</p><strong>${filteredProjects.length}</strong></div><span class="stat-icon green">▥</span></article>
      <article class="stat-card"><div><p>Average actual completion</p><strong>${avgProgress.toFixed(1)}%</strong><small>${budget.allocated ? `Budget execution ${((budget.spent / budget.allocated) * 100).toFixed(1)}%` : 'Project budgets not recorded'}</small></div><span class="stat-icon amber">%</span></article>`;
    document.querySelector('#clearance-report-count').textContent = `${filteredClearances.length} matching records`;
    document.querySelector('#project-report-count').textContent = `${filteredProjects.length} matching records`;
    document.querySelector('#clearance-report-rows').innerHTML = filteredClearances.length
      ? filteredClearances.map((record) => `<tr><td class="table-id">${escapeHtml(record.application_id || '—')}</td><td><strong>${escapeHtml(record.applicant_name || '—')}</strong><small>${escapeHtml(record.project_type || '—')}</small></td><td>${escapeHtml(record.barangay || '—')}</td><td>${escapeHtml(record.approved_land_use || record.land_use_category || '—')}</td><td>${record.area_sqm ? Number(record.area_sqm).toLocaleString() : '—'}</td><td>${renderStatus(record.status)}</td><td>${escapeHtml(formatDate(record.created_at))}</td></tr>`).join('')
      : '<tr><td colspan="7" class="table-empty">No clearance records match these filters.</td></tr>';
    document.querySelector('#project-report-rows').innerHTML = filteredProjects.length
      ? filteredProjects.map((project) => {
        const allocated = Number(project.allocated_budget) || 0;
        const spent = Number(project.spent_budget) || 0;
        const budgetStatus = allocated ? `${((spent / allocated) * 100).toFixed(1)}% (₱${spent.toLocaleString()} / ₱${allocated.toLocaleString()})` : 'Not recorded';
        return `<tr><td><strong>${escapeHtml(project.project_name || '—')}</strong></td><td>${escapeHtml(project.barangay || '—')}</td><td>${Number(project.target_progress) || 0}%</td><td>${Number(project.progress) || 0}%</td><td>${escapeHtml(budgetStatus)}</td><td>${renderStatus(project.status)}</td></tr>`;
      }).join('')
      : '<tr><td colspan="6" class="table-empty">No projects match these filters.</td></tr>';
  };
  Object.values(filters).forEach((input) => input.addEventListener('change', refresh));
  refresh();

  document.querySelector('#export-clearances').addEventListener('click', () => {
    downloadCsv('mapangat-location-clearances.csv', [
      ['Application ID', 'Applicant', 'Project', 'Barangay', 'Land use', 'Area (sqm)', 'Status', 'Submitted', 'Permit reference', 'Permit validity'],
      ...filteredClearances.map((record) => [
        record.application_id, record.applicant_name, record.project_type, record.barangay,
        record.land_use_category, record.area_sqm, record.status, record.created_at,
        record.qr_reference, record.permit_status,
      ]),
    ]);
  });
  document.querySelector('#export-projects').addEventListener('click', () => {
    downloadCsv('mapangat-infrastructure-projects.csv', [
      ['Project ID', 'Project', 'Barangay', 'Target completion (%)', 'Actual completion (%)', 'Allocated budget (PHP)', 'Spent budget (PHP)', 'Status', 'Next inspection', 'Latitude', 'Longitude'],
      ...filteredProjects.map((project) => [
        project.id, project.project_name, project.barangay, project.target_progress, project.progress,
        project.allocated_budget, project.spent_budget, project.status, project.inspection_date, project.lat, project.lng,
      ]),
    ]);
  });
  document.querySelector('#print-report').addEventListener('click', () => {
    document.body.classList.add('printing-report');
    window.print();
    window.setTimeout(() => document.body.classList.remove('printing-report'), 1000);
  });
}
