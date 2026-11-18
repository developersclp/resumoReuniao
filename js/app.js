// Controlador principal da aplicação LOCAR — Gerador de Atas e Planos de Ação
(function () {
  const STORAGE_KEY = "locar_ata_estado_v1";

  let state = clonePreset("caruaru_out_2026");
  let currentZoom = 0.88;
  let lastTranscriptText = "";

  const $ = (id) => document.getElementById(id);

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
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function saveStateLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      // Silencioso caso storage esteja bloqueado
    }
  }

  function loadStateLocal() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.title !== undefined && Array.isArray(parsed.actions)) {
          state = parsed;
          return true;
        }
      }
    } catch (_) {
      // Ignora erro de parse
    }
    return false;
  }

  // -------------------- Renderização da Folha A4 --------------------
  function renderSheet() {
    const sheet = $("a4Sheet");
    const isDieTheme = state.headerTheme !== "locar";
    sheet.classList.toggle("theme-locar", !isDieTheme);

    // Logo adequada ao tema (clara sobre fundo verde musgo DIE, ou colorida oficial sobre fundo claro)
    const logoImg = $("sheetLogoImg");
    if (window.LOCAR_LOGOS) {
      logoImg.src = isDieTheme ? window.LOCAR_LOGOS.white : window.LOCAR_LOGOS.color;
    } else {
      logoImg.src = isDieTheme ? "assets/logo-locar-white.png" : "assets/logo-locar.png";
    }

    // Densidade automática ou manual
    const totalRows = (state.actions?.length || 0) + (state.extraBlankRows || 0);
    const shouldCompact =
      state.densityMode === "compact" ||
      (state.densityMode === "auto" &&
        (totalRows >= 8 || (state.showTopics && (state.topics?.length || 0) > 0 && totalRows >= 6)));
    sheet.classList.toggle("density-compact", shouldCompact);

    // Preenchimento dos textos (evita sobrescrever elemento com foco ativo)
    setEditableText($("sheetUnitName"), state.unitName || "Unidade");
    setEditableText($("sheetLocal"), state.local || "Microsoft Teams");
    setEditableText($("sheetDate"), state.dateText || "");
    setEditableText($("sheetTime"), state.timeText || "");
    setEditableText($("sheetParticipants"), state.participants || "");
    setEditableText($("sheetTitle"), state.title || "Ata de Reunião de Indicadores");
    setEditableText($("sheetSummary"), state.summary || "");
    setEditableText($("sheetFooter"), state.footerText || "DIE – Departamento de Inteligência Estratégica");

    // Principais Tópicos na Folha
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

    // KPIs na Folha (opcional)
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

    // Tabela de Ações (4 colunas: Itens de ação, Proprietários, Prazo, Status)
    const tbody = $("sheetActionBody");
    tbody.innerHTML = "";

    (state.actions || []).forEach((item, idx) => {
      const tr = document.createElement("tr");

      const tdAction = createEditableCell(item.action, (val) => {
        state.actions[idx].action = val;
        syncActionInput(idx, "action", val);
        saveStateLocal();
      });

      const tdOwner = createEditableCell(item.owner, (val) => {
        state.actions[idx].owner = val;
        syncActionInput(idx, "owner", val);
        saveStateLocal();
      });

      const tdDeadline = createEditableCell(item.deadline, (val) => {
        state.actions[idx].deadline = val;
        syncActionInput(idx, "deadline", val);
        saveStateLocal();
      });

      // Status vem vazio para preenchimento no papel, mas permite edição se usuário clicar
      const tdStatus = createEditableCell(item.status || "", (val) => {
        state.actions[idx].status = val;
        saveStateLocal();
      });

      tr.appendChild(tdAction);
      tr.appendChild(tdOwner);
      tr.appendChild(tdDeadline);
      tr.appendChild(tdStatus);
      tbody.appendChild(tr);
    });

    // Linhas extras em branco para anotações manuais durante a reunião (igual à foto!)
    const extraCount = Math.max(0, Math.min(6, parseInt(state.extraBlankRows || 0, 10)));
    for (let b = 0; b < extraCount; b++) {
      const trBlank = document.createElement("tr");
      trBlank.className = "blank-paper-row";
      trBlank.innerHTML = "<td></td><td></td><td></td><td></td>";
      tbody.appendChild(trBlank);
    }
  }

  function createEditableCell(value, onCommit) {
    const td = document.createElement("td");
    td.contentEditable = "true";
    td.textContent = value || "";
    td.addEventListener("input", () => {
      onCommit(td.innerText.replace(/\r/g, ""));
    });
    return td;
  }

  function setEditableText(el, val) {
    if (document.activeElement !== el) {
      el.textContent = val;
    }
  }

  // -------------------- Sincronização com Editor Lateral --------------------
  function renderEditorInputs() {
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
        <button type="button" class="icon-btn del" title="Remover indicador" style="position:absolute;top:5px;right:5px;width:20px;height:20px;font-size:10px;">✕</button>
      `;
      chip.querySelector("button").addEventListener("click", () => {
        state.indicators.splice(idx, 1);
        renderKpiEditor();
        renderSheet();
        saveStateLocal();
      });
      container.appendChild(chip);
    });
  }

  function renderTopicsEditor() {
    const container = $("topicsEditorList");
    container.innerHTML = "";
    (state.topics || []).forEach((t, idx) => {
      const card = document.createElement("div");
      card.className = "action-editor-card";
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-badge">Tópico ${idx + 1}</span>
          <button type="button" class="icon-btn del" title="Excluir tópico">✕</button>
        </div>
        <div class="field">
          <label>Área / Tema</label>
          <input type="text" class="topic-area-inp" value="${escapeAttr(t.area)}" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Destaques</label>
          <textarea rows="2" class="topic-text-inp">${escapeHtml(t.text)}</textarea>
        </div>
      `;
      card.querySelector(".del").addEventListener("click", () => {
        state.topics.splice(idx, 1);
        renderTopicsEditor();
        renderSheet();
        saveStateLocal();
      });
      card.querySelector(".topic-area-inp").addEventListener("input", (e) => {
        state.topics[idx].area = e.target.value;
        renderSheet();
        saveStateLocal();
      });
      card.querySelector(".topic-text-inp").addEventListener("input", (e) => {
        state.topics[idx].text = e.target.value;
        renderSheet();
        saveStateLocal();
      });
      container.appendChild(card);
    });
  }

  function renderActionsEditor() {
    const container = $("actionsEditorList");
    container.innerHTML = "";
    $("actionCountBadge").textContent = `${(state.actions || []).length} itens`;

    (state.actions || []).forEach((item, idx) => {
      const card = document.createElement("div");
      card.className = "action-editor-card";
      card.dataset.idx = idx;
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-badge">Ação #${idx + 1}</span>
          <div class="action-card-controls">
            <button type="button" class="icon-btn up" title="Mover para cima">↑</button>
            <button type="button" class="icon-btn down" title="Mover para baixo">↓</button>
            <button type="button" class="icon-btn del" title="Remover ação">✕</button>
          </div>
        </div>
        <div class="field">
          <label>Item de ação</label>
          <textarea rows="2" class="act-action">${escapeHtml(item.action)}</textarea>
        </div>
        <div class="field-row">
          <div class="field" style="margin-bottom:0;">
            <label>Proprietários</label>
            <input type="text" class="act-owner" value="${escapeAttr(item.owner)}" />
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Prazo</label>
            <input type="text" class="act-deadline" value="${escapeAttr(item.deadline)}" />
          </div>
        </div>
      `;

      card.querySelector(".up").addEventListener("click", () => {
        if (idx === 0) return;
        [state.actions[idx - 1], state.actions[idx]] = [state.actions[idx], state.actions[idx - 1]];
        renderActionsEditor();
        renderSheet();
        saveStateLocal();
      });

      card.querySelector(".down").addEventListener("click", () => {
        if (idx >= state.actions.length - 1) return;
        [state.actions[idx + 1], state.actions[idx]] = [state.actions[idx], state.actions[idx + 1]];
        renderActionsEditor();
        renderSheet();
        saveStateLocal();
      });

      card.querySelector(".del").addEventListener("click", () => {
        state.actions.splice(idx, 1);
        renderActionsEditor();
        renderSheet();
        saveStateLocal();
      });

      card.querySelector(".act-action").addEventListener("input", (e) => {
        state.actions[idx].action = e.target.value;
        renderSheet();
        saveStateLocal();
      });

      card.querySelector(".act-owner").addEventListener("input", (e) => {
        state.actions[idx].owner = e.target.value;
        renderSheet();
        saveStateLocal();
      });

      card.querySelector(".act-deadline").addEventListener("input", (e) => {
        state.actions[idx].deadline = e.target.value;
        renderSheet();
        saveStateLocal();
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

  // -------------------- Eventos de Upload e Processamento --------------------
  function setupDropzone(zoneId, inputId, handler) {
    const zone = $(zoneId);
    const input = $(inputId);
    zone.addEventListener("click", () => input.click());
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
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handler(e.dataTransfer.files[0]);
      }
    });
  }

  async function handleAttendanceUpload(file) {
    try {
      const buf = await file.arrayBuffer();
      const text = window.LocarParser.decodeFileBuffer(buf);
      const parsed = window.LocarParser.parseAttendanceCSV(text);

      if (parsed.unitName) state.unitName = parsed.unitName;
      if (parsed.dateText) state.dateText = parsed.dateText;
      if (parsed.timeText) state.timeText = parsed.timeText;
      if (parsed.participantsText) state.participants = parsed.participantsText;
      if (parsed.refMonthYear) {
        state.title = `Ata de Reunião de Indicadores ${parsed.refMonthYear}`;
      }

      // Atualiza prazos vazios ou padrão nas ações se houver próximo mês calculado
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
      saveStateLocal();
      showToast(`Presença importada: ${parsed.participantsList.length} participantes!`);
    } catch (err) {
      showToast("Erro ao ler relatório de presença: " + err.message);
    }
  }

  async function handleTranscriptUpload(file) {
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
      $("inpTranscriptPaste").value = text.slice(0, 20000) + (text.length > 20000 ? "\n\n[...texto completo carregado em memória para análise...]" : "");

      const statusEl = $("transcriptStatus");
      statusEl.textContent = `✓ ${file.name} carregado (${Math.round(text.length / 1024)} KB).`;
      statusEl.classList.add("visible");

      await processTranscriptText(text);
    } catch (err) {
      showToast("Erro ao ler transcrição: " + err.message);
    }
  }

  async function handleIndicatorsUpload(file) {
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
      saveStateLocal();
      showToast(`${kpis.length} indicadores carregados no relatório!`);
    } catch (err) {
      showToast("Erro ao ler arquivo de indicadores: " + err.message);
    }
  }

  async function processTranscriptText(textOverride) {
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
          state.title = `Ata de Reunião de Indicadores ${result.refMonthYear}`;
        }
      } else {
        result = window.LocarParser.analyzeTranscript(raw, {
          unitName: state.unitName,
          dateText: state.dateText,
          timeText: state.timeText
        });
        if (result.title) state.title = result.title;
      }

      if (result.unitName) state.unitName = result.unitName;
      if (result.dateText && !state.dateText) state.dateText = result.dateText;
      if (result.timeText && !state.timeText) state.timeText = result.timeText;
      if (result.participantsText && !state.participants) state.participants = result.participantsText;
      if (result.summary) state.summary = result.summary;
      if (Array.isArray(result.topics) && result.topics.length > 0) state.topics = result.topics;
      if (Array.isArray(result.indicators) && result.indicators.length > 0) state.indicators = result.indicators;
      if (Array.isArray(result.actions) && result.actions.length > 0) {
        // Garante Status sempre vazio para preenchimento manual no papel
        state.actions = result.actions.map((a) => ({ ...a, status: "" }));
      }

      renderEditorInputs();
      renderSheet();
      saveStateLocal();
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
    const logoSrc =
      window.LOCAR_LOGOS?.color || "assets/logo-locar.png";
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
      <td width="40%" valign="top"><img src="${logoSrc}" width="170" alt="LOCAR Gestão de Resíduos" /></td>
      <td width="60%" valign="top" style="font-size:9.5pt; line-height:1.4;">
        <div><b>Local:</b> ${escapeHtml(state.local)}</div>
        <div><b>Data:</b> ${escapeHtml(state.dateText)}</div>
        <div><b>Hora:</b> ${escapeHtml(state.timeText)}</div>
        <div><b>Participação:</b> ${escapeHtml(state.participants)}</div>
      </td>
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

  // -------------------- Zoom & Navegação --------------------
  function applyZoom(zoomVal) {
    currentZoom = Math.max(0.55, Math.min(1.25, zoomVal));
    $("sheetWrapper").style.transform = `scale(${currentZoom})`;
    $("zoomLabel").textContent = `${Math.round(currentZoom * 100)}%`;
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
        state[key] = e.target.value;
        renderSheet();
        saveStateLocal();
      });
    });

    // Edição direta na folha A4 sincroniza de volta para os inputs
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
        const txt = e.target.innerText.replace(/\r/g, "");
        state[key] = txt;
        if ($(inpId) && document.activeElement !== $(inpId)) {
          $(inpId).value = txt;
        }
        saveStateLocal();
      });
    });

    $("chkShowTopics").addEventListener("change", (e) => {
      state.showTopics = e.target.checked;
      renderSheet();
      saveStateLocal();
    });

    $("chkShowKpis").addEventListener("change", (e) => {
      state.showKpisOnSheet = e.target.checked;
      renderSheet();
      saveStateLocal();
    });

    $("selHeaderTheme").addEventListener("change", (e) => {
      state.headerTheme = e.target.value;
      renderSheet();
      saveStateLocal();
    });

    $("selDensity").addEventListener("change", (e) => {
      state.densityMode = e.target.value;
      renderSheet();
      saveStateLocal();
    });

    $("inpBlankRows").addEventListener("input", (e) => {
      state.extraBlankRows = parseInt(e.target.value || "0", 10);
      renderSheet();
      saveStateLocal();
    });
  }

  function initButtons() {
    $("selPreset").addEventListener("change", (e) => {
      const val = e.target.value;
      if (!val) return;
      state = clonePreset(val);
      renderEditorInputs();
      renderSheet();
      saveStateLocal();
      showToast(`Modelo carregado: ${state.label}`);
    });

    $("btnPrintPdf").addEventListener("click", () => {
      window.print();
    });

    $("btnExportWord").addEventListener("click", exportToWord);
    $("btnExportJson").addEventListener("click", exportJSON);

    $("btnImportJson").addEventListener("click", () => $("inpImportJson").click());
    $("inpImportJson").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        state = parsed;
        renderEditorInputs();
        renderSheet();
        saveStateLocal();
        showToast("Ata importada com sucesso!");
      } catch {
        showToast("Arquivo JSON inválido.");
      }
      e.target.value = "";
    });

    $("btnAnalyzeTranscript").addEventListener("click", () => processTranscriptText());

    $("btnAddAction").addEventListener("click", () => {
      const nextMonth = state.actions?.[0]?.deadline || "Próx. Reunião Dezembro/2026";
      state.actions.push({
        action: "",
        owner: "",
        deadline: nextMonth,
        status: ""
      });
      renderActionsEditor();
      renderSheet();
      saveStateLocal();
    });

    $("btnClearStatuses").addEventListener("click", () => {
      state.actions.forEach((a) => (a.status = ""));
      renderSheet();
      saveStateLocal();
      showToast("Coluna Status esvaziada para preenchimento no papel.");
    });

    $("btnAddTopic").addEventListener("click", () => {
      state.topics = state.topics || [];
      state.topics.push({ area: "Novo Tópico", text: "" });
      state.showTopics = true;
      $("chkShowTopics").checked = true;
      renderTopicsEditor();
      renderSheet();
      saveStateLocal();
    });

    $("btnAddKpi").addEventListener("click", () => {
      const label = prompt("Nome do indicador (ex: Quadro, Horas Extras, CPK):");
      if (!label) return;
      const value = prompt("Valor / Destaque (ex: 648 colab., R$ 406,8 mil):");
      if (!value) return;
      state.indicators = state.indicators || [];
      state.indicators.push({ label, value, status: "ok" });
      renderKpiEditor();
      renderSheet();
      saveStateLocal();
    });

    $("btnZoomOut").addEventListener("click", () => applyZoom(currentZoom - 0.1));
    $("btnZoomIn").addEventListener("click", () => applyZoom(currentZoom + 0.1));
    $("btnZoomFit").addEventListener("click", () => {
      const areaWidth = $("previewScroll").clientWidth - 48;
      const sheetPx = 794; // ~210mm em 96dpi
      applyZoom(Math.min(1, areaWidth / sheetPx));
    });
  }

  // -------------------- Inicialização --------------------
  document.addEventListener("DOMContentLoaded", () => {
    if (window.LOCAR_LOGOS?.color && $("topbarLogo")) {
      $("topbarLogo").src = window.LOCAR_LOGOS.color;
    }

    // Popula seletor de modelos
    const sel = $("selPreset");
    Object.values(window.LOCAR_PRESETS).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      sel.appendChild(opt);
    });

    loadStateLocal();
    sel.value = state.id || "caruaru_out_2026";

    initTabs();
    bindDirectInputs();
    initButtons();

    setupDropzone("dropAttendance", "fileAttendance", handleAttendanceUpload);
    setupDropzone("dropTranscript", "fileTranscript", handleTranscriptUpload);
    setupDropzone("dropIndicators", "fileIndicators", handleIndicatorsUpload);

    renderEditorInputs();
    renderSheet();

    // Ajusta zoom inicial de acordo com largura disponível
    const areaWidth = $("previewScroll").clientWidth - 48;
    if (areaWidth > 0 && areaWidth < 794) {
      applyZoom(areaWidth / 794);
    } else {
      applyZoom(0.88);
    }
  });
})();
