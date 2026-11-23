// Controlador principal — LOCAR Atas & Plano de Ação (fluxo simplificado)
(function () {
  const $ = (id) => document.getElementById(id);

  const CUSTOM_PALETTES_KEY = "locar_custom_palettes_v1";
  const DEFAULT_PALETTES = [
    { name: "LOCAR Verde", primary: "#0a7e3a", secondary: "#b4c85a", builtin: true },
    { name: "Azul", primary: "#1565c0", secondary: "#64b5f6", builtin: true },
    { name: "Grafite", primary: "#263238", secondary: "#90a4ae", builtin: true },
    { name: "Petróleo", primary: "#00695c", secondary: "#80cbc4", builtin: true },
    { name: "Vinho", primary: "#7b1f3a", secondary: "#e57373", builtin: true },
    { name: "Laranja", primary: "#d84315", secondary: "#ffb74d", builtin: true }
  ];

  const STATUS_LABELS = {
    rascunho: "Em edição",
    aguardando_envio: "Em edição",
    link_enviado: "Link enviado",
    aguardando_confirmacao: "Aguardando confirmação",
    confirmada: "Confirmada",
    link_invalido: "Link expirado"
  };

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
  let historyActionRows = [];

  let state = clonePreset("blank");
  let currentZoom = 0.88;
  let lastTranscriptText = "";
  let dirtyFlag = false;
  let autoSaveTimer = null;
  let pendingCityLogoDataUrl = undefined;

  function clonePreset(presetId) {
    const src = window.LOCAR_PRESETS?.[presetId] || window.LOCAR_PRESETS?.blank || {};
    return JSON.parse(
      JSON.stringify({
        ...src,
        showTopics: typeof src.showTopics === "boolean" ? src.showTopics : false,
        showKpisOnSheet: false,
        densityMode: src.densityMode || "auto",
        headerTheme: src.headerTheme || "die",
        primaryColor: src.primaryColor || "#0a7e3a",
        secondaryColor: src.secondaryColor || "#b4c85a",
        reportLogoDataUrl: src.reportLogoDataUrl || "",
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
    toast._timer = setTimeout(() => toast.classList.remove("show"), 3200);
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

  function normalizeHex(color, fallback) {
    const raw = String(color || "").trim();
    const m = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return fallback;
    let hx = m[1];
    if (hx.length === 3) {
      hx = hx
        .split("")
        .map((c) => c + c)
        .join("");
    }
    return `#${hx.toLowerCase()}`;
  }

  function hexToRgb(hex) {
    const clean = normalizeHex(hex, "#0a7e3a").slice(1);
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }

  function mixRgb(rgb, target, ratio) {
    const ch = (i) => Math.max(0, minMax255(Math.round(rgb[i] * (1 - ratio) + target[i] * ratio)));
    return `#${[ch(0), ch(1), ch(2)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  function minMax255(n) {
    return Math.max(0, Math.min(255, n));
  }

  function applySheetThemeColors(sheet, primaryHex, secondaryHex) {
    if (!sheet) return;
    const pHex = normalizeHex(primaryHex, "#0a7e3a");
    const sHex = normalizeHex(secondaryHex, "#b4c85a");
    const [pr, pg, pb] = hexToRgb(pHex);
    const [sr, sg, sb] = hexToRgb(sHex);

    sheet.style.setProperty("--report-primary", pHex);
    sheet.style.setProperty("--report-primary-dark", mixRgb([pr, pg, pb], [0, 0, 0], 0.22));
    sheet.style.setProperty("--report-primary-light", mixRgb([pr, pg, pb], [255, 255, 255], 0.14));
    sheet.style.setProperty("--report-primary-soft", mixRgb([pr, pg, pb], [255, 255, 255], 0.92));
    sheet.style.setProperty("--report-primary-a44", `rgba(${pr}, ${pg}, ${pb}, 0.44)`);
    sheet.style.setProperty("--report-primary-a24", `rgba(${pr}, ${pg}, ${pb}, 0.24)`);
    sheet.style.setProperty("--report-secondary", sHex);
    sheet.style.setProperty("--report-secondary-a50", `rgba(${sr}, ${sg}, ${sb}, 0.50)`);
    sheet.style.setProperty("--report-secondary-a36", `rgba(${sr}, ${sg}, ${sb}, 0.36)`);
  }

  function loadCustomPalettes() {
    try {
      const raw = localStorage.getItem(CUSTOM_PALETTES_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveCustomPalettes(list) {
    try {
      localStorage.setItem(CUSTOM_PALETTES_KEY, JSON.stringify(list));
    } catch {
      // Ignora indisponibilidade de storage
    }
  }

  function isMeetingBlocked(meetingObj) {
    if (!meetingObj) return false;
    if (meetingObj.is_locked) return true;
    return ["link_enviado", "aguardando_confirmacao", "confirmada"].includes(meetingObj.workflow_status);
  }

  function isMeetingLocked() {
    return isMeetingBlocked(activeMeetingMeta);
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
    setSaveStatus("Salvando...", true);
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      saveActiveMeeting({ silent: true });
    }, 700);
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
    activeView = "dashboard";
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
    } else if (activeView === "editor") {
      await loadCityIntoEditor(selectedCityId, activeMeetingId);
    }
  }

  function populateGlobalCitySelect() {
    const sel = $("globalCitySelect");
    if (!sel) return;
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
    if (activeView === "editor" && dirtyFlag && activeMeetingId && !isMeetingLocked()) {
      await saveActiveMeeting({ silent: true });
    }
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
    }
  }

  // -------------------- VISÃO 1: Selecionar Cidade --------------------
  function renderDashboardView() {
    if (!dashboardCache) return;

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

    $("dashCountHint").textContent = `${rows.length} cidade(s)`;
    const grid = $("dashboardCitiesGrid");
    grid.innerHTML = "";

    rows.forEach((entry) => {
      const c = entry.city;
      const lm = entry.latest_meeting;
      const st = lm ? lm.workflow_status : "aguardando_envio";
      const stLabel = lm ? STATUS_LABELS[st] || lm.workflow_label : "Sem reunião";
      const thumbHtml = c.logo_data_url
        ? `<img src="${escapeAttr(c.logo_data_url)}" alt="${escapeAttr(c.name)}" />`
        : escapeHtml((c.project_code || c.name.slice(0, 3)).toUpperCase());

      const card = document.createElement("div");
      card.className = "city-card city-card-simple";
      card.innerHTML = `
        <div class="city-card-top">
          <div class="city-card-identity">
            <div class="city-logo-thumb">${thumbHtml}</div>
            <div class="city-card-headings">
              <h3 class="city-card-title">${escapeHtml(c.name)}${c.state_uf ? " — " + escapeHtml(c.state_uf) : ""}</h3>
              <div class="city-card-sub">${escapeHtml(c.project_name)}</div>
            </div>
          </div>
        </div>

        <div class="city-card-status-row">
          <span class="status-badge ${escapeAttr(st)}">${escapeHtml(stLabel)}</span>
          <span class="city-card-period">${lm ? escapeHtml(lm.reference_label || lm.date_text || "—") : "Sem ata"}</span>
        </div>

        <div class="city-card-summary">
          <span><strong>${entry.meetings_count}</strong> reunião(ões)</span>
          <span><strong>${entry.pending_actions}</strong> pendência(s)</span>
        </div>

        <div class="city-card-actions">
          <button type="button" class="btn btn-primary btn-sm js-open-history" style="flex:1;">Ver Reuniões</button>
          <button type="button" class="btn btn-outline btn-sm js-edit-city">Editar</button>
        </div>
      `;

      card.querySelector(".js-open-history").addEventListener("click", async () => {
        selectedCityId = c.id;
        activeMeetingId = null;
        populateGlobalCitySelect();
        await switchView("city-history");
      });
      card.querySelector(".js-edit-city").addEventListener("click", () => openCityModal(c));
      grid.appendChild(card);
    });
  }

  // -------------------- VISÃO 2: Reuniões / Histórico da Cidade --------------------
  async function loadCityHistoryView() {
    if (!selectedCityId) return;
    const data = await window.LocarApi.get(`/api/cities/${selectedCityId}/timeline`);
    const city = data.city;
    activeCityObj = city;
    historyActionRows = data.action_history || [];

    const logoHtml = city.logo_data_url
      ? `<img src="${escapeAttr(city.logo_data_url)}" alt="${escapeAttr(city.name)}" />`
      : escapeHtml(city.project_code || "LOCAR");

    $("cityHistoryHero").innerHTML = `
      <div class="city-hero-left">
        <button type="button" id="btnHistBackToCities" class="btn btn-outline btn-sm">← Cidades</button>
        <div class="city-hero-logo">${logoHtml}</div>
        <div>
          <h2 style="margin:0; font-size:18px; color:var(--locar-green-dark);">${escapeHtml(city.name)}${city.state_uf ? " (" + escapeHtml(city.state_uf) + ")" : ""}</h2>
          <div style="font-size:12.5px; color:var(--ui-muted);">${escapeHtml(city.project_name)}</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button type="button" id="btnHistEditCity" class="btn btn-outline btn-sm">Editar Cidade</button>
      </div>
    `;

    $("btnHistBackToCities").addEventListener("click", () => switchView("dashboard"));
    $("btnHistEditCity").addEventListener("click", () => openCityModal(city));

    renderCityTimelineTable(city, data.meetings || []);
    renderCityActionTrackerTable();
  }

  function renderCityTimelineTable(city, meetings) {
    const tbody = $("cityTimelineBody");
    tbody.innerHTML = "";
    if (!meetings || meetings.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="hint" style="padding:16px;">Nenhuma reunião criada ainda. Clique em "+ Nova Reunião".</td></tr>`;
      return;
    }

    meetings.forEach((m) => {
      const blocked = isMeetingBlocked(m);
      const stLabel = STATUS_LABELS[m.workflow_status] || m.workflow_label;
      const consent = m.latest_consent;
      const statusDetail = consent
        ? `<br/><span class="hint">Consentido por ${escapeHtml(consent.representative_name)}</span>`
        : "";

      const actionsHtml = blocked
        ? `
          <button type="button" class="btn btn-secondary btn-sm js-tl-view">Ver Relatório / PDF</button>
          <button type="button" class="btn btn-outline btn-sm js-tl-link">Link</button>
        `
        : `
          <button type="button" class="btn btn-primary btn-sm js-tl-edit">Editar</button>
          <button type="button" class="btn btn-outline btn-sm js-tl-send-link">Enviar Link</button>
        `;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(m.title)}</strong><br/><span class="hint">${escapeHtml(m.reference_label || "—")}</span></td>
        <td>${escapeHtml(m.date_text || m.meeting_date || "—")}</td>
        <td><span class="status-badge ${escapeAttr(m.workflow_status)}">${escapeHtml(stLabel)}</span>${statusDetail}</td>
        <td>${m.completed_actions}/${m.total_actions} concluída(s)</td>
        <td><div style="display:flex; gap:6px; flex-wrap:wrap;">${actionsHtml}</div></td>
      `;

      const btnEdit = tr.querySelector(".js-tl-edit");
      if (btnEdit) {
        btnEdit.addEventListener("click", async () => {
          activeMeetingId = m.id;
          await switchView("editor");
        });
      }

      const btnSendLink = tr.querySelector(".js-tl-send-link");
      if (btnSendLink) {
        btnSendLink.addEventListener("click", async () => {
          activeMeetingId = m.id;
          await loadMeetingIntoEditor(m.id);
          await sendPublicLinkFromCurrentState();
          await loadCityHistoryView();
        });
      }

      const btnView = tr.querySelector(".js-tl-view");
      if (btnView) {
        btnView.addEventListener("click", async () => {
          activeMeetingId = m.id;
          await switchView("editor");
        });
      }

      const btnLink = tr.querySelector(".js-tl-link");
      if (btnLink) {
        btnLink.addEventListener("click", async () => {
          activeMeetingId = m.id;
          await loadMeetingIntoEditor(m.id);
          await openPublicLinkModal();
        });
      }

      tbody.appendChild(tr);
    });
  }

  function renderCityActionTrackerTable() {
    const actBody = $("cityActionTrackerBody");
    const filterVal = $("historyActionFilter")?.value || "all";
    const rows = historyActionRows.filter((act) => {
      if (filterVal === "pending") return !act.checked_completed;
      if (filterVal === "done") return Boolean(act.checked_completed);
      return true;
    });

    actBody.innerHTML = "";
    if (rows.length === 0) {
      actBody.innerHTML = `<tr><td colspan="7" class="hint" style="padding:16px;">Nenhuma ação encontrada.</td></tr>`;
      return;
    }

    rows.forEach((act) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" class="js-act-chk" ${act.checked_completed ? "checked" : ""} /></td>
        <td><strong>${escapeHtml(act.reference_label || act.meeting_title)}</strong></td>
        <td>${escapeHtml(act.action)}</td>
        <td>${escapeHtml(act.owner || "—")}</td>
        <td>${escapeHtml(act.deadline || "—")}</td>
        <td>
          <select class="js-act-status">
            <option value="pendente" ${act.tracking_status === "pendente" ? "selected" : ""}>Pendente</option>
            <option value="em_andamento" ${act.tracking_status === "em_andamento" ? "selected" : ""}>Em andamento</option>
            <option value="concluida" ${act.tracking_status === "concluida" ? "selected" : ""}>Concluída</option>
            <option value="nao_realizada" ${act.tracking_status === "nao_realizada" ? "selected" : ""}>Não realizada</option>
          </select>
        </td>
        <td>
          <input type="text" class="js-act-notes" value="${escapeAttr(act.follow_up_notes || "")}" placeholder="Observação..." style="min-width:160px; padding:4px 7px; border:1px solid var(--ui-border); border-radius:6px;" />
        </td>
      `;

      const chk = tr.querySelector(".js-act-chk");
      const sel = tr.querySelector(".js-act-status");
      const notes = tr.querySelector(".js-act-notes");

      const commitRow = async () => {
        act.checked_completed = chk.checked;
        act.tracking_status = sel.value;
        act.follow_up_notes = notes.value;
        await saveActionTracking(act.id, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status,
          follow_up_notes: act.follow_up_notes
        });
        if (selectedCityId && activeView === "city-history") {
          window.LocarApi.get(`/api/cities/${selectedCityId}/timeline`)
            .then((tl) => {
              renderCityTimelineTable(tl.city, tl.meetings || []);
            })
            .catch(() => {});
        }
      };

      chk.addEventListener("change", async () => {
        sel.value = chk.checked ? "concluida" : "pendente";
        await commitRow();
      });

      sel.addEventListener("change", async () => {
        chk.checked = sel.value === "concluida";
        await commitRow();
      });

      notes.addEventListener("change", commitRow);

      actBody.appendChild(tr);
    });
  }

  async function saveActionTracking(actionId, payload) {
    try {
      await window.LocarApi.patch(`/api/actions/${actionId}/tracking`, payload);
      showToast("Status do plano de ação atualizado!");
    } catch (err) {
      showToast("Erro ao atualizar status: " + err.message);
    }
  }

  // -------------------- Modal de Cidade --------------------
  function openCityModal(cityObj = null) {
    pendingCityLogoDataUrl = undefined;
    $("cityModalTitle").textContent = cityObj ? `Editar Cidade — ${cityObj.name}` : "Nova Cidade";
    $("cityFormId").value = cityObj ? cityObj.id : "";
    $("cityNameInput").value = cityObj ? cityObj.name : "";
    $("cityUfInput").value = cityObj ? (cityObj.state_uf || "PE") : "PE";
    $("cityProjectNameInput").value = cityObj ? cityObj.project_name : "";
    $("cityProjectCodeInput").value = cityObj ? (cityObj.project_code || "") : `LOCAR-${String(citiesList.length + 1).padStart(2, "0")}`;
    $("cityOrderInput").value = cityObj ? (cityObj.display_order || 1) : citiesList.length + 1;
    $("cityLocalInput").value = cityObj ? (cityObj.default_local || "Microsoft Teams") : "Microsoft Teams";
    $("cityFooterInput").value = cityObj ? (cityObj.default_footer || "DIE – Departamento de Inteligência Estratégica") : "DIE – Departamento de Inteligência Estratégica";
    $("cityActiveInput").checked = cityObj ? Boolean(cityObj.is_active) : true;
    $("cityLogoInput").value = "";

    updateCityLogoPreview(cityObj?.logo_data_url || "");
    $("modalCityForm").classList.remove("hidden");
  }

  function updateCityLogoPreview(dataUrl) {
    const box = $("cityLogoPreview");
    if (!box) return;
    if (dataUrl) {
      box.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="Logo" />`;
    } else {
      box.innerHTML = `<span class="hint">Sem logo</span>`;
    }
  }

  // -------------------- VISÃO 3: Editor / Visualização do Relatório --------------------
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
        footerText: activeCityObj.default_footer || "DIE – Departamento de Inteligência Estratégica",
        primaryColor: activeCityObj.default_primary_color || "#0a7e3a",
        secondaryColor: activeCityObj.default_secondary_color || "#b4c85a",
        reportLogoDataUrl: activeCityObj.report_logo_data_url || ""
      };
      applyEditorStateToUi();
      return;
    }

    meetings.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      const stLabel = STATUS_LABELS[m.workflow_status] || m.workflow_label;
      opt.textContent = `${m.reference_label || m.title} (${stLabel})`;
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
    state = {
      ...data.meeting.snapshot,
      primaryColor: data.meeting.snapshot.primaryColor || activeCityObj?.default_primary_color || "#0a7e3a",
      secondaryColor: data.meeting.snapshot.secondaryColor || activeCityObj?.default_secondary_color || "#b4c85a",
      reportLogoDataUrl: data.meeting.snapshot.reportLogoDataUrl || ""
    };
    dirtyFlag = false;
    setSaveStatus("Salvo");
    applyEditorStateToUi();
  }

  function applyEditorStateToUi() {
    const locked = isMeetingLocked();
    const hasMeeting = Boolean(activeMeetingId);
    const st = activeMeetingMeta ? activeMeetingMeta.workflow_status : "rascunho";
    const stLabel = activeMeetingMeta ? (STATUS_LABELS[st] || activeMeetingMeta.workflow_label) : "Sem reunião";

    const badge = $("editorStatusBadge");
    badge.className = `status-badge ${st}`;
    badge.textContent = stLabel;

    // Sub-barra: alterna modo editável vs bloqueado (opção de editar some)
    $("editorEditableActions").classList.toggle("hidden", locked || !hasMeeting);
    $("editorLockedActions").classList.toggle("hidden", !locked || !hasMeeting);

    // Painel esquerdo: abas de edição vs painel exclusivo de status do plano de ação
    $("editorEditablePanel").classList.toggle("hidden", locked);
    $("lockedActionsPanel").classList.toggle("hidden", !locked);

    // Banner de bloqueio
    const banner = $("lockedMeetingBanner");
    if (locked) {
      const latestConsent = activeConsents[0];
      const infoText = latestConsent
        ? `Confirmada por ${latestConsent.representative_name} (${formatDateTimeBr(latestConsent.accepted_at)}) — edição bloqueada.`
        : "Link enviado — relatório bloqueado para edição. Apenas o status do plano de ação pode ser alterado.";
      $("lockedMeetingInfo").innerHTML = `<strong>${escapeHtml(infoText)}</strong>`;
      banner.classList.remove("hidden");
      $("previewToolbarHint").textContent = "Visualização A4 (somente leitura)";
    } else {
      banner.classList.add("hidden");
      $("previewToolbarHint").textContent = hasMeeting
        ? "Clique em qualquer texto ou na logo para editar"
        : "Clique em '+ Nova Reunião' para começar";
    }

    // Desabilita controles se não houver reunião ou se estiver bloqueada
    document.querySelectorAll("#editorEditablePanel input, #editorEditablePanel textarea, #editorEditablePanel select, #editorEditablePanel button").forEach((el) => {
      if (el.id === "inpGeminiKey") return;
      if (el.classList.contains("tab-btn")) return;
      el.disabled = locked || !hasMeeting;
    });

    if (locked) {
      renderLockedActionsPanel();
    } else {
      renderPreviousMeetingFollowUp();
      renderEditorInputs();
    }
    renderSheet();
  }

  function renderLockedActionsPanel() {
    const list = $("lockedActionsList");
    list.innerHTML = "";
    const actions = state.actions || [];
    if (actions.length === 0) {
      list.innerHTML = `<p class="hint">Nenhum item no plano de ação.</p>`;
      return;
    }

    actions.forEach((act) => {
      const card = document.createElement("div");
      card.className = `locked-action-card ${act.checked_completed ? "done" : ""}`;
      card.innerHTML = `
        <div class="locked-action-title">${escapeHtml(act.action || "Item sem descrição")}</div>
        <div class="locked-action-meta">Responsável: ${escapeHtml(act.owner || "—")} • Prazo: ${escapeHtml(act.deadline || "—")}</div>
        <div class="locked-action-controls">
          <input type="checkbox" class="js-lk-chk" ${act.checked_completed ? "checked" : ""} title="Concluída" />
          <select class="js-lk-status">
            <option value="pendente" ${act.tracking_status === "pendente" ? "selected" : ""}>Pendente</option>
            <option value="em_andamento" ${act.tracking_status === "em_andamento" ? "selected" : ""}>Em andamento</option>
            <option value="concluida" ${act.tracking_status === "concluida" ? "selected" : ""}>Concluída</option>
            <option value="nao_realizada" ${act.tracking_status === "nao_realizada" ? "selected" : ""}>Não realizada</option>
          </select>
        </div>
        <input type="text" class="js-lk-notes" value="${escapeAttr(act.follow_up_notes || "")}" placeholder="Observação..." style="padding:5px 8px; border:1px solid var(--ui-border); border-radius:6px; font-size:12px;" />
      `;

      const chk = card.querySelector(".js-lk-chk");
      const sel = card.querySelector(".js-lk-status");
      const notes = card.querySelector(".js-lk-notes");

      const saveRow = async () => {
        if (!act.id) return;
        act.checked_completed = chk.checked;
        act.tracking_status = sel.value;
        act.follow_up_notes = notes.value;
        card.classList.toggle("done", act.checked_completed);
        await saveActionTracking(act.id, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status,
          follow_up_notes: act.follow_up_notes
        });
      };

      chk.addEventListener("change", async () => {
        sel.value = chk.checked ? "concluida" : "pendente";
        await saveRow();
      });

      sel.addEventListener("change", async () => {
        chk.checked = sel.value === "concluida";
        await saveRow();
      });

      notes.addEventListener("change", saveRow);

      list.appendChild(card);
    });
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
    $("prevMeetingTitle").textContent = `Pendências — ${activePreviousMeeting.reference_label || activePreviousMeeting.title}`;
    list.innerHTML = "";

    activePreviousMeeting.actions.forEach((act) => {
      const row = document.createElement("div");
      row.className = `followup-item ${act.checked_completed ? "done" : ""}`;
      row.innerHTML = `
        <label class="followup-check-row">
          <input type="checkbox" class="js-prev-chk" ${act.checked_completed ? "checked" : ""} />
          <div>
            <div class="followup-item-title">${escapeHtml(act.action)}</div>
            <div class="followup-item-meta">${escapeHtml(act.owner || "—")} • ${escapeHtml(act.deadline || "—")}</div>
          </div>
        </label>
        <div class="followup-controls">
          <select class="js-prev-status">
            <option value="pendente" ${act.tracking_status === "pendente" ? "selected" : ""}>Pendente</option>
            <option value="em_andamento" ${act.tracking_status === "em_andamento" ? "selected" : ""}>Em andamento</option>
            <option value="concluida" ${act.tracking_status === "concluida" ? "selected" : ""}>Concluída</option>
            <option value="nao_realizada" ${act.tracking_status === "nao_realizada" ? "selected" : ""}>Não realizada</option>
          </select>
        </div>
      `;

      const chk = row.querySelector(".js-prev-chk");
      const sel = row.querySelector(".js-prev-status");

      chk.addEventListener("change", async () => {
        act.checked_completed = chk.checked;
        act.tracking_status = chk.checked ? "concluida" : "pendente";
        sel.value = act.tracking_status;
        row.classList.toggle("done", chk.checked);
        await saveActionTracking(act.id, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status
        });
      });

      sel.addEventListener("change", async () => {
        act.tracking_status = sel.value;
        act.checked_completed = sel.value === "concluida";
        chk.checked = act.checked_completed;
        row.classList.toggle("done", act.checked_completed);
        await saveActionTracking(act.id, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status
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
      activeCityObj = res.city || activeCityObj;
      activeVersions = res.versions || [];
      activeLink = res.active_link || null;
      activeConsents = res.consents || [];
      // Sincroniza IDs gerados para novas ações sem perder edição ativa
      if (Array.isArray(res.meeting?.snapshot?.actions)) {
        state.actions = res.meeting.snapshot.actions;
      }
      dirtyFlag = false;
      setSaveStatus("Salvo");
      if (!opts.silent) {
        showToast("Relatório salvo!");
      }
      return res;
    } catch (err) {
      setSaveStatus("Erro ao salvar", true);
      if (!opts.silent) {
        showToast("Erro ao salvar: " + err.message);
      }
      return null;
    }
  }

  // -------------------- Renderização da Folha A4 --------------------
  function renderSheet() {
    const sheet = $("a4Sheet");
    const isDieTheme = state.headerTheme !== "locar";
    sheet.classList.toggle("theme-locar", !isDieTheme);

    const primaryHex = normalizeHex(state.primaryColor, "#0a7e3a");
    const secondaryHex = normalizeHex(state.secondaryColor, "#b4c85a");
    applySheetThemeColors(sheet, primaryHex, secondaryHex);

    const hasCustomLogo = Boolean((state.reportLogoDataUrl || "").trim());
    sheet.classList.toggle("has-custom-report-logo", hasCustomLogo);

    const logoImg = $("sheetLogoImg");
    if (hasCustomLogo) {
      logoImg.src = state.reportLogoDataUrl;
    } else if (window.LOCAR_LOGOS) {
      logoImg.src = isDieTheme ? window.LOCAR_LOGOS.white : window.LOCAR_LOGOS.color;
    } else {
      logoImg.src = isDieTheme ? "assets/logo-locar-white.png" : "assets/logo-locar.png";
    }

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

    const editable = !isMeetingLocked() && Boolean(activeMeetingId);
    sheet.dataset.editable = editable ? "true" : "false";
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
      if ($(id)) $(id).contentEditable = editable ? "true" : "false";
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

    const tbody = $("sheetActionBody");
    tbody.innerHTML = "";

    (state.actions || []).forEach((item, idx) => {
      const tr = document.createElement("tr");

      const tdAction = createEditableCell(item.action, !editable, (val) => {
        state.actions[idx].action = val;
        syncActionInput(idx, "action", val);
        markDirtyAndScheduleSave();
      });

      const tdOwner = createEditableCell(item.owner, !editable, (val) => {
        state.actions[idx].owner = val;
        syncActionInput(idx, "owner", val);
        markDirtyAndScheduleSave();
      });

      const tdDeadline = createEditableCell(item.deadline, !editable, (val) => {
        state.actions[idx].deadline = val;
        syncActionInput(idx, "deadline", val);
        markDirtyAndScheduleSave();
      });

      const tdStatus = createEditableCell(item.status || "", !editable, (val) => {
        state.actions[idx].status = val;
        syncActionInput(idx, "status", val);
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
    $("chkShowTopics").checked = Boolean(state.showTopics);
    $("selHeaderTheme").value = state.headerTheme || "die";
    $("selDensity").value = state.densityMode || "auto";
    $("inpBlankRows").value = state.extraBlankRows ?? 1;

    const pHex = normalizeHex(state.primaryColor, "#0a7e3a");
    const sHex = normalizeHex(state.secondaryColor, "#b4c85a");
    $("inpPrimaryColor").value = pHex;
    $("inpPrimaryColorHex").value = pHex;
    $("inpSecondaryColor").value = sHex;
    $("inpSecondaryColorHex").value = sHex;

    renderLogoPreviews();
    renderColorPalettes();
    renderTopicsEditor();
    renderActionsEditor();
  }

  function renderLogoPreviews() {
    const repBox = $("reportLogoPreview");
    if (repBox) {
      const customSrc = (state.reportLogoDataUrl || "").trim();
      const previewSrc = customSrc || window.LOCAR_LOGOS?.color || "assets/logo-locar.png";
      repBox.innerHTML = `<img src="${escapeAttr(previewSrc)}" alt="Logo do Relatório" />`;
    }

    const cityBox = $("editorCityLogoPreview");
    if (cityBox) {
      const citySrc = activeCityObj?.logo_data_url || "";
      if (citySrc) {
        cityBox.innerHTML = `<img src="${escapeAttr(citySrc)}" alt="Logo da Cidade" />`;
      } else {
        cityBox.innerHTML = `<span class="hint">Sem logo</span>`;
      }
    }
  }

  function renderColorPalettes() {
    const container = $("colorPaletteSwatches");
    if (!container) return;
    const currentP = normalizeHex(state.primaryColor, "#0a7e3a");
    const currentS = normalizeHex(state.secondaryColor, "#b4c85a");
    const customList = loadCustomPalettes().map((p, i) => ({ ...p, builtin: false, customIdx: i }));
    const allPalettes = [...DEFAULT_PALETTES, ...customList];

    container.innerHTML = "";
    allPalettes.forEach((pal) => {
      const isActive =
        normalizeHex(pal.primary, "") === currentP &&
        normalizeHex(pal.secondary, "") === currentS;
      const btn = document.createElement("div");
      btn.className = `palette-swatch ${isActive ? "active" : ""}`;
      btn.title = `${pal.name} (${pal.primary} / ${pal.secondary})`;
      btn.innerHTML = `
        <span class="palette-dots">
          <span class="palette-dot" style="background:${escapeAttr(pal.primary)};"></span>
          <span class="palette-dot" style="background:${escapeAttr(pal.secondary)};"></span>
        </span>
        <span>${escapeHtml(pal.name)}</span>
        ${pal.builtin ? "" : '<button type="button" class="palette-swatch-del" title="Remover cor">✕</button>'}
      `;

      btn.addEventListener("click", (e) => {
        if (e.target.classList.contains("palette-swatch-del")) {
          const list = loadCustomPalettes();
          list.splice(pal.customIdx, 1);
          saveCustomPalettes(list);
          renderColorPalettes();
          return;
        }
        if (isMeetingLocked()) return;
        state.primaryColor = normalizeHex(pal.primary, "#0a7e3a");
        state.secondaryColor = normalizeHex(pal.secondary, "#b4c85a");
        $("inpPrimaryColor").value = state.primaryColor;
        $("inpPrimaryColorHex").value = state.primaryColor;
        $("inpSecondaryColor").value = state.secondaryColor;
        $("inpSecondaryColorHex").value = state.secondaryColor;
        renderColorPalettes();
        renderSheet();
        markDirtyAndScheduleSave();
      });

      container.appendChild(btn);
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
          <button type="button" class="icon-btn del" title="Excluir" ${locked ? "disabled" : ""}>✕</button>
        </div>
        <div class="field">
          <label>Área / Tema</label>
          <input type="text" class="topic-area-inp" value="${escapeAttr(t.area)}" ${locked ? "disabled" : ""} />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Detalhes</label>
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
      const fromPrevBadge = item.origin_action_id
        ? ' <span style="font-size:10px; color:#5a695d;">(pendente anterior)</span>'
        : "";
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-badge">Ação #${idx + 1}${fromPrevBadge}</span>
          <div class="action-card-controls">
            <button type="button" class="icon-btn up" title="Subir" ${locked ? "disabled" : ""}>↑</button>
            <button type="button" class="icon-btn down" title="Descer" ${locked ? "disabled" : ""}>↓</button>
            <button type="button" class="icon-btn del" title="Remover" ${locked ? "disabled" : ""}>✕</button>
          </div>
        </div>
        <div class="field">
          <label>Item de ação</label>
          <textarea rows="2" class="act-action" ${locked ? "disabled" : ""}>${escapeHtml(item.action)}</textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Proprietários</label>
            <input type="text" class="act-owner" value="${escapeAttr(item.owner)}" ${locked ? "disabled" : ""} />
          </div>
          <div class="field">
            <label>Prazo</label>
            <input type="text" class="act-deadline" value="${escapeAttr(item.deadline)}" ${locked ? "disabled" : ""} />
          </div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Status na folha (opcional)</label>
          <input type="text" class="act-status" value="${escapeAttr(item.status || "")}" placeholder="Deixe vazio para preencher depois" ${locked ? "disabled" : ""} />
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

      card.querySelector(".act-status").addEventListener("input", (e) => {
        state.actions[idx].status = e.target.value;
        renderSheet();
        markDirtyAndScheduleSave();
      });

      container.appendChild(card);
    });
  }

  function syncActionInput(idx, field, val) {
    const card = document.querySelector(`.action-editor-card[data-idx="${idx}"]`);
    if (!card) return;
    const map = {
      action: ".act-action",
      owner: ".act-owner",
      deadline: ".act-deadline",
      status: ".act-status"
    };
    const el = card.querySelector(map[field] || ".act-action");
    if (el && document.activeElement !== el) {
      el.value = val;
    }
  }

  // -------------------- Upload & Análise de Reunião --------------------
  function setupDropzone(zoneId, inputId, handler) {
    const zone = $(zoneId);
    const input = $(inputId);
    if (!zone || !input) return;
    zone.addEventListener("click", () => {
      if (isMeetingLocked() || !activeMeetingId) return;
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
      if (isMeetingLocked() || !activeMeetingId) return;
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
      statusEl.textContent = `✓ ${file.name} — ${parsed.participantsList.length} participantes.`;
      statusEl.classList.add("visible");

      renderEditorInputs();
      renderSheet();
      markDirtyAndScheduleSave();
      showToast(`Presença importada (${parsed.participantsList.length} participantes).`);
    } catch (err) {
      showToast("Erro ao ler presença: " + err.message);
    }
  }

  async function handleTranscriptUpload(file) {
    if (isMeetingLocked()) return;
    try {
      const ext = file.name.split(".").pop().toLowerCase();
      let text = "";
      const buf = await file.arrayBuffer();
      if (ext === "docx") {
        text = await window.LocarParser.extractTextFromDocx(buf);
      } else {
        text = window.LocarParser.decodeFileBuffer(buf);
      }
      lastTranscriptText = text;
      $("inpTranscriptPaste").value =
        text.slice(0, 20000) + (text.length > 20000 ? "\n\n[...texto carregado...]" : "");

      const statusEl = $("transcriptStatus");
      statusEl.textContent = `✓ ${file.name} carregado.`;
      statusEl.classList.add("visible");

      await processTranscriptText(text);
    } catch (err) {
      showToast("Erro ao ler transcrição: " + err.message);
    }
  }

  async function processTranscriptText(textOverride) {
    if (isMeetingLocked() || !activeMeetingId) return;
    const raw = (textOverride || lastTranscriptText || $("inpTranscriptPaste").value || "").trim();
    if (!raw) {
      showToast("Suba ou cole o texto da reunião antes de gerar o resumo.");
      return;
    }
    lastTranscriptText = raw;

    const apiKey = ($("inpGeminiKey")?.value || "").trim();
    const btn = $("btnAnalyzeTranscript");
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = apiKey ? "Analisando com IA..." : "Gerando resumo...";

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
          timeText: state.timeText,
          participants: state.participants
        });
        if (result.title) state.title = result.title;
        if (result.refMonthYear) state.referenceLabel = result.refMonthYear;
      }

      if (result.unitName) state.unitName = result.unitName;
      if (result.dateText && !state.dateText) state.dateText = result.dateText;
      if (result.timeText && !state.timeText) state.timeText = result.timeText;
      if (result.participantsText && !state.participants) state.participants = result.participantsText;
      if (result.summary) state.summary = result.summary;
      if (Array.isArray(result.topics) && result.topics.length > 0) {
        state.topics = result.topics;
      }

      // Preserva pendências puxadas da reunião anterior e adiciona novas ações extraídas
      const inheritedActions = (state.actions || []).filter(
        (a) => a.origin_action_id && (a.action || "").trim().length > 0
      );
      const existingActionTexts = new Set(
        inheritedActions.map((a) => (a.action || "").trim().toLowerCase())
      );
      const extracted = (Array.isArray(result.actions) ? result.actions : [])
        .map((a) => ({ ...a, status: "" }))
        .filter((a) => (a.action || "").trim() && !existingActionTexts.has((a.action || "").trim().toLowerCase()));

      state.actions = [...inheritedActions, ...extracted];
      state.indicators = [];

      renderEditorInputs();
      renderSheet();
      await saveActiveMeeting({ silent: true });
      showToast(`Resumo e plano de ação gerados (${state.actions.length} ações).`);
    } catch (err) {
      showToast("Erro na análise: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  // -------------------- Exportação Word (.doc) --------------------
  function exportToWord() {
    const primaryHex = normalizeHex(state.primaryColor, "#0a7e3a");
    const logoSrc = (state.reportLogoDataUrl || "").trim() || window.LOCAR_LOGOS?.color || "assets/logo-locar.png";
    const cityLogoHtml = activeCityObj?.logo_data_url
      ? `<img src="${escapeAttr(activeCityObj.logo_data_url)}" width="95" alt="Logo Cidade" style="display:block; margin-bottom:6px;" />`
      : "";
    const topicsHtml =
      state.showTopics && state.topics?.length
        ? `<div style="margin:8px 0 12px 20px; padding:8px 12px; background:#f2f9f4; border-left:3.5px solid ${primaryHex}; font-size:9.5pt;">
             <div style="font-weight:bold; color:${primaryHex}; margin-bottom:4px;">PRINCIPAIS TÓPICOS E ASSUNTOS DESTACADOS</div>
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
  <table width="100%" cellspacing="0" cellpadding="6" style="background:${primaryHex}; color:#ffffff; margin-bottom:12px;">
    <tr><td align="right" style="font-size:12pt; font-weight:bold;">${escapeHtml(state.unitName)}</td></tr>
  </table>
  <table width="100%" cellspacing="0" cellpadding="4" style="margin-bottom:12px;">
    <tr>
      <td width="38%" valign="top"><img src="${escapeAttr(logoSrc)}" width="170" alt="Logo" /></td>
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ata_${fileSlug}.doc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Word exportado!");
  }

  // -------------------- Envio do Link & Bloqueio Imediato --------------------
  async function sendPublicLinkFromCurrentState() {
    if (!activeMeetingId) return;
    if (isMeetingLocked()) {
      await openPublicLinkModal();
      return;
    }

    const btn = $("btnGeneratePublicLink");
    const oldText = btn ? btn.textContent : "Enviar Link";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Gerando link...";
    }

    try {
      const res = await window.LocarApi.post(`/api/meetings/${activeMeetingId}/public-link`, {
        snapshot: state,
        auto_finalize: true,
        expires_in_days: 30
      });
      if (res.public_url) {
        await window.LocarApi.copyToClipboard(res.public_url).catch(() => {});
      }
      await loadMeetingIntoEditor(activeMeetingId);
      const sel = $("selCityMeeting");
      if (sel && sel.selectedIndex >= 0) {
        sel.options[sel.selectedIndex].textContent = `${state.referenceLabel || state.title} (${STATUS_LABELS.link_enviado})`;
      }
      showToast("Link gerado e copiado! Edição do relatório bloqueada.");
      await openPublicLinkModal();
    } catch (err) {
      showToast("Erro ao gerar link: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  async function openPublicLinkModal() {
    if (!activeMeetingId) return;
    const data = await window.LocarApi.get(`/api/meetings/${activeMeetingId}/versions`);
    activeVersions = data.versions || [];
    const currentVer = activeVersions.find((v) => v.is_current);
    activeLink = (data.links || []).find((l) => l.status === "active") || null;

    const body = $("publicLinkBody");
    const confirmed = activeMeetingMeta?.workflow_status === "confirmada" || currentVer?.has_consent;

    if (confirmed) {
      const consent = (data.consents || []).find((c) => c.version_number === currentVer?.version_number) || data.consents?.[0];
      body.innerHTML = `
        <div class="login-note" style="margin-top:0; border-left-color:#2e7d32;">
          <strong>Consentimento registrado.</strong><br/>
          ${consent ? `Confirmado por <b>${escapeHtml(consent.representative_name)}</b> (${escapeHtml(consent.representative_email)}) em ${formatDateTimeBr(consent.accepted_at)} • Protocolo <b>${escapeHtml(consent.protocol_code)}</b>.` : ""}
        </div>
        ${currentVer ? `<div style="margin-top:12px;"><a href="/api/meetings/${activeMeetingId}/versions/${currentVer.id}/pdf?download=1" class="btn btn-primary btn-sm" style="text-decoration:none;">Baixar PDF Confirmado</a></div>` : ""}
      `;
      $("modalPublicLink").classList.remove("hidden");
      return;
    }

    if (activeLink) {
      body.innerHTML = `
        <div class="section-card" style="margin-bottom:0;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong>Link para Consentimento</strong>
            <span class="status-badge ${escapeAttr(activeMeetingMeta?.workflow_status || "link_enviado")}">${escapeHtml(STATUS_LABELS[activeMeetingMeta?.workflow_status] || "Link enviado")}</span>
          </div>
          <div class="copy-link-row">
            <input type="text" id="inpActivePublicUrl" value="${escapeAttr(activeLink.public_url || "")}" readonly />
            <button type="button" id="btnCopyPublicUrl" class="btn btn-primary btn-sm">Copiar</button>
            <a href="${escapeAttr(activeLink.public_url || "#")}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="text-decoration:none;">Abrir</a>
          </div>
          <p class="hint" style="margin-top:8px;">
            Válido até ${formatDateTimeBr(activeLink.expires_at)} • Acessos: <b>${activeLink.view_count}</b>
          </p>
          <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
            ${currentVer ? `<a href="/api/meetings/${activeMeetingId}/versions/${currentVer.id}/pdf" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration:none;">Ver PDF</a>` : ""}
            <button type="button" id="btnRenewPublicLink" class="btn btn-outline btn-sm">Gerar Novo Link</button>
          </div>
        </div>
      `;

      $("btnCopyPublicUrl").addEventListener("click", async () => {
        await window.LocarApi.copyToClipboard($("inpActivePublicUrl").value);
        showToast("Link copiado!");
      });

      $("btnRenewPublicLink").addEventListener("click", async () => {
        const res = await window.LocarApi.post(`/api/meetings/${activeMeetingId}/public-link`, { expires_in_days: 30 });
        await window.LocarApi.copyToClipboard(res.public_url).catch(() => {});
        showToast("Novo link gerado e copiado!");
        await loadMeetingIntoEditor(activeMeetingId);
        await openPublicLinkModal();
      });
    } else {
      body.innerHTML = `
        <p class="hint" style="margin-bottom:12px;">Nenhum link ativo no momento.</p>
        <button type="button" id="btnCreateLinkNow" class="btn btn-primary btn-sm">Gerar Link Agora</button>
      `;
      $("btnCreateLinkNow").addEventListener("click", async () => {
        await window.LocarApi.post(`/api/meetings/${activeMeetingId}/public-link`, { expires_in_days: 30 });
        await loadMeetingIntoEditor(activeMeetingId);
        await openPublicLinkModal();
      });
    }

    $("modalPublicLink").classList.remove("hidden");
  }

  // -------------------- Usuários Admin --------------------
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
          ${u.id !== currentAdmin?.id ? `<button type="button" class="btn btn-outline btn-sm js-toggle-admin" data-id="${u.id}" data-active="${u.is_active}">${u.is_active ? "Desativar" : "Ativar"}</button>` : "<span class='hint'>Atual</span>"}
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
            <label for="inpNewPw">Nova senha (mín. 8)</label>
            <input type="password" id="inpNewPw" minlength="8" required />
          </div>
          <button type="submit" class="btn btn-secondary btn-sm" style="height:36px;">Alterar</button>
        </form>
      </div>

      <div class="section-card">
        <h3>Novo Usuário</h3>
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
            <label for="inpNewAdminPw">Senha</label>
            <input type="password" id="inpNewAdminPw" minlength="8" required />
          </div>
          <button type="submit" class="btn btn-primary btn-sm" style="height:36px;">Adicionar</button>
        </form>
      </div>

      <div class="section-card" style="margin-bottom:0;">
        <h3>Usuários</h3>
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
        showToast("Senha alterada!");
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
        showToast("Usuário cadastrado!");
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

    // Cores personalizadas
    $("inpPrimaryColor").addEventListener("input", (e) => {
      if (isMeetingLocked()) return;
      const hex = normalizeHex(e.target.value, "#0a7e3a");
      state.primaryColor = hex;
      $("inpPrimaryColorHex").value = hex;
      renderColorPalettes();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("inpPrimaryColorHex").addEventListener("change", (e) => {
      if (isMeetingLocked()) return;
      const hex = normalizeHex(e.target.value, state.primaryColor || "#0a7e3a");
      state.primaryColor = hex;
      $("inpPrimaryColor").value = hex;
      $("inpPrimaryColorHex").value = hex;
      renderColorPalettes();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("inpSecondaryColor").addEventListener("input", (e) => {
      if (isMeetingLocked()) return;
      const hex = normalizeHex(e.target.value, "#b4c85a");
      state.secondaryColor = hex;
      $("inpSecondaryColorHex").value = hex;
      renderColorPalettes();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("inpSecondaryColorHex").addEventListener("change", (e) => {
      if (isMeetingLocked()) return;
      const hex = normalizeHex(e.target.value, state.secondaryColor || "#b4c85a");
      state.secondaryColor = hex;
      $("inpSecondaryColor").value = hex;
      $("inpSecondaryColorHex").value = hex;
      renderColorPalettes();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("btnAddPaletteColor").addEventListener("click", () => {
      const pHex = normalizeHex(state.primaryColor, "#0a7e3a");
      const sHex = normalizeHex(state.secondaryColor, "#b4c85a");
      const name = (window.prompt("Nome desta combinação de cores:", "Minha Cor") || "").trim();
      if (!name) return;
      const custom = loadCustomPalettes();
      custom.push({ name: name.slice(0, 24), primary: pHex, secondary: sHex });
      saveCustomPalettes(custom);
      renderColorPalettes();
      showToast("Cor adicionada à paleta!");
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

  function readImageFileAsDataUrl(file, callback) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      showToast("Imagem deve ter no máximo 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => callback(reader.result);
    reader.readAsDataURL(file);
  }

  function initButtons() {
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
        $("loginError").textContent = err.message || "Falha no login.";
        $("loginError").classList.remove("hidden");
      }
    });

    $("btnLogout").addEventListener("click", async () => {
      await window.LocarApi.post("/api/auth/logout", {}).catch(() => {});
      showLoginScreen();
    });

    window.addEventListener("locar:unauthorized", () => {
      showLoginScreen("Sessão expirada. Entre novamente.");
    });

    $("topbarHomeBtn").addEventListener("click", () => switchView("dashboard"));

    document.querySelectorAll(".nav-pill").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("globalCitySelect").addEventListener("change", (e) => handleGlobalCityChange(e.target.value));

    // Visão 1: Cidades
    $("dashSearchInput").addEventListener("input", renderDashboardView);
    $("dashStatusFilter").addEventListener("change", renderDashboardView);
    $("btnDashNewCity").addEventListener("click", () => openCityModal(null));

    // Visão 2: Histórico / Reuniões
    $("btnNewMeetingFromHistory").addEventListener("click", openNewMeetingModal);
    $("historyActionFilter").addEventListener("change", renderCityActionTrackerTable);

    // Visão 3: Editor
    $("btnBackToHistory").addEventListener("click", () => switchView("city-history"));
    $("selCityMeeting").addEventListener("change", async (e) => {
      if (!e.target.value) return;
      if (dirtyFlag && activeMeetingId && !isMeetingLocked()) {
        await saveActiveMeeting({ silent: true });
      }
      await loadMeetingIntoEditor(e.target.value);
    });

    $("btnNewMeeting").addEventListener("click", openNewMeetingModal);
    $("btnNextMeetingFromBar").addEventListener("click", openNewMeetingModal);
    $("btnNextMeetingFromLocked").addEventListener("click", openNewMeetingModal);

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
        const importedCount = res.meeting?.snapshot?.actions?.length || 0;
        showToast(
          importedCount > 0
            ? `Nova reunião criada com ${importedCount} pendência(s) da anterior.`
            : "Nova reunião criada!"
        );
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
        showToast(`${res.imported_count} pendência(s) importada(s)!`);
      } catch (err) {
        showToast("Erro ao puxar pendências: " + err.message);
      }
    });

    $("btnPrintPdf").addEventListener("click", () => window.print());
    $("btnExportWord").addEventListener("click", exportToWord);
    $("btnSaveMeeting").addEventListener("click", () => saveActiveMeeting({ silent: false }));
    $("btnGeneratePublicLink").addEventListener("click", sendPublicLinkFromCurrentState);
    $("btnViewSentLink").addEventListener("click", openPublicLinkModal);

    $("btnDownloadConfirmedPdf").addEventListener("click", () => {
      const cur = activeVersions.find((v) => v.is_current) || activeVersions[0];
      if (!cur) return;
      window.open(`/api/meetings/${activeMeetingId}/versions/${cur.id}/pdf?download=1`, "_blank");
    });

    $("btnAnalyzeTranscript").addEventListener("click", () => processTranscriptText());

    $("btnAddAction").addEventListener("click", () => {
      if (isMeetingLocked() || !activeMeetingId) return;
      const defaultDeadline = state.actions?.[0]?.deadline || "Próx. Reunião";
      state.actions.push({
        action: "",
        owner: "",
        deadline: defaultDeadline,
        status: ""
      });
      renderActionsEditor();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    $("btnClearStatuses").addEventListener("click", () => {
      if (isMeetingLocked() || !activeMeetingId) return;
      state.actions.forEach((a) => (a.status = ""));
      renderActionsEditor();
      renderSheet();
      markDirtyAndScheduleSave();
      showToast("Status da folha limpo.");
    });

    $("btnAddTopic").addEventListener("click", () => {
      if (isMeetingLocked() || !activeMeetingId) return;
      state.topics = state.topics || [];
      state.topics.push({ area: "Tema", text: "" });
      state.showTopics = true;
      $("chkShowTopics").checked = true;
      renderTopicsEditor();
      renderSheet();
      markDirtyAndScheduleSave();
    });

    // Logo do Relatório (aba 4 e clique direto na folha A4)
    $("btnChangeReportLogo").addEventListener("click", () => {
      if (!isMeetingLocked() && activeMeetingId) $("inpReportLogoFile").click();
    });
    $("sheetLogoImg").addEventListener("click", () => {
      if (!isMeetingLocked() && activeMeetingId) $("inpReportLogoFile").click();
    });
    $("inpReportLogoFile").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      readImageFileAsDataUrl(file, async (dataUrl) => {
        state.reportLogoDataUrl = dataUrl;
        renderLogoPreviews();
        renderSheet();
        await saveActiveMeeting({ silent: true });
        showToast("Logo do relatório alterada!");
      });
      e.target.value = "";
    });
    $("btnResetReportLogo").addEventListener("click", async () => {
      if (isMeetingLocked() || !activeMeetingId) return;
      state.reportLogoDataUrl = "";
      renderLogoPreviews();
      renderSheet();
      await saveActiveMeeting({ silent: true });
      showToast("Logo padrão restaurada.");
    });

    // Logo da Cidade (aba 4)
    $("btnChangeEditorCityLogo").addEventListener("click", () => {
      if (!isMeetingLocked() && activeMeetingId) $("inpEditorCityLogoFile").click();
    });
    $("inpEditorCityLogoFile").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      readImageFileAsDataUrl(file, async (dataUrl) => {
        state.cityLogoDataUrl = dataUrl;
        if (activeCityObj) activeCityObj.logo_data_url = dataUrl;
        renderLogoPreviews();
        renderSheet();
        await saveActiveMeeting({ silent: true });
        showToast("Logo da cidade alterada!");
      });
      e.target.value = "";
    });
    $("btnRemoveEditorCityLogo").addEventListener("click", async () => {
      if (isMeetingLocked() || !activeMeetingId) return;
      state.cityLogoDataUrl = "";
      if (activeCityObj) activeCityObj.logo_data_url = "";
      renderLogoPreviews();
      renderSheet();
      await saveActiveMeeting({ silent: true });
      showToast("Logo da cidade removida.");
    });

    // Zoom
    $("btnZoomOut").addEventListener("click", () => applyZoom(currentZoom - 0.1));
    $("btnZoomIn").addEventListener("click", () => applyZoom(currentZoom + 0.1));
    $("btnZoomFit").addEventListener("click", () => {
      const areaWidth = $("previewScroll").clientWidth - 48;
      applyZoom(Math.min(1, areaWidth / 794));
    });

    // Modal Cidade
    $("cityLogoInput").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      readImageFileAsDataUrl(file, (dataUrl) => {
        pendingCityLogoDataUrl = dataUrl;
        updateCityLogoPreview(dataUrl);
      });
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
          showToast("Cidade atualizada!");
        } else {
          const created = await window.LocarApi.post("/api/cities", payload);
          selectedCityId = created.city.id;
          showToast("Cidade cadastrada!");
        }
        $("modalCityForm").classList.add("hidden");
        await refreshCitiesAndDashboard();
      } catch (err) {
        showToast("Erro ao salvar cidade: " + err.message);
      }
    });

    $("btnOpenAdminModal").addEventListener("click", openAdminUsersModal);

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

    initTabs();
    bindDirectInputs();
    initButtons();

    setupDropzone("dropAttendance", "fileAttendance", handleAttendanceUpload);
    setupDropzone("dropTranscript", "fileTranscript", handleTranscriptUpload);

    try {
      const auth = await window.LocarApi.get("/api/auth/me", { skipAuthEvent: true });
      if (auth && auth.authenticated && auth.user) {
        await enterAuthenticatedApp(auth.user);
        return;
      }
    } catch {
      // Não autenticado
    }
    showLoginScreen();
  });
})();
