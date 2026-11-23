// Script da página pública: visualização da ata em PDF, atualização do Plano de Ação e registro de ciência
(function () {
  const $ = (id) => document.getElementById(id);

  let token = "";
  let currentPdfUrl = "";
  let currentDownloadUrl = "";
  let pdfDoc = null;
  let pdfScale = 1.15;
  let publicActions = [];
  let saveBadgeTimer = null;

  function extractTokenFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const ataIdx = parts.indexOf("ata");
    if (ataIdx >= 0 && parts[ataIdx + 1]) {
      return decodeURIComponent(parts[ataIdx + 1]);
    }
    return parts[parts.length - 1] || "";
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return "—";
    try {
      return new Date(isoStr).toLocaleString("pt-BR");
    } catch {
      return isoStr;
    }
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

  function showSaveBadge(text = "Salvo ✓", isError = false) {
    const badge = $("pubActionSaveBadge");
    if (!badge) return;
    badge.textContent = text;
    badge.classList.remove("hidden", "error");
    if (isError) badge.classList.add("error");
    clearTimeout(saveBadgeTimer);
    saveBadgeTimer = setTimeout(() => badge.classList.add("hidden"), 2500);
  }

  function updateActionsProgress() {
    const total = publicActions.length;
    const done = publicActions.filter((a) => Boolean(a.checked_completed)).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const textEl = $("pubActionsProgressText");
    const fillEl = $("pubActionsProgressFill");
    if (textEl) textEl.textContent = `${done} de ${total} concluídas`;
    if (fillEl) fillEl.style.width = `${pct}%`;
  }

  async function savePublicAction(actionObj, payload) {
    const repNameInput = $("repFullName");
    const updatedBy = repNameInput && repNameInput.value.trim() ? repNameInput.value.trim() : "";
    try {
      const res = await fetch(
        `/api/public/atas/${encodeURIComponent(token)}/actions/${encodeURIComponent(actionObj.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            ...(updatedBy ? { updated_by: updatedBy } : {})
          })
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Erro ao salvar status.");
      }
      if (data.action) {
        Object.assign(actionObj, data.action);
      }
      updateActionsProgress();
      showSaveBadge("Salvo ✓");
    } catch (err) {
      showSaveBadge(err.message || "Erro ao salvar", true);
    }
  }

  function renderPublicActions() {
    const container = $("pubActionsList");
    if (!container) return;
    container.innerHTML = "";
    updateActionsProgress();

    if (!publicActions || publicActions.length === 0) {
      container.innerHTML = `<p class="muted-text" style="margin:0;">Nenhum item no plano de ação desta reunião.</p>`;
      return;
    }

    publicActions.forEach((act) => {
      const card = document.createElement("div");
      card.className = `pub-action-row ${act.checked_completed ? "done" : ""}`;
      card.innerHTML = `
        <div class="pub-action-check">
          <input type="checkbox" class="js-pub-chk" ${act.checked_completed ? "checked" : ""} aria-label="Marcar ação como concluída" />
        </div>
        <div class="pub-action-main">
          <div class="pub-action-title">${escapeHtml(act.action || "Item sem descrição")}</div>
          <div class="pub-action-meta">
            <span><strong>Responsável:</strong> ${escapeHtml(act.owner || "—")}</span>
            <span><strong>Prazo:</strong> ${escapeHtml(act.deadline || "—")}</span>
          </div>
        </div>
        <div class="pub-action-controls">
          <select class="js-pub-status" aria-label="Status da ação">
            <option value="pendente" ${act.tracking_status === "pendente" ? "selected" : ""}>Pendente</option>
            <option value="em_andamento" ${act.tracking_status === "em_andamento" ? "selected" : ""}>Em andamento</option>
            <option value="concluida" ${act.tracking_status === "concluida" ? "selected" : ""}>Concluída</option>
            <option value="nao_realizada" ${act.tracking_status === "nao_realizada" ? "selected" : ""}>Não realizada</option>
          </select>
          <input type="text" class="js-pub-notes" value="${escapeAttr(act.follow_up_notes || "")}" placeholder="Observação / evidência..." />
        </div>
      `;

      const chk = card.querySelector(".js-pub-chk");
      const sel = card.querySelector(".js-pub-status");
      const notes = card.querySelector(".js-pub-notes");

      const commitChange = async () => {
        act.checked_completed = chk.checked;
        act.tracking_status = sel.value;
        act.follow_up_notes = notes.value;
        card.classList.toggle("done", act.checked_completed);
        await savePublicAction(act, {
          checked_completed: act.checked_completed,
          tracking_status: act.tracking_status,
          follow_up_notes: act.follow_up_notes
        });
      };

      chk.addEventListener("change", async () => {
        sel.value = chk.checked ? "concluida" : "pendente";
        await commitChange();
      });

      sel.addEventListener("change", async () => {
        chk.checked = sel.value === "concluida";
        await commitChange();
      });

      notes.addEventListener("change", commitChange);

      container.appendChild(card);
    });
  }

  async function renderPdfWithPdfJs(pdfUrl) {
    const container = $("pdfCanvasContainer");
    const fallbackFrame = $("pdfFallbackFrame");
    try {
      const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.min.mjs");
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.min.mjs";

      const loadingTask = pdfjsLib.getDocument({ url: pdfUrl, withCredentials: false });
      pdfDoc = await loadingTask.promise;
      await drawPdfPages();
      fallbackFrame.classList.add("hidden");
      container.classList.remove("hidden");
    } catch (_) {
      pdfDoc = null;
      container.classList.add("hidden");
      fallbackFrame.src = `${pdfUrl}#view=FitH`;
      fallbackFrame.classList.remove("hidden");
      $("pdfPageInfo").textContent = "Visualização nativa";
    }
  }

  async function drawPdfPages() {
    if (!pdfDoc) return;
    const container = $("pdfCanvasContainer");
    container.innerHTML = "";
    const areaWidth = Math.max(280, $("pdfViewerArea").clientWidth - 40);

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = Math.min(1.8, areaWidth / baseViewport.width);
      const effectiveScale = fitScale * pdfScale;
      const viewport = page.getViewport({ scale: effectiveScale });

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas-page";
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;
      container.appendChild(canvas);
    }

    $("pdfPageInfo").textContent = `${pdfDoc.numPages} página(s)`;
    $("pdfZoomLabel").textContent = `${Math.round(pdfScale * 100)}%`;
  }

  function showUnavailable(title, message, payload = null) {
    $("stateLoading").classList.add("hidden");
    $("stateReady").classList.add("hidden");
    $("stateUnavailable").classList.remove("hidden");
    $("unavailTitle").textContent = title;
    $("unavailMessage").textContent = message;

    const metaEl = $("unavailMeta");
    if (payload && payload.city) {
      metaEl.classList.remove("hidden");
      metaEl.innerHTML = `
        <div><strong>Cidade / Projeto:</strong> ${escapeHtml(payload.city.name)} — ${escapeHtml(payload.city.project_name)}</div>
        <div><strong>Reunião:</strong> ${escapeHtml(payload.meeting?.title || "—")} (${escapeHtml(payload.meeting?.reference_label || "—")})</div>
      `;
    } else {
      metaEl.classList.add("hidden");
    }
  }

  function renderReceipt(consent) {
    $("consentFormWrap").classList.add("hidden");
    $("consentReceiptWrap").classList.remove("hidden");

    $("recProtocol").textContent = consent.protocol_code || "—";
    $("recCityProject").textContent = `${consent.city_name || ""} — ${consent.project_name || ""}`;
    $("recMeeting").textContent = `${consent.meeting_title || ""} (${consent.reference_label || ""})`;
    $("recName").textContent = consent.representative_name || "—";
    $("recEmail").textContent = consent.representative_email || "—";
    $("recAcceptedAt").textContent = formatDateTime(consent.accepted_at);
    $("btnReceiptDownloadPdf").href = currentDownloadUrl;
  }

  async function loadPublicAta() {
    token = extractTokenFromPath();
    if (!token) {
      showUnavailable("Link inválido", "O identificador público da ata não foi informado na URL.");
      return;
    }

    try {
      const res = await fetch(`/api/public/atas/${encodeURIComponent(token)}`, {
        cache: "no-store"
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 404) {
        showUnavailable("Link não encontrado", data.message || "Este link público não existe ou está incorreto.");
        return;
      }

      if (res.status === 410 || data.state === "revoked" || data.state === "expired") {
        const title = data.state === "revoked" ? "Link invalidado" : "Link expirado";
        showUnavailable(title, data.message || "Este link não está mais disponível.", data);
        return;
      }

      if (!res.ok) {
        showUnavailable("Erro ao carregar ata", data.error || "Não foi possível carregar os dados da ata.");
        return;
      }

      $("stateLoading").classList.add("hidden");
      $("stateUnavailable").classList.add("hidden");
      $("stateReady").classList.remove("hidden");

      const city = data.city || {};
      const meeting = data.meeting || {};

      if (city.logo_data_url) {
        $("pubCityLogoImg").src = city.logo_data_url;
        $("pubCityLogoWrap").classList.remove("hidden");
      } else {
        $("pubCityLogoWrap").classList.add("hidden");
      }

      $("pubMeetingTitle").textContent = meeting.title || "Ata de Reunião";
      $("pubCityProject").textContent = `${city.name || ""}${city.project_name ? " — " + city.project_name : ""}`;
      $("pubMeetingDate").textContent = meeting.date_text || "—";
      $("pubReferenceLabel").textContent = meeting.reference_label || "—";
      $("pubMeetingLocal").textContent = meeting.local || "Microsoft Teams";

      publicActions = Array.isArray(data.actions) ? data.actions : [];
      renderPublicActions();

      currentPdfUrl = data.pdf_url;
      currentDownloadUrl = data.pdf_download_url;
      $("btnOpenPdfTab").href = currentPdfUrl;
      $("btnDownloadPdf").href = currentDownloadUrl;

      await renderPdfWithPdfJs(currentPdfUrl);

      if (data.state === "confirmed" && data.consent) {
        renderReceipt(data.consent);
      } else {
        $("consentFormWrap").classList.remove("hidden");
        $("consentReceiptWrap").classList.add("hidden");
        $("declarationText").textContent = data.declaration_text || "";
      }
    } catch (err) {
      showUnavailable("Falha de conexão", "Não foi possível comunicar com o servidor da LOCAR.");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("btnPdfZoomOut").addEventListener("click", () => {
      pdfScale = Math.max(0.7, pdfScale - 0.15);
      drawPdfPages();
    });

    $("btnPdfZoomIn").addEventListener("click", () => {
      pdfScale = Math.min(2.0, pdfScale + 0.15);
      drawPdfPages();
    });

    $("btnPrintReceipt").addEventListener("click", () => window.print());

    $("consentForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("consentError");
      errBox.classList.add("hidden");

      const btn = $("btnConfirmConsent");
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Confirmando...";

      try {
        const res = await fetch(`/api/public/atas/${encodeURIComponent(token)}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            representative_name: $("repFullName").value.trim(),
            representative_email: $("repEmail").value.trim(),
            representative_role: $("repRole").value.trim(),
            accepted_terms: $("chkAcceptTerms").checked,
            client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
            screen_resolution: `${window.screen.width}x${window.screen.height}`
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Não foi possível registrar o consentimento.");
        }
        renderReceipt(data.consent);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });

    loadPublicAta();
  });
})();
