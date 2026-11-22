// Script da página pública de visualização da ata em PDF e registro de consentimento
(function () {
  const $ = (id) => document.getElementById(id);

  let token = "";
  let currentPdfUrl = "";
  let currentDownloadUrl = "";
  let pdfDoc = null;
  let pdfScale = 1.15;

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
      // Fallback imediato para iframe nativo caso rede/CDN não esteja disponível
      pdfDoc = null;
      container.classList.add("hidden");
      fallbackFrame.src = `${pdfUrl}#view=FitH`;
      fallbackFrame.classList.remove("hidden");
      $("pdfPageInfo").textContent = "Visualização nativa do navegador";
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

    $("pdfPageInfo").textContent = `${pdfDoc.numPages} página(s) • Documento integral carregado`;
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

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderReceipt(consent, legalNotice) {
    $("consentFormWrap").classList.add("hidden");
    $("consentReceiptWrap").classList.remove("hidden");

    $("recProtocol").textContent = consent.protocol_code || "—";
    $("recCityProject").textContent = `${consent.city_name || ""} — ${consent.project_name || ""}`;
    $("recMeeting").textContent = `${consent.meeting_title || ""} (${consent.reference_label || ""})`;
    $("recVersion").textContent = `Versão v${consent.version_number}`;
    $("recName").textContent = consent.representative_name || "—";
    $("recEmail").textContent = consent.representative_email || "—";
    $("recAcceptedAt").textContent = formatDateTime(consent.accepted_at);
    $("recPdfHash").textContent = consent.pdf_sha256 || "—";
    $("recIntegrityHash").textContent = consent.integrity_hash || "—";
    $("btnReceiptDownloadPdf").href = currentDownloadUrl;
    $("recLegalNotice").textContent = legalNotice || "";
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
      const version = data.version || {};

      if (city.logo_data_url) {
        $("pubCityLogoImg").src = city.logo_data_url;
        $("pubCityLogoWrap").classList.remove("hidden");
      } else {
        $("pubCityLogoWrap").classList.add("hidden");
      }

      $("pubMeetingTitle").textContent = meeting.title || "Ata de Reunião de Indicadores";
      $("pubCityProject").textContent = `${city.name || ""}${city.project_name ? " — " + city.project_name : ""}`;
      $("pubMeetingDate").textContent = meeting.date_text || "—";
      $("pubReferenceLabel").textContent = meeting.reference_label || "—";
      $("pubMeetingLocal").textContent = meeting.local || "Microsoft Teams";
      $("pubVersionBadge").textContent = `Versão v${version.version_number}`;
      $("pubPdfHash").textContent = version.pdf_sha256 || "—";

      currentPdfUrl = data.pdf_url;
      currentDownloadUrl = data.pdf_download_url;
      $("btnOpenPdfTab").href = currentPdfUrl;
      $("btnDownloadPdf").href = currentDownloadUrl;

      await renderPdfWithPdfJs(currentPdfUrl);

      if (data.state === "confirmed" && data.consent) {
        renderReceipt(data.consent, data.legal_notice);
      } else {
        $("consentFormWrap").classList.remove("hidden");
        $("consentReceiptWrap").classList.add("hidden");
        $("declarationText").textContent = data.declaration_text || "";
        $("pubLegalNotice").textContent = data.legal_notice || "";
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
      btn.textContent = "Registrando consentimento...";

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
        renderReceipt(data.consent, data.legal_notice);
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
