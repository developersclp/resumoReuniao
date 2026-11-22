// Controlador principal da plataforma Grupo LOCAR — 12 Cidades/Projetos, Atas A4, PDF Congelado e Consentimento
(function () {
  const $ = (id) => document.getElementById(id);

  let currentAdmin = null;
  let citiesList = [];
  let selectedCityId = null;
  let activeView = "dashboard";
  let dashboardCache = null;

  let activeMeetingId = null;
  let activeMeetingMeta = null;
  let activeCityObj = null;
  let activePreviousMeeting = null;
  let activeVersions = [];
  let activeLink = null;
  let activeConsents = [];

  let state = clonePreset("caruaru_out_2026");
  let currentZoom = 0.88;
  let lastTranscriptText = "";
  let dirtyFlag = false;
  let autoSaveTimer = null;
  let pendingCityLogoDataUrl = undefined;

  const STATUS_LABELS = {
    rascunho: "Aguardando envio",
    aguardando_envio: "Aguardando envio",
    link_enviado: "Link enviado",
    aguardando_confirmacao: "Aguardando confirmação",
    confirmada: "Confirmada",
    link_invalido: "Link expirado ou invalidado"
  };

  function clonePreset(presetId) {
    const src = window.LOCAR_PRESETS[presetId] || window.LOCAR_PRESETS.caruaru_out_2026;
    return JSON.parse(
      JSON.stringify({
        ...src,
        showTopics: typeof src.showTopics === "boolean" ? src.showTopics : true,
        showKpisOnSheet: typeof src.showKpisOnSheet === "boolean" ? src.showKpisOnSheet : false,
        densityMode: src.densityMode || "auto",
        headerTheme: src.headerTheme || "die",
        extraBlankRows: typeof src.extraBlankRows === "number" ? src.extraBlankRows : 1
      })
    );
  }

  function showToast(msg) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("show"), 3400);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, "&#39;");
  }

  function formatDateTimeBr(isoStr) {
    if (!isoStr) return "—";
    try {
      return new Date(isoStr).toLocaleString("pt-BR");
    } catch {
      return isoStr;
    }
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function isMeetingLocked() {
    return Boolean(activeMeetingMeta && activeMeetingMeta.is_locked);
  }

  function setSaveStatus(text, isUnsaved = false) {
    const el = $("saveStatusIndicator");
    if (!el) return;
    el.textContent = text;
    el.style.color = isUnsaved ? "#b75e00" : "#2e7d32";
  }

  function markDirtyAndScheduleSave() {
    if (!activeMeetingId || isMeetingLocked()) return;
    dirtyFlag = true;
    setSaveStatus("Alterações pendentes...", true);
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      saveActiveMeeting({ silent: true });
    }, 900);
  }

  // -------------------- Autenticação e Shell --------------------
  function showLoginScreen(errorMsg = "") {
    currentAdmin = null;
    $("appShell").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
    const errEl = $("loginError");
    if (errorMsg) {
      errEl.textContent = errorMsg;
      errEl.classList.remove("hidden");
    } else {
      errEl.classList.add("hidden");
    }
  }

  async function enterAuthenticatedApp(user) {
    currentAdmin = user;
    $("loginScreen").classList.add("hidden");
    $("appShell").classList.remove("hidden");
    $("adminUserLabel").textContent = user.name;
    await refreshCitiesAndDashboard();
  }

  async function refreshCitiesAndDashboard() {
    const data = await window.LocarApi.get("/api/dashboard");
    dashboardCache = data;
    citiesList = (data.cities || []).map((c) => c.city);
    if (!selectedCityId || !citiesList.some((c) => c.id === selectedCityId)) {
      selectedCityId = citiesList[0]?.id || null;
    }
    populateGlobalCitySelect();
    if (activeView === "dashboard") {
      renderDashboardView();
    } else if (activeView === "city-history") {
      await loadCityHistoryView();
    } else if (activeView === "cities") {
      renderCitiesManageView();
    } else if (activeView === "editor") {
      await loadCityIntoEditor(selectedCityId, activeMeetingId);
    }
  }

  function populateGlobalCitySelect() {
    const sel = $("globalCitySelect");
    sel.innerHTML = "";
    citiesList.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name}${c.project_code ? " (" + c.project_code + ")" : ""}`;
      sel.appendChild(opt);
    });
    if (selectedCityId) {
      sel.value = selectedCityId;
    }
  }

  async function switchView(viewName) {
    activeView = viewName;
    document.querySelectorAll(".nav-pill").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });
    document.querySelectorAll(".view-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== `view-${viewName}`);
    });

    if (viewName === "dashboard") {
      const data = await window.LocarApi.get("/api/dashboard");
      dashboardCache = data;
      citiesList = (data.cities || []).map((c) => c.city);
      populateGlobalCitySelect();
      renderDashboardView();
    } else if (viewName === "city-history") {
      await loadCityHistoryView();
    } else if (viewName === "editor") {
      await loadCityIntoEditor(selectedCityId, activeMeetingId);
      adjustDefaultZoom();
    } else if (viewName === "cities") {
      const data = await window.LocarApi.get("/api/cities");
      citiesList = data.cities || [];
      populateGlobalCitySelect();
      renderCitiesManageView();
    }
  }

  async function handleGlobalCityChange(newCityId) {
    if (!newCityId) return;
    if (dirtyFlag && activeMeetingId && !isMeetingLocked()) {
      await saveActiveMeeting({ silent: true });
    }
    selectedCityId = newCityId;
    activeMeetingId = null;
    if (activeView === "city-history") {
      await loadCityHistoryView();
    } else if (activeView === "editor") {
      await loadCityIntoEditor(selectedCityId, null);
    } else if (activeView === "dashboard") {
      renderDashboardView();
    }
  }

  // -------------------- VISÃO 1: Dashboard Geral --------------------
  function renderDashboardView() {
    if (!dashboardCache) return;
    const s = dashboardCache.summary || {};
    const sc = s.status_counts || {};

    $("dashboardKpis").innerHTML = `
      <div class="summary-stat-card">
        <div class="summary-stat-label">Cidades / Projetos</div>
        <div class="summary-stat-value">${s.active_cities ?? 0} / ${s.total_cities ?? 0}</div>
      </div>
      <div class="summary-stat-card">
        <div class="summary-stat-label">Atas Confirmadas</div>
        <div class="summary-stat-value">${sc.confirmada ?? 0}</div>
      </div>
      <div class="summary-stat-card warn">
        <div class="summary-stat-label">Aguardando Confirmação</div>
        <div class="summary-stat-value">${sc.aguardando_confirmacao ?? 0}</div>
      </div>
      <div class="summary-stat-card info">
        <div class="summary-stat-label">Link Enviado / Aguardando Envio</div>
        <div class="summary-stat-value">${sc.link_enviado ?? 0} / ${sc.aguardando_envio ?? 0}</div>
      </div>
      <div class="summary-stat-card danger">
        <div class="summary-stat-label">Links Expirados / Invalidados</div>
        <div class="summary-stat-value">${sc.link_invalido ?? 0}</div>
      </div>
      <div class="summary-stat-card warn">
        <div class="summary-stat-label">Ações Pendentes / Concluídas</div>
        <div class="summary-stat-value">${s.pending_actions_total ?? 0} / ${s.completed_actions_total ?? 0}</div>
      </div>
    `;

    const query = ($("dashSearchInput").value || "").trim().toLowerCase();
    const statusFilter = $("dashStatusFilter").value;
    const rows = (dashboardCache.cities || []).filter((entry) => {
      const c = entry.city;
      const lm = entry.latest_meeting;
      const st = lm ? (lm.workflow_status === "rascunho" ? "aguardando_envio" : lm.workflow_status) : "";
      if (statusFilter && st !== statusFilter) return false;
      if (query) {
        const hay = `${c.name} ${c.project_name} ${c.project_code}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    $("dashCountHint").textContent = `${rows.length} cidade(s) / projeto(s) exibido(s)`;
    const grid = $("dashboardCitiesGrid");
    grid.innerHTML = "";

    rows.forEach((entry) => {
      const c = entry.city;
      const lm = entry.latest_meeting;
      const st = lm ? lm.workflow_status : "aguardando_envio";
      const stLabel = lm ? lm.workflow_label : "Sem reunião";
      const consent = lm?.latest_consent;
      const thumbHtml = c.logo_data_url
        ? `<img src="${escapeAttr(c.logo_data_url)}" alt="${escapeAttr(c.name)}" />`
        : escapeHtml((c.project_code || c.name.slice(0, 3)).toUpperCase());

      const card = document.createElement("div");
      card.className = "city-card";
      card.innerHTML = `
        <div class="city-card-top">
          <div class="city-card-identity">
            <div class="city-logo-thumb">${thumbHtml}</div>
            <div>
              <h3 class="city-card-title">${escapeHtml(c.name)} ${c.state_uf ? "— " + escapeHtml(c.state_uf) : ""}</h3>
              <div class="city-card-sub">${escapeHtml(c.project_name)} (${escapeHtml(c.project_code || "—")})</div>
            </div>
          </div>
          <span class="status-badge ${escapeAttr(st)}">${escapeHtml(stLabel)}</span>
        </div>

        <div class="city-card-meta">
          <div><strong>Última reunião:</strong> ${lm ? escapeHtml(lm.title) : "Nenhuma ata cadastrada ainda"}</div>
          <div><strong>Data / Versão:</strong> ${lm ? `${escapeHtml(lm.date_text || lm.meeting_date || "—")} • ${lm.current_version_number ? "v" + lm.current_version_number : "Rascunho"}` : "—"}</div>
          <div><strong>Consentimento:</strong> ${consent ? `${escapeHtml(consent.representative_name)} (${formatDateTimeBr(consent.accepted_at)})` : "Pendente"}</div>
          <div><strong>Plano de Ação:</strong> ${entry.completed_actions} concluída(s) • ${entry.pending_actions} pendente(s) • ${entry.meetings_count} reunião(ões)</div>
        </div>

        <div class="city-card-actions">
          <button type="button" class="btn btn-primary btn-sm js-open-editor">Abrir Editor A4</button>
          <button type="button" class="btn btn-secondary btn-sm js-open-history">Histórico</button>
          <button type="button" class="btn btn-outline btn-sm js-edit-city">Configurar Cidade</button>
        </div>
      `;

      card.querySelector(".js-open-editor").addEventListener("click", async () => {
        selectedCityId = c.id;
        activeMeetingId = lm ? lm.id : null;
        populateGlobalCitySelect();
        await switchView("editor");
      });
      card.querySelector(".js-open-history").addEventListener("click", async () => {
        selectedCityId = c.id;
        populateGlobalCitySelect();
        await switchView("city-history");
      });
      card.querySelector(".js-edit-city").addEventListener("click", () => openCityModal(c));
      grid.appendChild(card);
    });
  }

  // -------------------- VISÃO 2: Histórico da Cidade Selecionada --------------------
  async function loadCityHistoryView() {
    if (!selectedCityId) return;
    const data = await window.LocarApi.get(`/api/cities/${selectedCityId}/timeline`);
    const city = data.city;
    activeCityObj = city;

    const logoHtml = city.logo_data_url
      ? `<img src="${escapeAttr(city.logo_data_url)}" alt="${escapeAttr(city.name)}" />`
      : escapeHtml(city.project_code || "LOCAR");

    $("cityHistoryHero").innerHTML = `
      <div class="city-hero-left">
        <div class="city-hero-logo">${logoHtml}</div>
        <div>
          <h2 style="margin:0; font-size:19px; color:var(--locar-green-dark);">${escapeHtml(city.name)} (${escapeHtml(city.state_uf || "—")})</h2>
          <div style="font-size:13px; font-weight:600; color:#324436;">${escapeHtml(city.project_name)} • Código ${escapeHtml(city.project_code || "—")}</div>
          <div class="hint">${escapeHtml(city.institutional_info || "")}</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <span class="action-badge">${(data.meetings || []).length} reunião(ões) registrada(s)</span>
      </div>
    `;

    // Linha do tempo das reuniões
    const tbody = $("cityTimelineBody");
    tbody.innerHTML = "";
    if (!data.meetings || data.meetings.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="hint" style="padding:16px;">Nenhuma reunião registrada para esta cidade ainda. Clique em "+ Nova Reunião para esta Cidade".</td></tr>`;
    } else {
      data.meetings.forEach((m) => {
        const consent = m.latest_consent;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>${escapeHtml(m.title)}</strong><br/><span class="hint">${escapeHtml(m.reference_label || "—")}</span></td>
          <td>${escapeHtml(m.date_text || m.meeting_date || "—")}</td>
          <td>${m.current_version_number ? `v${m.current_version_number} (PDF congelado)` : "Rascunho"}</td>
          <td><span class="status-badge ${escapeAttr(m.workflow_status)}">${escapeHtml(m.workflow_label)}</span></td>
          <td>${consent ? `<strong>${escapeHtml(consent.representative_name)}</strong><br/><span class="hint">${formatDateTimeBr(consent.accepted_at)} • v${consent.version_number}</span>` : "—"}</td>
          <td>${m.completed_actions}/${m.total_actions} concluída(s)</td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn-primary btn-sm js-tl-open">Abrir no Editor</button>
              <button type="button" class="btn btn-outline btn-sm js-tl-versions">Versões / Link</button>
            </div>
          </td>
        `;
        tr.querySelector(".js-tl-open").addEventListener("click", async () => {
          activeMeetingId = m.id;
          await switchView("editor");
        });
        tr.querySelector(".js-tl-versions").addEventListener("click", async () => {
          activeMeetingId = m.id;
          await loadCityIntoEditor(city.id, m.id);
          await openVersionsAuditModal();
        });
        tbody.appendChild(tr);
      });
    }

    // Matriz de comparação de indicadores
    const matrixWrap = $("cityIndicatorMatrixWrap");
    if (!data.indicator_matrix || data.indicator_matrix.length === 0) {
      matrixWrap.innerHTML = `<p class="hint">Ainda não há indicadores registrados para comparação nesta cidade.</p>`;
    } else {
      const colsHtml = data.indicator_columns
        .map((col) => `<th>${escapeHtml(col.reference_label)}</th>`)
        .join("");
      const rowsHtml = data.indicator_matrix
        .map((row) => {
          const cells = row.series
            .map((cell) => `<td>${escapeHtml(cell.value)}</td>`)
            .join("");
          return `<tr><td><strong>${escapeHtml(row.label)}</strong></td>${cells}</tr>`;
        })
        .join("");
      matrixWrap.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Indicador</th>${colsHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    }

    // Acompanhamento de melhorias / Check das ações da cidade
    const actBody = $("cityActionTrackerBody");
    actBody.innerHTML = "";
    if (!data.action_history || data.action_history.length === 0) {
      actBody.innerHTML = `<tr><td colspan="7" class="hint" style="padding:16px;">Nenhuma ação cadastrada nas reuniões desta cidade.</td></tr>`;
    } else {
      data.action_history.forEach((act) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><input type="checkbox" class="js-act-chk" ${act.checked_completed ? "checked" : ""} /></td>
          <td><strong>${escapeHtml(act.reference_label || act.meeting_title)}</strong><br/><span class="hint">${escapeHtml(act.date_text || "")}</span></td>
          <td>${escapeHtml(act.action)}</td>
          <td>${escapeHtml(act.owner)}</td>
          <td>${escapeHtml(act.deadline)}</td>
          <td>
            <select class="js-act-status">
              <option value="pendente" ${act.tracking_status === "pendente" ? "selected" : ""}>Pendente</option>
              <option value="em_andamento" ${act.tracking_status === "em_andamento" ? "selected" : ""}>Em andamento</option>
              <option value="concluida" ${act.tracking_status === "concluida" ? "selected" : ""}>Concluída (Realizada)</option>
              <option value="nao_realizada" ${act.tracking_status === "nao_realizada" ? "selected" : ""}>Não realizada</option>
            </select>
          </td>
          <td>
            <div style="display:flex; gap:6px;">
              <input type="text" class="js-act-notes" value="${escapeAttr(act.follow_up_notes || "")}" placeholder="Observação..." style="min-width:160px; padding:4px 7px; border:1px solid var(--ui-border); border-radius:6px;" />
              <button type="button" class="btn btn-outline btn-sm js-act-save">Salvar</button>
            </div>
          </td>
        `;

        const chk = tr.querySelector(".js-act-chk");
        const sel = tr.querySelector(".js-act-status");
        const notes = tr.querySelector(".js-act-notes");
        const btnSave = tr.querySelector(".js-act-save");

        chk.addEventListener("change", async () => {
          const checked = chk.checked;
          sel.value = checked ? "concluida" : "pendente";
          await saveActionTracking(act.id, {
            checked_completed: checked,
            tracking_status: sel.value,
            follow_up_notes: notes.value
          });
        });

        sel.addEventListener("change", async () => {
          chk.checked = sel.value === "concluida";
          await saveActionTracking(act.id, {
            checked_completed: chk.checked,
            tracking_status: sel.value,
            follow_up_notes: notes.value
          });
        });

        btnSave.addEventListener("click", async () => {
          await saveActionTracking(act.id, {
            checked_completed: chk.checked,
            tracking_status: sel.value,
            follow_up_notes: notes.value
          });
        });

        actBody.appendChild(tr);
      });
    }
  }

  async function saveActionTracking(actionId, payload) {
    try {
      await window.LocarApi.patch(`/api/actions/${actionId}/tracking`, payload);
      showToast("Status de acompanhamento da melhoria atualizado!");
    } catch (err) {
      showToast("Erro ao salvar acompanhamento: " + err.message);
    }
  }

  // -------------------- VISÃO 4: Cadastro das 12 Cidades / Projetos --------------------
  function renderCitiesManageView() {
    const grid = $("citiesManageGrid");
    grid.innerHTML = "";
    citiesList.forEach((c) => {
      const thumbHtml = c.logo_data_url
        ? `<img src="${escapeAttr(c.logo_data_url)}" alt="${escapeAttr(c.name)}" />`
        : escapeHtml(c.project_code || "LOCAR");

      const card = document.createElement("div");
      card.className = "city-card";
      card.innerHTML = `
        <div class="city-card-top">
          <div class="city-card-identity">
            <div class="city-logo-thumb">${thumbHtml}</div>
            <div>
              <h3 class="city-card-title">${escapeHtml(c.name)} ${c.state_uf ? "(" + escapeHtml(c.state_uf) + ")" : ""}</h3>
              <div class="city-card-sub">${escapeHtml(c.project_name)}</div>
            </div>
          </div>
          <span class="action-badge">${escapeHtml(c.project_code || "#" + c.display_order)}</span>
        </div>
        <div class="city-card-meta">
          <div><strong>Local padrão:</strong> ${escapeHtml(c.default_local || "Microsoft Teams")}</div>
          <div><strong>Situação:</strong> ${c.is_active ? "Ativa" : "Inativa"} • <strong>Reuniões:</strong> ${c.meetings_count ?? 0}</div>
          <div><strong>Logotipo:</strong> ${c.has_logo ? "Logotipo cadastrado" : "Não enviado (opcional)"}</div>
        </div>
        <div class="city-card-actions">
          <button type="button" class="btn btn-primary btn-sm js-edit-city-card">Editar Dados &amp; Logotipo</button>
          <button type="button" class="btn btn-outline btn-sm js-open-city-tl">Ver Histórico</button>
        </div>
      `;
      card.querySelector(".js-edit-city-card").addEventListener("click", () => openCityModal(c));
      card.querySelector(".js-open-city-tl").addEventListener("click", async () => {
        selectedCityId = c.id;
        populateGlobalCitySelect();
        await switchView("city-history");
      });
      grid.appendChild(card);
    });
  }

  function openCityModal(cityObj = null) {
    pendingCityLogoDataUrl = undefined;
    $("cityModalTitle").textContent = cityObj ? `Editar Cidade / Projeto — ${cityObj.name}` : "Adicionar Cidade / Projeto";
    $("cityFormId").value = cityObj ? cityObj.id : "";
    $("cityNameInput").value = cityObj ? cityObj.name : "";
    $("cityUfInput").value = cityObj ? (cityObj.state_uf || "PE") : "PE";
    $("cityProjectNameInput").value = cityObj ? cityObj.project_name : "";
    $("cityProjectCodeInput").value = cityObj ? (cityObj.project_code || "") : `LOCAR-${String(citiesList.length + 1).padStart(2, "0")}`;
    $("cityOrderInput").value = cityObj ? (cityObj.display_order || 1) : citiesList.length + 1;
    $("cityLocalInput").value = cityObj ? (cityObj.default_local || "Microsoft Teams") : "Microsoft Teams";
    $("cityFooterInput").value = cityObj ? (cityObj.default_footer || "DIE – Departamento de Inteligência Estratégica") : "DIE – Departamento de Inteligência Estratégica";
    $("cityInfoInput").value = cityObj ? (cityObj.institutional_info || "") : "";
    $("cityActiveInput").checked = cityObj ? Boolean(cityObj.is_active) : true;
    $("cityLogoInput").value = "";

    updateCityLogoPreview(cityObj?.logo_data_url || "");
    $("modalCityForm").classList.remove("hidden");
  }

  function updateCityLogoPreview(dataUrl) {
    const box = $("cityLogoPreview");
    if (dataUrl) {
      box.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="Prévia do logotipo" />`;
    } else {
      box.innerHTML = `<span class="hint">Sem logotipo</span>`;
    }
  }

  // -------------------- VISÃO 3: Carregamento de Reunião no Editor A4 --------------------
  async function loadCityIntoEditor(cityId, preferredMeetingId = null) {
    if (!cityId) return;
    const timeline = await window.LocarApi.get(`/api/cities/${cityId}/timeline`);
    activeCityObj = timeline.city;
    $("editorCityBadge").textContent = `${activeCityObj.name}${activeCityObj.project_code ? " • " + activeCityObj.project_code : ""}`;

    const sel = $("selCityMeeting");
    sel.innerHTML = "";
    const meetings = timeline.meetings || [];
    if (meetings.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nenhuma reunião — clique em '+ Nova Reunião'";
      sel.appendChild(opt);

      activeMeetingId = null;
      activeMeetingMeta = null;
      activePreviousMeeting = null;
      activeVersions = [];
      activeLink = null;
      activeConsents = [];
      state = {
        ...clonePreset("blank"),
        unitName: activeCityObj.name,
        local: activeCityObj.default_local || "Microsoft Teams",
        footerText: activeCityObj.default_footer || "DIE – Departamento de Inteligência Estratégica"
      };
      applyEditorStateToUi();
      return;
    }

    meetings.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.reference_label || m.title} (${m.current_version_number ? "v" + m.current_version_number : "Rascunho"} • ${m.workflow_label})`;
      sel.appendChild(opt);
    });

    const targetId =
      preferredMeetingId && meetings.some((m) => m.id === preferredMeetingId)
        ? preferredMeetingId
        : meetings[0].id;
    sel.value = targetId;
    await loadMeetingIntoEditor(targetId);
  }

  async function loadMeetingIntoEditor(meetingId) {
    if (!meetingId) return;
    const data = await window.LocarApi.get(`/api/meetings/${meetingId}`);
    activeCityObj = data.city;
    activeMeetingId = data.meeting.id;
    activeMeetingMeta = data.meeting;
    activePreviousMeeting = data.previous_meeting;
    activeVersions = data.versions || [];
    activeLink = data.active_link || null;
    activeConsents = data.consents || [];
    state = data.meeting.snapshot;
    dirtyFlag = false;
    setSaveStatus("Sincronizado");
    applyEditorStateToUi();
  }

  function applyEditorStateToUi() {
    const locked = isMeetingLocked();
    const st = activeMeetingMeta ? activeMeetingMeta.workflow_status : "rascunho";
    const stLabel = activeMeetingMeta ? activeMeetingMeta.workflow_label : "Rascunho local";

    const badge = $("editorStatusBadge");
    badge.className = `status-badge ${st}`;
    badge.textContent = activeMeetingMeta && activeMeetingMeta.current_version_number
      ? `${stLabel} (v${activeMeetingMeta.current_version_number})`
      : stLabel;

    // Banner de ata confirmada e bloqueada
    const banner = $("lockedMeetingBanner");
    if (locked) {
      const latestConsent = activeConsents[0];
      const infoText = latestConsent
        ? `Ata confirmada (v${latestConsent.version_number}) por ${latestConsent.representative_name} (${latestConsent.representative_email}) em ${formatDateTimeBr(latestConsent.accepted_at)} • Protocolo ${latestConsent.protocol_code}.`
        : "Ata confirmada e congelada para preservação documental.";
      $("lockedMeetingInfo").innerHTML = `<strong>${escapeHtml(infoText)}</strong>`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }

    // Habilita/desabilita campos quando bloqueada
    document.querySelectorAll(".editor-panel input, .editor-panel textarea, .editor-panel select").forEach((el) => {
      if (el.id === "inpGeminiKey") return;
      el.disabled = locked;
    });
    ["btnAnalyzeTranscript", "btnAddKpi", "btnAddTopic", "btnAddAction", "btnClearStatuses", "btnSaveMeeting", "btnFinalizePdf", "btnImportPendingActions"].forEach((btnId) => {
      if ($(btnId)) $(btnId).disabled = locked || !activeMeetingId;
    });
    if ($("btnGeneratePublicLink")) {
      $("btnGeneratePublicLink").disabled = !activeMeetingId;
    }

    renderPreviousMeetingFollowUp();
    renderEditorInputs();
    renderSheet();
  }

  function renderPreviousMeetingFollowUp() {
    const box = $("prevMeetingFollowUpBox");
    const list = $("prevMeetingActionsList");
    if (!activePreviousMeeting || !Array.isArray(activePreviousMeeting.actions) || activePreviousMeeting.actions.length === 0) {
      box.classList.add("hidden");
      list.innerHTML = "";
      return;
    }

    box.classList.remove("hidden");
    $("prevMeetingTitle").textContent = `Acompanhamento — ${activePreviousMeeting.reference_label || activePreviousMeeting.title}`;
    list.innerHTML = "";

    activePreviousMeeting.actions.forEach((act) => {
      const row = document.createElement("div");
      row.className = `followup-item ${act.checked_completed ? "done" : ""}`;
      row.innerHTML = `
        <label class="followup-check-row">
          <input type="checkbox" class="js-prev-chk" ${act.checked_completed ? "checked" : ""} />
          <div>
            <div class="followup-item-title">${escapeHtml(act.action)}</div>
            <div class="followup-item-meta">Responsáveis: ${escapeHtml(act.owner || "—")} • Prazo: ${escapeHtml(act.deadline || "—")}</div>
          </div>
        </label>
        <div class="followup-controls">
          <select class="js-prev-status">
            <option value="pendente" ${act.tracking_status === "pendente" ? "selected" : ""}>Pendente</option>
            <option value="em_andamento" ${act.tracking_status === "em_andamento" ? "selected" : ""}>Em andamento</option>
            <option value="concluida" ${act.tracking_status === "concluida" ? "selected" : ""}>Concluída</option>
            <option value="nao_realizada" ${act.tracking_status === "nao_realizada" ? "selected" : ""}>Não realizada</option>
          </select>
          <input type="text" class="js-prev-notes" value="${escapeAttr(act.follow_up_notes || "")}" placeholder="Observação de verificação..." />
        </div>
      `;

      const chk = row.querySelector(".js-prev-chk");
      const sel = row.querySelector(".js-prev-status");
      const notes = row.querySelector(".js-prev-notes");

      chk.addEventListener("change", async () => {
        act.checked_completed = chk.checked;
        act.tracking_status = chk.checked ? "concluida" : "pendente";
        sel.value = act.tracking_status;
        row.classList.toggle("done", chk.checked);
        await saveActionTracking(act.id, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status,
          follow_up_notes: notes.value
        });
      });

      sel.addEventListener("change", async () => {
        act.tracking_status = sel.value;
        act.checked_completed = sel.value === "concluida";
        chk.checked = act.checked_completed;
        row.classList.toggle("done", act.checked_completed);
        await saveActionTracking(act.id, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status,
          follow_up_notes: notes.value
        });
      });

      notes.addEventListener("change", async () => {
        act.follow_up_notes = notes.value;
        await saveActionTracking(act.id, {
          checked_completed: chk.checked,
          tracking_status: sel.value,
          follow_up_notes: notes.value
        });
      });

      list.appendChild(row);
    });
  }

  async function saveActiveMeeting(opts = {}) {
    if (!activeMeetingId || isMeetingLocked()) return null;
    clearTimeout(autoSaveTimer);
    try {
      setSaveStatus("Salvando...", true);
      const res = await window.LocarApi.put(`/api/meetings/${activeMeetingId}`, state);
      activeMeetingMeta = res.meeting;
      activeVersions = res.versions || [];
      activeLink = res.active_link || null;
      activeConsents = res.consents || [];
      dirtyFlag = false;
      setSaveStatus("Salvo no banco");
      if (!opts.silent) {
        showToast("Alterações da ata salvas no banco de dados!");
      }
      return res;
    } catch (err) {
      setSaveStatus("Erro ao salvar", true);
      if (!opts.silent) {
        showToast("Erro ao salvar reunião: " + err.message);
      }
      return null;
    }
  }

  // -------------------- Renderização da Folha A4 (Preservada Integralmente) --------------------
  function renderSheet() {
    const sheet = $("a4Sheet");
    const isDieTheme = state.headerTheme !== "locar";
    sheet.classList.toggle("theme-locar", !isDieTheme);

    const logoImg = $("sheetLogoImg");
    if (window.LOCAR_LOGOS) {
      logoImg.src = isDieTheme ? window.LOCAR_LOGOS.white : window.LOCAR_LOGOS.color;
    } else {
      logoImg.src = isDieTheme ? "assets/logo-locar-white.png" : "assets/logo-locar.png";
    }

    // Logotipo individual da cidade (exibido apenas se cadastrado)
    const cityLogoBox = $("sheetCityLogoBox");
    const cityLogoImg = $("sheetCityLogoImg");
    if (cityLogoBox && cityLogoImg) {
      const cityLogoUrl = activeCityObj?.logo_data_url || "";
      if (cityLogoUrl) {
        cityLogoImg.src = cityLogoUrl;
        cityLogoBox.classList.remove("hidden");
      } else {
        cityLogoImg.removeAttribute("src");
        cityLogoBox.classList.add("hidden");
      }
    }

    const totalRows = (state.actions?.length || 0) + (state.extraBlankRows || 0);
    const shouldCompact =
      state.densityMode === "compact" ||
      (state.densityMode === "auto" &&
        (totalRows >= 8 || (state.showTopics && (state.topics?.length || 0) > 0 && totalRows >= 6)));
    sheet.classList.toggle("density-compact", shouldCompact);

    const locked = isMeetingLocked();
    const editableIds = [
      "sheetUnitName",
      "sheetLocal",
      "sheetDate",
      "sheetTime",
      "sheetParticipants",
      "sheetTitle",
      "sheetSummary",
      "sheetFooter"
    ];
    editableIds.forEach((id) => {
      if ($(id)) $(id).contentEditable = locked ? "false" : "true";
    });

    setEditableText($("sheetUnitName"), state.unitName || activeCityObj?.name || "Unidade");
    setEditableText($("sheetLocal"), state.local || "Microsoft Teams");
    setEditableText($("sheetDate"), state.dateText || "");
    setEditableText($("sheetTime"), state.timeText || "");
    setEditableText($("sheetParticipants"), state.participants || "");
    setEditableText($("sheetTitle"), state.title || "Ata de Reunião de Indicadores");
    setEditableText($("sheetSummary"), state.summary || "");
    setEditableText($("sheetFooter"), state.footerText || "DIE – Departamento de Inteligência Estratégica");

    const topicsBox = $("sheetTopicsBox");
    const topicsList = $("sheetTopicsList");
    if (state.showTopics && Array.isArray(state.topics) && state.topics.length > 0) {
      topicsBox.style.display = "block";
      topicsList.innerHTML = "";
      state.topics.forEach((t) => {
        const row = document.createElement("div");
        row.className = "topic-line";
        row.innerHTML = `<span class="topic-area">${escapeHtml(t.area)}:</span> ${escapeHtml(t.text)}`;
        topicsList.appendChild(row);
      });
    } else {
      topicsBox.style.display = "none";
    }

    const kpiBox = $("sheetKpis");
    if (state.showKpisOnSheet && Array.isArray(state.indicators) && state.indicators.length > 0) {
      kpiBox.style.display = "grid";
      kpiBox.innerHTML = "";
      state.indicators.slice(0, 8).forEach((kpi) => {
        const card = document.createElement("div");
        card.className = "sheet-kpi-item";
        card.innerHTML = `
          <div class="sheet-kpi-label">${escapeHtml(kpi.label)}</div>
          <div class="sheet-kpi-val">${escapeHtml(kpi.value)}</div>
        `;
        kpiBox.appendChild(card);
      });
    } else {
      kpiBox.style.display = "none";
    }

    const tbody = $("sheetActionBody");
    tbody.innerHTML = "";

    (state.actions || []).forEach((item, idx) => {
      const tr = document.createElement("tr");

      const tdAction = createEditableCell(item.action, locked, (val) => {
        state.actions[idx].action = val;
        syncActionInput(idx, "action", val);
        markDirtyAndScheduleSave();
      });

      const tdOwner = createEditableCell(item.owner, locked, (val) => {
        state.actions[idx].owner = val;
        syncActionInput(idx, "owner", val);
        markDirtyAndScheduleSave();
      });

      const tdDeadline = createEditableCell(item.deadline, locked, (val) => {
        state.actions[idx].deadline = val;
        syncActionInput(idx, "deadline", val);
        markDirtyAndScheduleSave();
      });

      const tdStatus = createEditableCell(item.status || "", locked, (val) => {
        state.actions[idx].status = val;
        markDirtyAndScheduleSave();
      });

      tr.appendChild(tdAction);
      tr.appendChild(tdOwner);
      tr.appendChild(tdDeadline);
      tr.appendChild(tdStatus);
      tbody.appendChild(tr);
    });

    const extraCount = Math.max(0, Math.min(6, parseInt(state.extraBlankRows || 0, 10)));
    for (let b = 0; b < extraCount; b++) {
      const trBlank = document.createElement("tr");
      trBlank.className = "blank-paper-row";
      trBlank.innerHTML = "<td></td><td></td><td></td><td></td>";
      tbody.appendChild(trBlank);
    }
  }

  function createEditableCell(value, locked, onCommit) {
    const td = document.createElement("td");
    td.contentEditable = locked ? "false" : "true";
    td.textContent = value || "";
    if (!locked) {
      td.addEventListener("input", () => {
        onCommit(td.innerText.replace(/\r/g, ""));
      });
    }
    return td;
  }

  function setEditableText(el, val) {
    if (el && document.activeElement !== el) {
      el.textContent = val;
    }
  }

  // -------------------- Editor Lateral --------------------
  function renderEditorInputs() {
    $("inpRefLabel").value = state.referenceLabel || "";
    $("inpMeetingDateIso").value = state.meetingDate || "";
    $("inpUnitName").value = state.unitName || "";
    $("inpLocal").value = state.local || "";
    $("inpDateText").value = state.dateText || "";
    $("inpTimeText").value = state.timeText || "";
    $("inpParticipants").value = state.participants || "";
    $("inpTitle").value = state.title || "";
    $("inpSummary").value = state.summary || "";
    $("inpFooter").value = state.footerText || "";
    $("chkShowTopics").checked = !!state.showTopics;
    $("chkShowKpis").checked = !!state.showKpisOnSheet;
    $("selHeaderTheme").value = state.headerTheme || "die";
    $("selDensity").value = state.densityMode || "auto";
    $("inpBlankRows").value = state.extraBlankRows ?? 1;

    renderKpiEditor();
    renderTopicsEditor();
    renderActionsEditor();
  }

  function renderKpiEditor() {
    const container = $("kpiEditorList");
    container.innerHTML = "";
    const locked = isMeetingLocked();
    if (!state.indicators || state.indicators.length === 0) {
      container.innerHTML =
        '<p class="hint">Nenhum indicador extraído ainda. Suba a transcrição ou o arquivo CSV de indicadores.</p>';
      return;
    }
    state.indicators.forEach((kpi, idx) => {
      const chip = document.createElement("div");
      chip.className = `kpi-chip ${kpi.status || "ok"}`;
      chip.innerHTML = `
        <div class="kpi-chip-label">${escapeHtml(kpi.label)}</div>
        <div class="kpi-chip-value">${escapeHtml(kpi.value)}</div>
        ${locked ? "" : '<button type="button" class="icon-btn del" title="Remover indicador" style="position:absolute;top:5px;right:5px;width:20px;height:20px;font-size:10px;">✕</button>'}
      `;
      const btn = chip.querySelector("button");
      if (btn) {
        btn.addEventListener("click", () => {
          state.indicators.splice(idx, 1);
          renderKpiEditor();
          renderSheet();
          markDirtyAndScheduleSave();
        });
      }
      container.appendChild(chip);
    });
  }

  function renderTopicsEditor() {
    const container = $("topicsEditorList");
    container.innerHTML = "";
    const locked = isMeetingLocked();
    (state.topics || []).forEach((t, idx) => {
      const card = document.createElement("div");
      card.className = "action-editor-card";
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-badge">Tópico ${idx + 1}</span>
          <button type="button" class="icon-btn del" title="Excluir tópico" ${locked ? "disabled" : ""}>✕</button>
        </div>
        <div class="field">
          <label>Área / Tema</label>
          <input type="text" class="topic-area-inp" value="${escapeAttr(t.area)}" ${locked ? "disabled" : ""} />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Destaques</label>
          <textarea rows="2" class="topic-text-inp" ${locked ? "disabled" : ""}>${escapeHtml(t.text)}</textarea>
        </div>
      `;
      card.querySelector(".del").addEventListener("click", () => {
        if (locked) return;
        state.topics.splice(idx, 1);
        renderTopicsEditor();
        renderSheet();
        markDirtyAndScheduleSave();
      });
      card.querySelector(".topic-area-inp").addEventListener("input", (e) => {
        state.topics[idx].area = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });
      card.querySelector(".topic-text-inp").addEventListener("input", (e) => {
        state.topics[idx].text = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });
      container.appendChild(card);
    });
  }

  function renderActionsEditor() {
    const container = $("actionsEditorList");
    container.innerHTML = "";
    const locked = isMeetingLocked();
    $("actionCountBadge").textContent = `${(state.actions || []).length} itens`;

    (state.actions || []).forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = "action-editor-card";
      card.dataset.idx = idx;
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-badge">Ação #${idx + 1}</span>
          <div class="action-card-controls">
            <button type="button" class="icon-btn up" title="Mover para cima" ${locked ? "disabled" : ""}>↑</button>
            <button type="button" class="icon-btn down" title="Mover para baixo" ${locked ? "disabled" : ""}>↓</button>
            <button type="button" class="icon-btn del" title="Remover ação" ${locked ? "disabled" : ""}>✕</button>
          </div>
        </div>
        <div class="field">
          <label>Item de ação</label>
          <textarea rows="2" class="act-action" ${locked ? "disabled" : ""}>${escapeHtml(item.action)}</textarea>
        </div>
        <div class="field-row">
          <div class="field" style="margin-bottom:0;">
            <label>Proprietários</label>
            <input type="text" class="act-owner" value="${escapeAttr(item.owner)}" ${locked ? "disabled" : ""} />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Prazo</label>
            <input type="text" class="act-deadline" value="${escapeAttr(item.deadline)}" ${locked ? "disabled" : ""} />
          </div>
        </div>
      `;

      card.querySelector(".up").addEventListener("click", () => {
        if (locked || idx === 0) return;
        [state.actions[idx - 1], state.actions[idx]] = [state.actions[idx], state.actions[idx - 1]];
        renderActionsEditor();
        renderSheet();
        markDirtyAndScheduleSave();
      });

      card.querySelector(".down").addEventListener("click", () => {
        if (locked || idx >= state.actions.length - 1) return;
        [state.actions[idx + 1], state.actions[idx]] = [state.actions[idx], state.actions[idx + 1]];
        renderActionsEditor();
        renderSheet();
        markDirtyAndScheduleSave();
      });

      card.querySelector(".del").addEventListener("click", () => {
        if (locked) return;
        state.actions.splice(idx, 1);
        renderActionsEditor();
        renderSheet();
        markDirtyAndScheduleSave();
      });

      card.querySelector(".act-action").addEventListener("input", (e) => {
        state.actions[idx].action = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });

      card.querySelector(".act-owner").addEventListener("input", (e) => {
        state.actions[idx].owner = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });

      card.querySelector(".act-deadline").addEventListener("input", (e) => {
        state.actions[idx].deadline = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });

      container.appendChild(card);
    });
  }

  function syncActionInput(idx, field, val) {
    const card = document.querySelector(`.action-editor-card[data-idx="${idx}"]`);
    if (!card) return;
    const selector = field === "action" ? ".act-action" : field === "owner" ? ".act-owner" : ".act-deadline";
    const el = card.querySelector(selector);
    if (el && document.activeElement !== el) {
      el.value = val;
    }
  }

  // -------------------- Upload & Análise Microsoft Teams (Preservado) --------------------
  function setupDropzone(zoneId, inputId, handler) {
    const zone = $(zoneId);
    const input = $(inputId);
    zone.addEventListener("click", () => {
      if (isMeetingLocked()) {
        showToast("Ata confirmada está travada. Crie uma nova versão para editar.");
        return;
      }
      input.click();
    });
    input.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        handler(e.target.files[0]);
        input.value = "";
      }
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (isMeetingLocked()) return;
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handler(e.dataTransfer.files[0]);
      }
    });
  }

  async function handleAttendanceUpload(file) {
    if (isMeetingLocked()) return;
    try {
      const buf = await file.arrayBuffer();
      const text = window.LocarParser.decodeFileBuffer(buf);
      const parsed = window.LocarParser.parseAttendanceCSV(text);

      if (parsed.unitName) state.unitName = parsed.unitName;
      if (parsed.dateText) state.dateText = parsed.dateText;
      if (parsed.timeText) state.timeText = parsed.timeText;
      if (parsed.participantsText) state.participants = parsed.participantsText;
      if (parsed.refMonthYear) {
        state.referenceLabel = parsed.refMonthYear;
        state.title = `Ata de Reunião de Indicadores ${parsed.refMonthYear}`;
      }

      if (parsed.nextMonthYear && Array.isArray(state.actions)) {
        state.actions.forEach((a) => {
          if (!a.deadline) a.deadline = `Próx. Reunião ${parsed.nextMonthYear}`;
        });
      }

      const statusEl = $("attendanceStatus");
      statusEl.textContent = `✓ ${file.name} — ${parsed.participantsList.length} participantes extraídos (${parsed.unitName || "Reunião"}).`;
      statusEl.classList.add("visible");

      renderEditorInputs();
      renderSheet();
      markDirtyAndScheduleSave();
      showToast(`Presença importada: ${parsed.participantsList.length} participantes!`);
    } catch (err) {
      showToast("Erro ao ler relatório de presença: " + err.message);
    }
  }

  async function handleTranscriptUpload(file) {
    if (isMeetingLocked()) return;
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      let text = "";
      if (ext === "docx") {
        const buf = await file.arrayBuffer();
        text = await window.LocarParser.extractTextFromDocx(buf);
      } else {
        const buf = await file.arrayBuffer();
        text = window.LocarParser.decodeFileBuffer(buf);
      }
      lastTranscriptText = text;
      $("inpTranscriptPaste").value =
        text.slice(0, 20000) + (text.length > 20000 ? "\n\n[...texto completo carregado em memória para análise...]" : "");

      const statusEl = $("transcriptStatus");
      statusEl.textContent = `✓ ${file.name} carregado (${Math.round(text.length / 1024)} KB).`;
      statusEl.classList.add("visible");

      await processTranscriptText(text);
    } catch (err) {
      showToast("Erro ao ler transcrição: " + err.message);
    }
  }

  async function handleIndicatorsUpload(file) {
    if (isMeetingLocked()) return;
    try {
      const buf = await file.arrayBuffer();
      const text = window.LocarParser.decodeFileBuffer(buf);
      const ext = file.name.split(".").pop().toLowerCase();

      let kpis = [];
      if (ext === "json") {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) kpis = parsed;
      } else {
        kpis = window.LocarParser.parseIndicatorsCSV(text);
      }

      if (kpis.length === 0) {
        showToast("Não foram encontrados indicadores no formato esperado (Indicador; Valor; Status).");
        return;
      }

      state.indicators = kpis;
      const statusEl = $("indicatorsStatus");
      statusEl.textContent = `✓ ${file.name} — ${kpis.length} indicadores importados.`;
      statusEl.classList.add("visible");

      renderEditorInputs();
      renderSheet();
      markDirtyAndScheduleSave();
      showToast(`${kpis.length} indicadores carregados no relatório!`);
    } catch (err) {
      showToast("Erro ao ler arquivo de indicadores: " + err.message);
    }
  }

  async function processTranscriptText(textOverride) {
    if (isMeetingLocked()) return;
    const raw = (textOverride || lastTranscriptText || $("inpTranscriptPaste").value || "").trim();
    if (!raw) {
      showToast("Suba ou cole uma transcrição do Teams antes de analisar.");
      return;
    }
    lastTranscriptText = raw;

    const apiKey = ($("inpGeminiKey").value || "").trim();
    const btn = $("btnAnalyzeTranscript");
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = apiKey ? "Analisando com IA Gemini..." : "Analisando transcrição...";

    try {
      let result;
      if (apiKey) {
        result = await window.LocarParser.analyzeWithGeminiAI(apiKey, raw, {
          unitName: state.unitName,
          dateText: state.dateText,
          participants: state.participants
        });
        if (result.refMonthYear) {
          state.referenceLabel = result.refMonthYear;
          state.title = `Ata de Reunião de Indicadores ${result.refMonthYear}`;
        }
      } else {
        result = window.LocarParser.analyzeTranscript(raw, {
          unitName: state.unitName,
          dateText: state.dateText,
          timeText: state.timeText
        });
        if (result.title) state.title = result.title;
        if (result.refMonthYear) state.referenceLabel = result.refMonthYear;
      }

      if (result.unitName) state.unitName = result.unitName;
      if (result.dateText && !state.dateText) state.dateText = result.dateText;
      if (result.timeText && !state.timeText) state.timeText = result.timeText;
      if (result.participantsText && !state.participants) state.participants = result.participantsText;
      if (result.summary) state.summary = result.summary;
      if (Array.isArray(result.topics) && result.topics.length > 0) state.topics = result.topics;
      if (Array.isArray(result.indicators) && result.indicators.length > 0) state.indicators = result.indicators;
      if (Array.isArray(result.actions) && result.actions.length > 0) {
        state.actions = result.actions.map((a) => ({ ...a, status: "" }));
      }

      renderEditorInputs();
      renderSheet();
      markDirtyAndScheduleSave();
      showToast(`Análise concluída: ${state.actions.length} itens de ação gerados (Status vazio p/ papel).`);
    } catch (err) {
      showToast("Erro na análise: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  // -------------------- Exportações (.doc / .json / Print PDF) --------------------
  function exportToWord() {
    const logoSrc = window.LOCAR_LOGOS?.color || "assets/logo-locar.png";
    const cityLogoHtml = activeCityObj?.logo_data_url
      ? `<img src="${escapeAttr(activeCityObj.logo_data_url)}" width="95" alt="Logotipo da Cidade" style="display:block; margin-bottom:6px;" />`
      : "";
    const topicsHtml =
      state.showTopics && state.topics?.length
        ? `<div style="margin:8px 0 12px 20px; padding:8px 12px; background:#f2f9f4; border-left:3.5px solid #0a7e3a; font-size:9.5pt;">
             <div style="font-weight:bold; color:#075b29; margin-bottom:4px;">PRINCIPAIS TÓPICOS E ASSUNTOS DESTACADOS</div>
             ${state.topics
               .map((t) => `<div><b>${escapeHtml(t.area)}:</b> ${escapeHtml(t.text)}</div>`)
               .join("")}
           </div>`
        : "";

    const actionRowsHtml = (state.actions || [])
      .map(
        (a) => `
      <tr>
        <td style="border-bottom:1px solid #888; border-right:1px solid #888; padding:6px; vertical-align:top;">${escapeHtml(a.action).replace(/\n/g, "<br>")}</td>
        <td style="border-bottom:1px solid #888; border-right:1px solid #888; padding:6px; vertical-align:top;">${escapeHtml(a.owner)}</td>
        <td style="border-bottom:1px solid #888; border-right:1px solid #888; padding:6px; vertical-align:top;">${escapeHtml(a.deadline)}</td>
        <td style="border-bottom:1px solid #888; padding:6px; vertical-align:top;">${escapeHtml(a.status || "")}</td>
      </tr>`
      )
      .join("");

    const blankRowsHtml = Array.from({ length: state.extraBlankRows || 0 })
      .map(
        () => `
      <tr>
        <td style="border-bottom:1px dashed #999; border-right:1px solid #888; height:26px;">&nbsp;</td>
        <td style="border-bottom:1px dashed #999; border-right:1px solid #888;">&nbsp;</td>
        <td style="border-bottom:1px dashed #999; border-right:1px solid #888;">&nbsp;</td>
        <td style="border-bottom:1px dashed #999;">&nbsp;</td>
      </tr>`
      )
      .join("");

    const html = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escapeHtml(state.title)}</title></head>
<body style="font-family: Calibri, Arial, sans-serif; color:#1f2421; margin:20px;">
  <table width="100%" cellspacing="0" cellpadding="6" style="background:#0a7e3a; color:#ffffff; margin-bottom:12px;">
    <tr><td align="right" style="font-size:12pt; font-weight:bold;">${escapeHtml(state.unitName)}</td></tr>
  </table>
  <table width="100%" cellspacing="0" cellpadding="4" style="margin-bottom:12px;">
    <tr>
      <td width="38%" valign="top"><img src="${logoSrc}" width="170" alt="LOCAR Gestão de Resíduos" /></td>
      <td width="48%" valign="top" style="font-size:9.5pt; line-height:1.4;">
        <div><b>Local:</b> ${escapeHtml(state.local)}</div>
        <div><b>Data:</b> ${escapeHtml(state.dateText)}</div>
        <div><b>Hora:</b> ${escapeHtml(state.timeText)}</div>
        <div><b>Participação:</b> ${escapeHtml(state.participants)}</div>
      </td>
      <td width="14%" valign="top" align="right">${cityLogoHtml}</td>
    </tr>
  </table>
  <h2 style="text-align:center; font-size:15pt; margin:10px 0 14px;">${escapeHtml(state.title)}</h2>
  <p style="font-size:10.5pt; line-height:1.45; text-align:justify;"><b>I.</b> &nbsp; ${escapeHtml(state.summary)}</p>
  ${topicsHtml}
  <table width="100%" cellspacing="0" cellpadding="5" style="border-collapse:collapse; font-size:9.5pt; margin-top:10px;">
    <thead>
      <tr>
        <th align="left" width="38%" style="border-bottom:1.5px solid #444; padding:6px;">Itens de ação</th>
        <th align="left" width="21%" style="border-bottom:1.5px solid #444; padding:6px;">Proprietários</th>
        <th align="left" width="18%" style="border-bottom:1.5px solid #444; padding:6px;">Prazo</th>
        <th align="left" width="23%" style="border-bottom:1.5px solid #444; padding:6px;">Status</th>
      </tr>
    </thead>
    <tbody>
      ${actionRowsHtml}
      ${blankRowsHtml}
    </tbody>
  </table>
  <p style="text-align:center; font-size:9.5pt; color:#555; margin-top:26px;">${escapeHtml(state.footerText)}</p>
</body>
</html>`;

    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const fileSlug = (state.unitName || "locar").toLowerCase().replace(/[^a-z0-9]+/gi, "_");
    downloadBlob(blob, `ata_indicadores_${fileSlug}.doc`);
    showToast("Documento Word (.doc) exportado!");
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const fileSlug = (state.unitName || "locar").toLowerCase().replace(/[^a-z0-9]+/gi, "_");
    downloadBlob(blob, `ata_${fileSlug}.json`);
    showToast("Projeto salvo em JSON!");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // -------------------- Fluxo de PDF Definitivo, Link Público & Versões --------------------
  async function finalizeMeetingPdf() {
    if (!activeMeetingId) return;
    if (isMeetingLocked()) {
      showToast("Esta ata já foi confirmada. Clique em 'Criar Nova Versão para Correção' primeiro.");
      return;
    }
    const btn = $("btnFinalizePdf");
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Gerando PDF A4...";
    try {
      const reason = activeMeetingMeta?.current_version_number
        ? (window.prompt("Descreva o motivo desta nova versão (opcional):", `Revisão v${activeMeetingMeta.current_version_number + 1}`) || "")
        : "Versão inicial definitiva";
      const res = await window.LocarApi.post(`/api/meetings/${activeMeetingId}/finalize`, {
        snapshot: state,
        change_reason: reason
      });
      activeMeetingMeta = res.meeting;
      activeVersions = res.versions || [];
      activeLink = res.active_link || null;
      activeConsents = res.consents || [];
      dirtyFlag = false;
      setSaveStatus("PDF definitivo congelado");
      applyEditorStateToUi();
      await loadCityIntoEditor(selectedCityId, activeMeetingId);
      showToast(`PDF v${res.generated_version.version_number} gerado e congelado com sucesso!`);
    } catch (err) {
      showToast("Erro ao finalizar PDF: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  async function openPublicLinkModal() {
    if (!activeMeetingId) return;
    if (dirtyFlag && !isMeetingLocked()) {
      await saveActiveMeeting({ silent: true });
    }
    const data = await window.LocarApi.get(`/api/meetings/${activeMeetingId}/versions`);
    activeVersions = data.versions || [];
    const currentVer = activeVersions.find((v) => v.is_current);
    activeLink = (data.links || []).find((l) => l.status === "active") || null;

    const body = $("publicLinkBody");
    if (!currentVer) {
      body.innerHTML = `
        <div class="login-note" style="margin-top:0;">
          <strong>PDF definitivo ainda não gerado.</strong><br/>
          Antes de gerar o link para assinatura do representante da cidade, finalize e congele a versão definitiva do PDF desta ata.
        </div>
        <div style="margin-top:14px;">
          <button type="button" id="btnModalFinalizeNow" class="btn btn-primary">Finalizar Ata em PDF Agora</button>
        </div>
      `;
      $("btnModalFinalizeNow").addEventListener("click", async () => {
        $("modalPublicLink").classList.add("hidden");
        await finalizeMeetingPdf();
        if (activeMeetingMeta?.has_frozen_pdf) {
          await openPublicLinkModal();
        }
      });
      $("modalPublicLink").classList.remove("hidden");
      return;
    }

    if (currentVer.has_consent || isMeetingLocked()) {
      const consent = (data.consents || []).find((c) => c.version_number === currentVer.version_number) || data.consents?.[0];
      body.innerHTML = `
        <div class="login-note" style="margin-top:0; border-left-color:#2e7d32;">
          <strong>A versão vigente (v${currentVer.version_number}) já foi confirmada pelo representante.</strong><br/>
          ${consent ? `Confirmada por <b>${escapeHtml(consent.representative_name)}</b> (${escapeHtml(consent.representative_email)}) em ${formatDateTimeBr(consent.accepted_at)} • Protocolo <b>${escapeHtml(consent.protocol_code)}</b>.` : ""}
        </div>
        <p class="hint" style="margin-top:10px;">
          Caso precise enviar uma ata corrigida, crie uma nova versão para preservar o PDF e o consentimento anteriores.
        </p>
      `;
      $("modalPublicLink").classList.remove("hidden");
      return;
    }

    const activeBlock = activeLink
      ? `
        <div class="section-card" style="margin-bottom:14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong>Link Público Ativo (Versão v${activeLink.version_number})</strong>
            <span class="status-badge ${escapeAttr(activeMeetingMeta?.workflow_status || "link_enviado")}">${escapeHtml(activeMeetingMeta?.workflow_label || "Link enviado")}</span>
          </div>
          <div class="copy-link-row">
            <input type="text" id="inpActivePublicUrl" value="${escapeAttr(activeLink.public_url || "")}" readonly />
            <button type="button" id="btnCopyPublicUrl" class="btn btn-primary btn-sm">Copiar Link</button>
            <a href="${escapeAttr(activeLink.public_url || "#")}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="text-decoration:none;">Abrir Página</a>
          </div>
          <p class="hint" style="margin-top:8px;">
            Válido até: <b>${formatDateTimeBr(activeLink.expires_at)}</b> • Acessos registrados: <b>${activeLink.view_count}</b>
          </p>
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button type="button" id="btnRevokePublicLink" class="btn btn-danger-ghost">Invalidar Link Atual</button>
          </div>
        </div>
      `
      : `<p class="hint" style="margin-bottom:12px;">Nenhum link público ativo no momento para a versão vigente <b>v${currentVer.version_number}</b>.</p>`;

    body.innerHTML = `
      ${activeBlock}
      <div class="panel-section" style="margin-bottom:0; padding-bottom:0; border-bottom:none;">
        <h4 style="margin:0 0 8px; font-size:13px; color:var(--locar-green-dark);">${activeLink ? "Gerar Novo Link (Invalida o link anterior)" : "Gerar Novo Link Exclusivo e Seguro"}</h4>
        <p class="hint" style="margin-bottom:10px;">
          Vinculado à cidade <b>${escapeHtml(activeCityObj?.name || "")}</b>, reunião <b>${escapeHtml(state.title)}</b> e PDF exato <b>v${currentVer.version_number}</b> (SHA-256: <span class="mono-hash">${currentVer.pdf_sha256.slice(0, 16)}...</span>).
        </p>
        <div class="field-row">
          <div class="field">
            <label for="inpLinkDays">Validade do link (dias)</label>
            <input type="number" id="inpLinkDays" min="1" max="180" value="30" />
          </div>
          <div class="field" style="display:flex; align-items:flex-end;">
            <button type="button" id="btnCreateNewPublicLink" class="btn btn-primary" style="width:100%;">
              ${activeLink ? "Substituir e Gerar Novo Link" : "Gerar Link Seguro Agora"}
            </button>
          </div>
        </div>
      </div>
    `;

    const copyBtn = $("btnCopyPublicUrl");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        await window.LocarApi.copyToClipboard($("inpActivePublicUrl").value);
        showToast("Link público copiado para a área de transferência!");
      });
    }

    const revokeBtn = $("btnRevokePublicLink");
    if (revokeBtn) {
      revokeBtn.addEventListener("click", async () => {
        const reason = window.prompt("Motivo da invalidação do link (opcional):", "Invalidado pelo administrador LOCAR") || "Invalidado pelo administrador LOCAR";
        await window.LocarApi.post(`/api/public-links/${activeLink.id}/revoke`, { reason });
        showToast("Link público invalidado!");
        await loadMeetingIntoEditor(activeMeetingId);
        await openPublicLinkModal();
      });
    }

    $("btnCreateNewPublicLink").addEventListener("click", async () => {
      const days = parseInt($("inpLinkDays").value || "30", 10);
      const res = await window.LocarApi.post(`/api/meetings/${activeMeetingId}/public-link`, { expires_in_days: days });
      await window.LocarApi.copyToClipboard(res.public_url).catch(() => {});
      showToast("Link público gerado e copiado!");
      await loadMeetingIntoEditor(activeMeetingId);
      await openPublicLinkModal();
    });

    $("modalPublicLink").classList.remove("hidden");
  }

  async function openVersionsAuditModal() {
    if (!activeMeetingId) return;
    const data = await window.LocarApi.get(`/api/meetings/${activeMeetingId}/versions`);
    const versions = data.versions || [];
    const consents = data.consents || [];
    const logs = data.audit_logs || [];

    const versionsHtml = versions.length
      ? versions
          .map(
            (v) => `
          <tr>
            <td><strong>v${v.version_number}</strong> ${v.is_current ? '<span class="status-badge confirmada">Vigente</span>' : '<span class="status-badge rascunho">Histórica</span>'}</td>
            <td>${escapeHtml(v.change_reason)}<br/><span class="mono-hash">${v.pdf_sha256}</span></td>
            <td>${formatBytes(v.pdf_size_bytes)}</td>
            <td>${escapeHtml(v.generated_by_name)}<br/><span class="hint">${formatDateTimeBr(v.generated_at)}</span></td>
            <td>
              <a href="/api/meetings/${activeMeetingId}/versions/${v.id}/pdf" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none;">Visualizar</a>
              <a href="/api/meetings/${activeMeetingId}/versions/${v.id}/pdf?download=1" class="btn btn-secondary btn-sm" style="text-decoration:none;">Baixar</a>
            </td>
          </tr>
        `
          )
          .join("")
      : `<tr><td colspan="5" class="hint">Nenhuma versão definitiva em PDF foi gerada para esta reunião ainda.</td></tr>`;

    const consentsHtml = consents.length
      ? consents
          .map(
            (c) => `
          <tr>
            <td><strong>${escapeHtml(c.protocol_code)}</strong><br/><span class="hint">v${c.version_number}</span></td>
            <td><strong>${escapeHtml(c.representative_name)}</strong><br/>${escapeHtml(c.representative_email)}${c.representative_role ? "<br/><span class='hint'>" + escapeHtml(c.representative_role) + "</span>" : ""}</td>
            <td>${formatDateTimeBr(c.accepted_at)}<br/><span class="hint">IP: ${escapeHtml(c.client_ip || "—")}</span></td>
            <td>
              PDF lido: ${c.pdf_viewed_before_consent ? "Sim" : "Não"} | Baixado: ${c.pdf_downloaded_before_consent ? "Sim" : "Não"}<br/>
              <span class="mono-hash">PDF: ${c.pdf_sha256.slice(0, 18)}...</span><br/>
              <span class="mono-hash">Integridade: ${c.integrity_hash.slice(0, 18)}...</span>
            </td>
          </tr>
        `
          )
          .join("")
      : `<tr><td colspan="4" class="hint">Nenhum registro de consentimento confirmado até o momento.</td></tr>`;

    const logsHtml = logs
      .slice(0, 25)
      .map(
        (l) => `
        <tr>
          <td>${formatDateTimeBr(l.created_at)}</td>
          <td><strong>${escapeHtml(l.event_type)}</strong></td>
          <td>${escapeHtml(l.actor_identifier)} (${escapeHtml(l.actor_type)})</td>
          <td>${escapeHtml(l.ip_address || "—")}</td>
        </tr>
      `
      )
      .join("");

    $("versionsAuditBody").innerHTML = `
      <div class="section-card">
        <h3>Versões Congeladas em PDF</h3>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>Versão</th><th>Motivo &amp; SHA-256</th><th>Tamanho</th><th>Geração</th><th>PDF</th></tr></thead>
            <tbody>${versionsHtml}</tbody>
          </table>
        </div>
      </div>

      <div class="section-card">
        <h3>Registros Auditáveis de Consentimento</h3>
        <p class="hint" style="margin-bottom:8px;">
          Registro eletrônico auditável de ciência e concordância vinculado ao arquivo PDF exato (SHA-256). Não equivale automaticamente a assinatura digital qualificada ICP-Brasil.
        </p>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>Protocolo</th><th>Representante</th><th>Data / IP</th><th>Evidências Técnicas</th></tr></thead>
            <tbody>${consentsHtml}</tbody>
          </table>
        </div>
      </div>

      <div class="section-card" style="margin-bottom:0;">
        <h3>Trilha Recente de Auditoria</h3>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>Data / Hora</th><th>Evento</th><th>Ator</th><th>IP</th></tr></thead>
            <tbody>${logsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    $("modalVersionsAudit").classList.remove("hidden");
  }

  async function openAdminUsersModal() {
    const data = await window.LocarApi.get("/api/admin/users");
    const users = data.users || [];

    const rowsHtml = users
      .map(
        (u) => `
      <tr>
        <td><strong>${escapeHtml(u.name)}</strong></td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.is_active ? '<span class="status-badge confirmada">Ativo</span>' : '<span class="status-badge link_invalido">Inativo</span>'}</td>
        <td>
          ${u.id !== currentAdmin?.id ? `<button type="button" class="btn btn-outline btn-sm js-toggle-admin" data-id="${u.id}" data-active="${u.is_active}">${u.is_active ? "Desativar" : "Ativar"}</button>` : "<span class='hint'>Sessão atual</span>"}
        </td>
      </tr>
    `
      )
      .join("");

    $("adminUsersBody").innerHTML = `
      <div class="section-card">
        <h3>Alterar Minha Senha</h3>
        <form id="formChangeOwnPassword" style="display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin-bottom:0;">
            <label for="inpCurPw">Senha atual</label>
            <input type="password" id="inpCurPw" required />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label for="inpNewPw">Nova senha (mín. 8 caracteres)</label>
            <input type="password" id="inpNewPw" minlength="8" required />
          </div>
          <button type="submit" class="btn btn-secondary btn-sm" style="height:36px;">Alterar Senha</button>
        </form>
      </div>

      <div class="section-card">
        <h3>Cadastrar Novo Administrador LOCAR</h3>
        <form id="formNewAdminUser" style="display:grid; grid-template-columns:1fr 1fr 1fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin-bottom:0;">
            <label for="inpNewAdminName">Nome</label>
            <input type="text" id="inpNewAdminName" required />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label for="inpNewAdminEmail">E-mail</label>
            <input type="text" id="inpNewAdminEmail" required />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label for="inpNewAdminPw">Senha inicial</label>
            <input type="password" id="inpNewAdminPw" minlength="8" required />
          </div>
          <button type="submit" class="btn btn-primary btn-sm" style="height:36px;">Adicionar</button>
        </form>
      </div>

      <div class="section-card" style="margin-bottom:0;">
        <h3>Administradores Cadastrados</h3>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>Nome</th><th>E-mail</th><th>Status</th><th>Ação</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    $("formChangeOwnPassword").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await window.LocarApi.post("/api/auth/change-password", {
          current_password: $("inpCurPw").value,
          new_password: $("inpNewPw").value
        });
        showToast("Senha alterada com sucesso!");
        $("formChangeOwnPassword").reset();
      } catch (err) {
        showToast(err.message);
      }
    });

    $("formNewAdminUser").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await window.LocarApi.post("/api/admin/users", {
          name: $("inpNewAdminName").value,
          email: $("inpNewAdminEmail").value,
          password: $("inpNewAdminPw").value
        });
        showToast("Administrador cadastrado!");
        await openAdminUsersModal();
      } catch (err) {
        showToast(err.message);
      }
    });

    $("adminUsersBody").querySelectorAll(".js-toggle-admin").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const isActive = btn.dataset.active === "true";
        await window.LocarApi.patch(`/api/admin/users/${btn.dataset.id}`, { is_active: !isActive });
        await openAdminUsersModal();
      });
    });

    $("modalAdminUsers").classList.remove("hidden");
  }

  // -------------------- Zoom & Bindings --------------------
  function applyZoom(zoomVal) {
    currentZoom = Math.max(0.55, Math.min(1.25, zoomVal));
    $("sheetWrapper").style.transform = `scale(${currentZoom})`;
    $("zoomLabel").textContent = `${Math.round(currentZoom * 100)}%`;
  }

  function adjustDefaultZoom() {
    const areaWidth = $("previewScroll").clientWidth - 48;
    if (areaWidth > 0 && areaWidth < 794) {
      applyZoom(areaWidth / 794);
    } else {
      applyZoom(0.88);
    }
  }

  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        $(btn.dataset.tab).classList.add("active");
      });
    });
  }

  function bindDirectInputs() {
    const map = [
      ["inpRefLabel", "referenceLabel"],
      ["inpMeetingDateIso", "meetingDate"],
      ["inpUnitName", "unitName"],
      ["inpLocal", "local"],
      ["inpDateText", "dateText"],
      ["inpTimeText", "timeText"],
      ["inpParticipants", "participants"],
      ["inpTitle", "title"],
      ["inpSummary", "summary"],
      ["inpFooter", "footerText"]
    ];
    map.forEach(([elId, key]) => {
      $(elId).addEventListener("input", (e) => {
        if (isMeetingLocked()) return;
        state[key] = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });
    });

    const sheetMap = [
      ["sheetUnitName", "unitName", "inpUnitName"],
      ["sheetLocal", "local", "inpLocal"],
      ["sheetDate", "dateText", "inpDateText"],
      ["sheetTime", "timeText", "inpTimeText"],
      ["sheetParticipants", "participants", "inpParticipants"],
      ["sheetTitle", "title", "inpTitle"],
      ["sheetSummary", "summary", "inpSummary"],
      ["sheetFooter", "footerText", "inpFooter"]
    ];
    sheetMap.forEach(([sheetId, key, inpId]) => {
      $(sheetId).addEventListener("input", (e) => {
        if (isMeetingLocked()) return;
        const txt = e.target.innerText.replace(/\r/g, "");
        state[key] = txt;
        if ($(inpId) && document.activeElement !== $(inpId)) {
          $(inpId).value = txt;
        }
        markDirtyAndScheduleSave();
      });
    });

    $("chkShowTopics").addEventListener("change", (e) => {
      if (isMeetingLocked()) return;
      state.showTopics = e.target.checked;
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("chkShowKpis").addEventListener("change", (e) => {
      if (isMeetingLocked()) return;
      state.showKpisOnSheet = e.target.checked;
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("selHeaderTheme").addEventListener("change", (e) => {
      if (isMeetingLocked()) return;
      state.headerTheme = e.target.value;
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("selDensity").addEventListener("change", (e) => {
      if (isMeetingLocked()) return;
      state.densityMode = e.target.value;
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("inpBlankRows").addEventListener("input", (e) => {
      if (isMeetingLocked()) return;
      state.extraBlankRows = parseInt(e.target.value || "0", 10);
      renderSheet();
      markDirtyAndScheduleSave();
    });
  }

  function openNewMeetingModal() {
    if (!selectedCityId) return;
    const now = new Date();
    const months = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    const refMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const refLabel = `${months[refMonthDate.getMonth()]}/${refMonthDate.getFullYear()}`;
    const refMonth = `${refMonthDate.getFullYear()}-${String(refMonthDate.getMonth() + 1).padStart(2, "0")}`;
    const isoToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    $("newMeetingRefLabel").value = refLabel;
    $("newMeetingTitle").value = `Ata de Reunião de Indicadores ${refLabel}`;
    $("newMeetingRefMonth").value = refMonth;
    $("newMeetingDate").value = isoToday;
    $("newMeetingImportPending").checked = true;
    $("modalNewMeeting").classList.remove("hidden");
  }

  function initButtons() {
    // Login & Logout
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("loginError").classList.add("hidden");
      try {
        const res = await window.LocarApi.post(
          "/api/auth/login",
          {
            email: $("loginEmail").value,
            password: $("loginPassword").value
          },
          { skipAuthEvent: true }
        );
        await enterAuthenticatedApp(res.user);
      } catch (err) {
        $("loginError").textContent = err.message || "Falha na autenticação.";
        $("loginError").classList.remove("hidden");
      }
    });

    $("btnLogout").addEventListener("click", async () => {
      await window.LocarApi.post("/api/auth/logout", {}).catch(() => {});
      showLoginScreen();
    });

    window.addEventListener("locar:unauthorized", () => {
      showLoginScreen("Sessão encerrada ou expirada. Faça login novamente.");
    });

    // Navegação global
    document.querySelectorAll(".nav-pill").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("globalCitySelect").addEventListener("change", (e) => handleGlobalCityChange(e.target.value));

    // Dashboard e Histórico
    $("dashSearchInput").addEventListener("input", renderDashboardView);
    $("dashStatusFilter").addEventListener("change", renderDashboardView);
    $("btnDashRefresh").addEventListener("click", refreshCitiesAndDashboard);
    $("btnDashNewCity").addEventListener("click", () => openCityModal(null));
    $("btnNewCity").addEventListener("click", () => openCityModal(null));
    $("btnNewMeetingFromHistory").addEventListener("click", openNewMeetingModal);
    $("btnEditCityFromHistory").addEventListener("click", () => {
      if (activeCityObj) openCityModal(activeCityObj);
    });

    // Editor
    $("selCityMeeting").addEventListener("change", async (e) => {
      if (!e.target.value) return;
      if (dirtyFlag && activeMeetingId && !isMeetingLocked()) {
        await saveActiveMeeting({ silent: true });
      }
      await loadMeetingIntoEditor(e.target.value);
    });

    $("btnNewMeeting").addEventListener("click", openNewMeetingModal);

    $("formNewMeeting").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!selectedCityId) return;
      try {
        const res = await window.LocarApi.post(`/api/cities/${selectedCityId}/meetings`, {
          reference_label: $("newMeetingRefLabel").value.trim(),
          title: $("newMeetingTitle").value.trim(),
          reference_month: $("newMeetingRefMonth").value.trim(),
          meeting_date: $("newMeetingDate").value.trim(),
          auto_import_pending: $("newMeetingImportPending").checked
        });
        $("modalNewMeeting").classList.add("hidden");
        activeMeetingId = res.meeting.id;
        await switchView("editor");
        showToast("Nova reunião criada para a cidade selecionada!");
      } catch (err) {
        showToast("Erro ao criar reunião: " + err.message);
      }
    });

    $("btnImportPendingActions").addEventListener("click", async () => {
      if (!activeMeetingId || isMeetingLocked()) return;
      try {
        const res = await window.LocarApi.post(`/api/meetings/${activeMeetingId}/import-pending-actions`, {});
        state = res.meeting.snapshot;
        renderEditorInputs();
        renderSheet();
        showToast(`${res.imported_count} ação(ões) pendente(s) importada(s) com Status vazio p/ papel!`);
      } catch (err) {
        showToast("Erro ao importar pendências: " + err.message);
      }
    });

    // Presets originais preservados
    $("selPreset").addEventListener("change", (e) => {
      const val = e.target.value;
      if (!val) return;
      if (isMeetingLocked()) {
        showToast("Ata confirmada está travada. Crie uma nova versão para aplicar outro modelo.");
        e.target.value = "";
        return;
      }
      const preset = clonePreset(val);
      state = {
        ...preset,
        id: state.id,
        cityId: state.cityId
      };
      renderEditorInputs();
      renderSheet();
      markDirtyAndScheduleSave();
      showToast(`Modelo aplicado ao rascunho: ${preset.label}`);
      e.target.value = "";
    });

    $("btnPrintPdf").addEventListener("click", () => window.print());
    $("btnExportWord").addEventListener("click", exportToWord);
    $("btnExportJson").addEventListener("click", exportJSON);

    $("btnImportJson").addEventListener("click", () => {
      if (isMeetingLocked()) {
        showToast("Ata confirmada está travada. Crie uma nova versão ou nova reunião para importar JSON.");
        return;
      }
      $("inpImportJson").click();
    });
    $("inpImportJson").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        state = {
          ...parsed,
          id: state.id,
          cityId: state.cityId
        };
        renderEditorInputs();
        renderSheet();
        markDirtyAndScheduleSave();
        showToast("Ata JSON importada para o rascunho!");
      } catch {
        showToast("Arquivo JSON inválido.");
      }
      e.target.value = "";
    });

    $("btnSaveMeeting").addEventListener("click", () => saveActiveMeeting({ silent: false }));
    $("btnFinalizePdf").addEventListener("click", finalizeMeetingPdf);
    $("btnGeneratePublicLink").addEventListener("click", openPublicLinkModal);
    $("btnOpenVersionsModal").addEventListener("click", openVersionsAuditModal);

    $("btnDownloadConfirmedPdf").addEventListener("click", () => {
      const cur = activeVersions.find((v) => v.is_current) || activeVersions[0];
      if (!cur) return;
      window.open(`/api/meetings/${activeMeetingId}/versions/${cur.id}/pdf?download=1`, "_blank");
    });

    $("btnUnlockNewVersion").addEventListener("click", async () => {
      if (!activeMeetingId) return;
      const reason = window.prompt(
        "Informe o motivo da criação de nova versão (o PDF e consentimento anteriores serão preservados):",
        "Correção documental"
      );
      if (reason === null) return;
      const res = await window.LocarApi.post(`/api/meetings/${activeMeetingId}/unlock-new-version`, {
        change_reason: reason
      });
      activeMeetingMeta = res.meeting;
      activeVersions = res.versions || [];
      activeLink = res.active_link || null;
      activeConsents = res.consents || [];
      applyEditorStateToUi();
      showToast("Nova versão habilitada! Edite e clique em 'Finalizar Ata (PDF)' para congelar a revisão.");
    });

    $("btnAnalyzeTranscript").addEventListener("click", () => processTranscriptText());

    $("btnAddAction").addEventListener("click", () => {
      if (isMeetingLocked()) return;
      const nextMonth = state.actions?.[0]?.deadline || "Próx. Reunião";
      state.actions.push({
        action: "",
        owner: "",
        deadline: nextMonth,
        status: ""
      });
      renderActionsEditor();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("btnClearStatuses").addEventListener("click", () => {
      if (isMeetingLocked()) return;
      state.actions.forEach((a) => (a.status = ""));
      renderSheet();
      markDirtyAndScheduleSave();
      showToast("Coluna Status esvaziada para preenchimento no papel.");
    });

    $("btnAddTopic").addEventListener("click", () => {
      if (isMeetingLocked()) return;
      state.topics = state.topics || [];
      state.topics.push({ area: "Novo Tópico", text: "" });
      state.showTopics = true;
      $("chkShowTopics").checked = true;
      renderTopicsEditor();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("btnAddKpi").addEventListener("click", () => {
      if (isMeetingLocked()) return;
      const label = prompt("Nome do indicador (ex: Quadro, Horas Extras, CPK):");
      if (!label) return;
      const value = prompt("Valor / Destaque (ex: 648 colab., R$ 406,8 mil):");
      if (!value) return;
      state.indicators = state.indicators || [];
      state.indicators.push({ label, value, status: "ok" });
      renderKpiEditor();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("btnZoomOut").addEventListener("click", () => applyZoom(currentZoom - 0.1));
    $("btnZoomIn").addEventListener("click", () => applyZoom(currentZoom + 0.1));
    $("btnZoomFit").addEventListener("click", () => {
      const areaWidth = $("previewScroll").clientWidth - 48;
      const sheetPx = 794;
      applyZoom(Math.min(1, areaWidth / sheetPx));
    });

    // Modal Cidade / Projeto
    $("cityLogoInput").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        pendingCityLogoDataUrl = reader.result;
        updateCityLogoPreview(pendingCityLogoDataUrl);
      };
      reader.readAsDataURL(file);
    });

    $("btnRemoveCityLogo").addEventListener("click", () => {
      pendingCityLogoDataUrl = "";
      $("cityLogoInput").value = "";
      updateCityLogoPreview("");
    });

    $("formCity").addEventListener("submit", async (e) => {
      e.preventDefault();
      const cityId = $("cityFormId").value.trim();
      const payload = {
        name: $("cityNameInput").value.trim(),
        state_uf: $("cityUfInput").value.trim(),
        project_name: $("cityProjectNameInput").value.trim(),
        project_code: $("cityProjectCodeInput").value.trim(),
        display_order: parseInt($("cityOrderInput").value || "1", 10),
        default_local: $("cityLocalInput").value.trim(),
        default_footer: $("cityFooterInput").value.trim(),
        institutional_info: $("cityInfoInput").value.trim(),
        is_active: $("cityActiveInput").checked
      };
      if (pendingCityLogoDataUrl === "") {
        payload.remove_logo = true;
      } else if (pendingCityLogoDataUrl !== undefined) {
        payload.logo_data_url = pendingCityLogoDataUrl;
      }

      try {
        if (cityId) {
          await window.LocarApi.put(`/api/cities/${cityId}`, payload);
          showToast("Cidade/projeto atualizado preservando todo o histórico!");
        } else {
          const created = await window.LocarApi.post("/api/cities", payload);
          selectedCityId = created.city.id;
          showToast("Nova cidade/projeto cadastrada!");
        }
        $("modalCityForm").classList.add("hidden");
        await refreshCitiesAndDashboard();
      } catch (err) {
        showToast("Erro ao salvar cidade/projeto: " + err.message);
      }
    });

    // Modal Administradores
    $("btnOpenAdminModal").addEventListener("click", openAdminUsersModal);

    // Fechar modais
    document.querySelectorAll(".modal-close").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.close;
        if (id && $(id)) $(id).classList.add("hidden");
      });
    });
  }

  // -------------------- Inicialização --------------------
  document.addEventListener("DOMContentLoaded", async () => {
    if (window.LOCAR_LOGOS?.color) {
      if ($("topbarLogo")) $("topbarLogo").src = window.LOCAR_LOGOS.color;
      if ($("loginLogoImg")) $("loginLogoImg").src = window.LOCAR_LOGOS.color;
    }

    const sel = $("selPreset");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Aplicar modelo de referência...";
    sel.appendChild(placeholder);
    Object.values(window.LOCAR_PRESETS).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      sel.appendChild(opt);
    });

    initTabs();
    bindDirectInputs();
    initButtons();

    setupDropzone("dropAttendance", "fileAttendance", handleAttendanceUpload);
    setupDropzone("dropTranscript", "fileTranscript", handleTranscriptUpload);
    setupDropzone("dropIndicators", "fileIndicators", handleIndicatorsUpload);

    try {
      const auth = await window.LocarApi.get("/api/auth/me", { skipAuthEvent: true });
      if (auth && auth.authenticated && auth.user) {
        await enterAuthenticatedApp(auth.user);
        return;
      }
    } catch {
      // Não autenticado: permanece na tela de login
    }
    showLoginScreen();
  });
})();
