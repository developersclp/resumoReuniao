// Parser de Relatório de Presença (.csv/.tsv), Indicadores (.csv) e Analisador de Transcrição do Microsoft Teams

(function () {
  const DAYS_PT = [
    "Domingo",
    "Segunda-Feira",
    "Terça-Feira",
    "Quarta-Feira",
    "Quinta-Feira",
    "Sexta-Feira",
    "Sábado"
  ];

  const MONTHS_PT = [
    "Janeiro",
    "Fevereiro",
    "Março",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro"
  ];

  // Decodifica ArrayBuffer detectando UTF-16LE, UTF-16BE ou UTF-8
  function decodeFileBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    // Heurística: muitos bytes 0x00 nas posições ímpares indicam UTF-16LE sem BOM
    let nullOdd = 0;
    const sampleLen = Math.min(bytes.length, 200);
    for (let i = 1; i < sampleLen; i += 2) {
      if (bytes[i] === 0) nullOdd++;
    }
    if (sampleLen > 20 && nullOdd > sampleLen * 0.25) {
      return new TextDecoder("utf-16le").decode(bytes);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  // Extrator leve de texto para arquivos .docx (formato padrão de download de transcrição do Teams)
  async function extractTextFromDocx(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;

    async function inflateRaw(compressed) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("Navegador sem suporte nativo a descompressão ZIP.");
      }
      const ds = new DecompressionStream("deflate-raw");
      const writer = ds.writable.getWriter();
      writer.write(compressed);
      writer.close();
      const resp = new Response(ds.readable);
      return await resp.text();
    }

    while (offset + 30 < bytes.length) {
      const sig = view.getUint32(offset, true);
      if (sig !== 0x04034b50) break;

      const flags = view.getUint16(offset + 6, true);
      const compression = view.getUint16(offset + 8, true);
      let compSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const fileName = new TextDecoder("utf-8").decode(
        bytes.subarray(offset + 30, offset + 30 + nameLen)
      );
      const dataStart = offset + 30 + nameLen + extraLen;

      // Se data descriptor estiver ativo (compSize === 0), localiza próxima assinatura PK
      if ((flags & 0x08) !== 0 && compSize === 0) {
        let nextPos = dataStart;
        while (nextPos + 4 < bytes.length) {
          if (
            bytes[nextPos] === 0x50 &&
            bytes[nextPos + 1] === 0x4b &&
            (bytes[nextPos + 2] === 0x03 || bytes[nextPos + 2] === 0x01 || bytes[nextPos + 2] === 0x07)
          ) {
            if (bytes[nextPos + 2] === 0x07 && bytes[nextPos + 3] === 0x08) {
              compSize = nextPos - dataStart;
              offset = nextPos + 16;
              break;
            }
            if (bytes[nextPos + 2] === 0x03 && bytes[nextPos + 3] === 0x04) {
              compSize = nextPos - dataStart;
              offset = nextPos;
              break;
            }
          }
          nextPos++;
        }
      } else {
        offset = dataStart + compSize;
      }

      if (fileName === "word/document.xml") {
        const chunk = bytes.subarray(dataStart, dataStart + compSize);
        let xmlText = "";
        if (compression === 0) {
          xmlText = new TextDecoder("utf-8").decode(chunk);
        } else if (compression === 8) {
          xmlText = await inflateRaw(chunk);
        }
        // Converte parágrafos XML do Word em quebras de linha limpas
        const withLines = xmlText
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:tab\/>/g, " ")
          .replace(/<w:br[^>]*\/>/g, "\n")
          .replace(/<[^>]+>/g, "");
        return withLines
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'");
      }
    }
    throw new Error("Não foi possível localizar word/document.xml no arquivo .docx. Tente salvar como .txt ou colar o texto.");
  }

  function cleanParticipantName(name) {
    return (name || "")
      .replace(/\(Não verificado\)/gi, "")
      .replace(/\(Unverified\)/gi, "")
      .replace(/\(Convidado\)/gi, "")
      .replace(/\(Guest\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseTeamsDateTime(raw) {
    if (!raw) return null;
    const text = raw.trim();
    // Formato Teams EN-US: "11/17/26, 8:33:28 AM" ou "11/17/2026, 8:33:28 AM"
    let m = text.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i
    );
    if (m) {
      let p1 = parseInt(m[1], 10);
      let p2 = parseInt(m[2], 10);
      let year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      let hour = parseInt(m[4], 10);
      const min = parseInt(m[5], 10);
      const ampm = (m[7] || "").toUpperCase();

      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;

      // Se p1 > 12 é DD/MM, caso contrário se houver AM/PM normalmente é MM/DD
      let month, day;
      if (p1 > 12) {
        day = p1;
        month = p2;
      } else if (p2 > 12 || ampm) {
        month = p1;
        day = p2;
      } else {
        day = p1;
        month = p2;
      }
      return new Date(year, month - 1, day, hour, min, 0);
    }

    // Formato PT-BR extenso: "17 de novembro de 2026, 12:11PM"
    const mExt = text.match(
      /(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i
    );
    if (mExt) {
      const day = parseInt(mExt[1], 10);
      const monthName = mExt[2].toLowerCase();
      const monthIdx = MONTHS_PT.findIndex((x) => x.toLowerCase() === monthName);
      const year = parseInt(mExt[3], 10);
      let hour = mExt[4] ? parseInt(mExt[4], 10) : 9;
      const min = mExt[5] ? parseInt(mExt[5], 10) : 0;
      const ampm = (mExt[6] || "").toUpperCase();
      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;
      if (monthIdx >= 0) {
        return new Date(year, monthIdx, day, hour, min, 0);
      }
    }
    return null;
  }

  function formatDateWithWeekday(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return "";
    const dd = String(dateObj.getDate()).padStart(2, "0");
    const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
    const yyyy = dateObj.getFullYear();
    const wd = DAYS_PT[dateObj.getDay()];
    return `${dd}/${mm}/${yyyy} (${wd})`;
  }

  function formatHourHHMM(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return "";
    const hh = String(dateObj.getHours()).padStart(2, "0");
    const mi = String(dateObj.getMinutes()).padStart(2, "0");
    return `${hh}:${mi}`;
  }

  function inferMonthsFromMeetingDate(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) {
      return { refMonthYear: "Outubro/2026", nextMonthYear: "Dezembro/2026" };
    }
    // Reunião de indicadores no mês M analisa os indicadores fechados de M-1
    const refDate = new Date(dateObj.getFullYear(), dateObj.getMonth() - 1, 1);
    const nextDate = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 1);
    return {
      refMonthYear: `${MONTHS_PT[refDate.getMonth()]}/${refDate.getFullYear()}`,
      nextMonthYear: `${MONTHS_PT[nextDate.getMonth()]}/${nextDate.getFullYear()}`
    };
  }

  function extractUnitFromTitle(title) {
    if (!title) return "";
    return title
      .replace(/^indicadores\s*[-–:]?\s*/i, "")
      .replace(/^reuni[aã]o\s+(de\s+)?indicadores\s*[-–:]?\s*/i, "")
      .replace(/\s*[-–]\s*\d{2,4}.*$/, "")
      .trim();
  }

  // Parseia CSV/TSV de Relatório de Presença do Teams
  function parseAttendanceCSV(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.some((l) => l.includes(";")) ? ";" : ",";

    let section = "";
    let meetingTitle = "";
    let startTimeRaw = "";
    let organizerTimeRaw = "";
    const participants = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (/^1\.\s*Resumo/i.test(line) || /^1\.\s*Summary/i.test(line)) {
        section = "summary";
        continue;
      }
      if (/^2\.\s*Participantes/i.test(line) || /^2\.\s*Participants/i.test(line)) {
        section = "participants";
        continue;
      }
      if (/^3\.\s*Atividades/i.test(line) || /^3\.\s*In-Meeting/i.test(line)) {
        section = "activities";
        continue;
      }

      const cols = line.split(sep).map((c) => c.replace(/^"|"$/g, "").trim());

      if (section === "summary" || (!section && cols.length >= 2)) {
        const key = (cols[0] || "").toLowerCase();
        if (key.includes("título da reunião") || key.includes("meeting title")) {
          meetingTitle = cols[1] || "";
        } else if (key.includes("hora de início") || key.includes("start time")) {
          startTimeRaw = cols[1] || "";
        }
      }

      if (section === "participants") {
        // Ignora linha de cabeçalho
        if (/^(nome|name)$/i.test(cols[0])) continue;
        const cleanName = cleanParticipantName(cols[0]);
        if (cleanName && !seen.has(cleanName.toLowerCase())) {
          seen.add(cleanName.toLowerCase());
          participants.push(cleanName);
        }
        // Captura horário da primeira entrada do Organizador (geralmente início efetivo da pauta)
        const role = (cols[6] || cols[cols.length - 1] || "").toLowerCase();
        if ((role.includes("organizador") || role.includes("organizer")) && cols[1]) {
          organizerTimeRaw = cols[1];
        }
      }
    }

    const startDateObj = parseTeamsDateTime(organizerTimeRaw || startTimeRaw);
    const roomDateObj = parseTeamsDateTime(startTimeRaw);
    const dateObj = roomDateObj || startDateObj;

    // Arredonda para o horário redondo se estiver a menos de 5 min (ex: 08:56 -> 09:00), ou mantém exato
    let timeText = formatHourHHMM(startDateObj || roomDateObj);
    if (startDateObj) {
      const mins = startDateObj.getMinutes();
      if (mins >= 55) {
        const rounded = new Date(startDateObj.getTime() + (60 - mins) * 60000);
        timeText = formatHourHHMM(rounded);
      } else if (mins <= 5) {
        timeText = `${String(startDateObj.getHours()).padStart(2, "0")}:00`;
      }
    }

    const { refMonthYear, nextMonthYear } = inferMonthsFromMeetingDate(dateObj);
    const unitName = extractUnitFromTitle(meetingTitle);

    return {
      meetingTitle,
      unitName,
      dateText: formatDateWithWeekday(dateObj),
      timeText,
      refMonthYear,
      nextMonthYear,
      participantsList: participants,
      participantsText: participants.length ? `${participants.join(", ")}.` : ""
    };
  }

  // Extrai texto limpo de arquivo .vtt ou transcrição Teams (.txt)
  function normalizeTranscript(rawText) {
    let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Se for WebVTT
    if (/^WEBVTT/i.test(text.trim())) {
      text = text
        .replace(/^WEBVTT.*$/im, "")
        .replace(/^\d+\s*$/gm, "")
        .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, "")
        .replace(/<v\s+([^>]+)>/g, "\n$1: ")
        .replace(/<\/v>/g, "");
    }
    return text;
  }

  // Analisa transcrição do Teams localmente e extrai KPIs, tópicos, resumo e ações
  function analyzeTranscript(rawText, currentContext = {}) {
    const text = normalizeTranscript(rawText);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Tenta detectar unidade e data no cabeçalho da transcrição caso ainda não tenha
    let detectedUnit = currentContext.unitName || "";
    let detectedDate = currentContext.dateText || "";
    let detectedTime = currentContext.timeText || "";
    let refMonthYear = currentContext.refMonthYear || "";
    let nextMonthYear = currentContext.nextMonthYear || "";

    if (lines.length > 0) {
      const headMatch = lines[0].match(/Indicadores\s+([A-Za-zÀ-ÿ\s]+?)(?:-\d{8}|$)/i);
      if (headMatch && !detectedUnit) {
        detectedUnit = headMatch[1].trim();
      }
    }

    for (let i = 0; i < Math.min(lines.length, 6); i++) {
      const dt = parseTeamsDateTime(lines[i]);
      if (dt) {
        if (!detectedDate) detectedDate = formatDateWithWeekday(dt);
        if (!detectedTime) detectedTime = formatHourHHMM(dt);
        const months = inferMonthsFromMeetingDate(dt);
        if (!refMonthYear) refMonthYear = months.refMonthYear;
        if (!nextMonthYear) nextMonthYear = months.nextMonthYear;
        break;
      }
    }

    if (!refMonthYear || !nextMonthYear) {
      const fallback = inferMonthsFromMeetingDate(new Date());
      refMonthYear = refMonthYear || fallback.refMonthYear;
      nextMonthYear = nextMonthYear || fallback.nextMonthYear;
    }

    // Extrai participantes citados na transcrição se não vieram do CSV
    const speakerSet = new Set();
    const speakerRegex = /^([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:de|da|do|dos|das|e)?\s*[A-ZÀ-Ý][a-zà-ÿ]+){0,3})\s+\d{1,2}:\d{2}(?::\d{2})?/;
    lines.forEach((line) => {
      const sm = line.match(speakerRegex);
      if (sm) {
        const sp = cleanParticipantName(sm[1]);
        if (sp && sp.length > 2 && !/^(Indicadores|Microsoft|Transcri)/i.test(sp)) {
          speakerSet.add(sp);
        }
      }
    });

    const lower = text.toLowerCase();
    const indicators = [];
    const topics = [];
    const actions = [];
    const prazoPadrao = `Próx. Reunião ${nextMonthYear}`;

    // Extração de métricas por padrões comuns nas reuniões de indicadores da Locar
    const mQuadro = text.match(/(\d{2,4})\s+funcion[aá]rios/i);
    const mTurnover = text.match(/turnover.*?(\d+[.,]?\d*\s*%)|(\d+[.,]?\d*\s*%)\s*de\s*turnover|base\s+de\s+(\d+%)/i);
    const mAfastados = text.match(/(\d{1,4})\s+(?:colaboradores\s+)?afastados/i);
    const mFerias = text.match(/(\d{1,4})\s+(?:pessoas\s+)?em\s+f[eé]rias/i);
    const mCapina = text.match(/(\d{1,3})\s+agentes?\s+(?:na\s+)?capina|tenho\s+(\d{1,3}).*?capina.*?era\s+para\s+ter\s+(\d{1,3})/i);

    if (mQuadro || mAfastados) {
      const q = mQuadro ? mQuadro[1] : "";
      const af = mAfastados ? mAfastados[1] : "";
      const fe = mFerias ? mFerias[1] : "";
      const tv = mTurnover ? (mTurnover[1] || mTurnover[2] || mTurnover[3]) : "";
      indicators.push({
        label: "Quadro / Afastados",
        value: `${q ? q + " colab." : "Quadro"}${af ? " (" + af + " afast.)" : ""}`,
        status: af && parseInt(af, 10) > 30 ? "warn" : "ok"
      });
      topics.push({
        area: "Pessoas & Quadro",
        text: [
          q ? `${q} colaboradores` : "",
          tv ? `turnover ${tv}` : "",
          af ? `${af} afastados` : "",
          fe ? `${fe} em férias` : "",
          mCapina ? `capina com defasagem (${mCapina[1] || mCapina[2]}/${mCapina[3] || "meta"})` : ""
        ]
          .filter(Boolean)
          .join(" | ")
      });
    }

    const mHE = text.match(/(?:horas\s+extras?|fechamos\s+com)\s*[:\-]?\s*(\d{1,3}(?:[.,]\d{3})*)\s+horas/i);
    const mHEValor = text.match(/pago\s+em\s+folha\s+(?:ficou\s+)?(?:R\$\s*)?(\d+(?:[.,]\d+)?\s*(?:mil|k)?|\d{2,3}\.?\d{3})/i);
    if (mHE) {
      indicators.push({
        label: "Horas Extras",
        value: `${mHE[1]} h${mHEValor ? " / R$ " + mHEValor[1] : ""}`,
        status: "danger"
      });
    }

    const mAtest = text.match(/(\d+[.,]\d+\s*%)\s+(?:de\s+)?absente[ií]smo.*?(\d+)\s+atestados|(\d+)\s+atestados/i);
    const mFaltas = text.match(/(?:taxa\s+de\s+faltas?.*?(\d+[.,]\d+\s*%)|(\d+)\s+faltas)/i);
    if (mAtest || mFaltas) {
      const atPct = mAtest && mAtest[1] ? mAtest[1] : "";
      const atQtd = mAtest ? mAtest[2] || mAtest[3] || "" : "";
      const flPct = mFaltas && mFaltas[1] ? mFaltas[1] : "";
      const flQtd = mFaltas && mFaltas[2] ? mFaltas[2] : "";
      indicators.push({
        label: "Atestados / Faltas",
        value: `${atPct || (atQtd ? atQtd + " atest." : "-")} / ${flPct || (flQtd ? flQtd + " faltas" : "-")}`,
        status: "warn"
      });
    }

    const mAcid = text.match(/(\d+)\s+acidentes?\s+(?:em|no\s+m[eê]s)/i);
    const mComb = text.match(/(?:combust[ií]vel|gasto\s+combust[ií]vel).*?(?:R\$\s*)?(\d{2,3}(?:[.,]\d{3})*(?:[.,]\d+)?)/i);
    const mKmL = text.match(/(\d+[.,]\d+)\s*km\/l/i);
    if (mComb) {
      indicators.push({
        label: "Combustível",
        value: `R$ ${mComb[1]}${mKmL ? " (" + mKmL[1] + " km/L)" : ""}`,
        status: "warn"
      });
    }

    const mManut = text.match(/(?:custo\s+(?:da\s+)?oficina|manuten[çc][aã]o).*?(?:R\$\s*)?(\d{2,3}(?:[.,]\d{3})*(?:[.,]\d+)?)/i);
    const mDisp = text.match(/disponibilidade.*?(\d{2,3}[.,]?\d*\s*%)/i);
    if (mManut || mDisp) {
      indicators.push({
        label: "Manutenção / Disp.",
        value: `${mManut ? "R$ " + mManut[1] : "Oficina"}${mDisp ? " / " + mDisp[1] : ""}`,
        status: "ok"
      });
    }

    const mCpk = text.match(/CPK\s+(?:ficou\s+em\s+)?(\d+[.,]\d{2,3})/i);
    if (mCpk) {
      indicators.push({ label: "CPK Pneus", value: mCpk[1], status: "ok" });
    }

    const mInlog = text.match(/Inlog.*?(\d{1,3}\s*%)/i);
    const mGPS = text.match(/(?:mapa\s+de\s+execu[çc][aã]o|cobertura).*?(\d{1,3}\s*%)/i);
    if (mInlog || mGPS) {
      indicators.push({
        label: "Inlog / Execução",
        value: `${mInlog ? mInlog[1] : "-"} / ${mGPS ? mGPS[1] : "-"}`,
        status: "warn"
      });
    }

    const mDRO = text.match(/DRO.*?Resultado\s+(?:de\s+)?(?:R\$\s*)?(\d+(?:[.,]\d+)?\s*(?:mil|M|milh[õo]es)?)/i);
    const mMargem = text.match(/margem\s+(?:de\s+)?(\d+[.,]\d+\s*%)/i);
    if (mDRO || mMargem) {
      indicators.push({
        label: "DRO / Margem",
        value: `${mDRO ? "R$ " + mDRO[1] : "DRO"}${mMargem ? " (" + mMargem[1] + ")" : ""}`,
        status: "ok"
      });
    }

    if (mComb || mManut || mCpk || mAcid) {
      topics.push({
        area: "Frota, Manutenção & Segurança",
        text: [
          mAcid ? `${mAcid[1]} acidentes` : "",
          mComb ? `Combustível R$ ${mComb[1]}` : "",
          mManut ? `Oficina R$ ${mManut[1]}` : "",
          mDisp ? `Disp. ${mDisp[1]}` : "",
          mCpk ? `CPK ${mCpk[1]}` : ""
        ]
          .filter(Boolean)
          .join(" | ")
      });
    }

    if (mInlog || mDRO || lower.includes("ouvidoria")) {
      topics.push({
        area: "Operação, Ouvidoria & DRO",
        text: [
          mInlog ? `Inlog ${mInlog[1]}` : "",
          mGPS ? `Execução ${mGPS[1]}` : "",
          mDRO ? `Resultado DRO R$ ${mDRO[1]}` : "",
          mMargem ? `Margem ${mMargem[1]}` : ""
        ]
          .filter(Boolean)
          .join(" | ")
      });
    }

    // Regras inteligentes para extração de itens de ação com base nos temas discutidos na reunião
    const actionPatterns = [
      {
        test: /afastados|aux[ií]lio[- ]doen[çc]a|auditoria.*?afast/i,
        action: `Auditoria e levantamento dos ${mAfastados ? mAfastados[1] + " " : ""}colaboradores afastados (INSS/auxílio-doença) para atualização do quadro`,
        owner: findMentionedOwners(text, ["Belisario", "Ana Paula", "Marcela", "RH"], "Gestão do Contrato e RH")
      },
      {
        test: /hub de atestados|atestados? fraudad/i,
        action: "Implantar acompanhamento em tempo real no Hub de Atestados (Segurança) e aplicar sanções disciplinares/jurídicas em faltas",
        owner: findMentionedOwners(text, ["Vivian", "Belisario", "Marcela", "Laet", "Ana Paula"], "Segurança, RH e Jurídico")
      },
      {
        test: /capina|quadro defasado|recompor.*?quadro|melhor(?:ar)? a sele[çc][aã]o/i,
        action: "Reforçar recrutamento e seleção com RH para recompor o quadro operacional defasado",
        owner: findMentionedOwners(text, ["Belisario", "Vivian", "RH"], "Gestão do Contrato e RH")
      },
      {
        test: /horas? extras?.*?(?:abastecimento|12\s*por\s*36|12x36|cen[aá]rios?)/i,
        action: "Estudar cenários para redução de horas extras no abastecimento e turno noturno (novo colaborador / avaliação escala 12x36)",
        owner: findMentionedOwners(text, ["Vivian", "Ezequias", "Vitor"], "Gestão Operacional e Diretoria")
      },
      {
        test: /meta.*?hora extra|limite de hora extra|quadro exigido|quadro pedido pela licita/i,
        action: "Definir meta/limite de horas extras por contrato e incorporar comparativo Quadro Licitação x Atual x Ótimo",
        owner: findMentionedOwners(text, ["Vitor", "Jessica", "Daniel Cabral"], "DIE e Gestão")
      },
      {
        test: /eliz[aâ]ngela|ofensores|aviso pr[eé]vio/i,
        action: "Monitorar colaboradores ofensores de atestados e acompanhar retornos de férias e desligamentos programados",
        owner: findMentionedOwners(text, ["Belisario", "Vivian", "RH"], "Gestão do Contrato e RH")
      },
      {
        test: /shellbox|posto.*?(?:shell|jos[eé] rodrigues|credencia)/i,
        action: "Verificar credenciamento de posto Shell mais próximo no sistema Shellbox para reduzir deslocamento e custo",
        owner: findMentionedOwners(text, ["Daniele Torres", "Vivian", "Belisario"], "Frota e Contrato")
      },
      {
        test: /fornecedores?.*?travad|pneus? retid|la\s*corte|jorge ricardo|chapas|tac[oó]grafo|planilha.*?sharepoint/i,
        action: "Priorizar pagamentos via planilha SharePoint para liberação de pneus, peças hidráulicas, chapas de caixas estacionárias e tacógrafo",
        owner: findMentionedOwners(text, ["Carlos Filho", "Arthur", "Guilherme", "Clécio"], "Financeiro, Compras e Frota")
      },
      {
        test: /ouvidorias? em aberto/i,
        action: "Enviar números/protocolos das ouvidorias em aberto no BI para verificação e baixa pelo contrato",
        owner: findMentionedOwners(text, ["Mônica Guerra", "Laís", "Vivian", "Jessica"], "Ouvidoria e Contrato")
      },
      {
        test: /inlog|abertura.*?motoristas|setores? de feira|tr[aá]fego/i,
        action: "Retomar reuniões com o tráfego para ampliar abertura de rotas no Inlog e revisar cadastro de setores de feira",
        owner: findMentionedOwners(text, ["Jessica", "Vivian", "Tráfego"], "DIE e Operação")
      },
      {
        test: /or[çc]amento.*?(?:2027|primeiro trimestre|1º trimestre)/i,
        action: "Elaborar orçamento do 1º trimestre de 2027 com revisão de diesel, insumos operacionais, FGTS consignado e receitas",
        owner: findMentionedOwners(text, ["Vitor", "Daniel Cabral", "Pedro Vitor", "Vivian", "Belisario"], "Controladoria e Contrato")
      },
      {
        test: /banco de horas/i,
        action: "Acompanhar encerramento / regularização de Banco de Horas junto ao departamento pessoal",
        owner: findMentionedOwners(text, ["Vitor", "Alison", "RH"], "RH e Gestão")
      },
      {
        test: /totvs|treinamento/i,
        action: "Realizar e revisar treinamento de rotina do DTM e lançamentos no sistema TOTVS",
        owner: findMentionedOwners(text, ["Romário", "DTM"], "DTM")
      }
    ];

    actionPatterns.forEach((pat) => {
      if (pat.test.test(text)) {
        actions.push({
          action: pat.action,
          owner: pat.owner,
          deadline: prazoPadrao,
          status: ""
        });
      }
    });

    // Captura também linhas explícitas com marcador "plano de ação:" se houver na transcrição e poucas regras baterem
    if (actions.length === 0) {
      const explicitMatches = text.match(/(?:plano de a[çc][aã]o|encaminhamento|ficou definido|precisamos)[:\s]+([^.!?\n]{15,160})/gi) || [];
      explicitMatches.slice(0, 6).forEach((m) => {
        const cleaned = m.replace(/^(?:plano de a[çc][aã]o|encaminhamento|ficou definido|precisamos)[:\s]+/i, "").trim();
        actions.push({
          action: cleaned.charAt(0).toUpperCase() + cleaned.slice(1),
          owner: "Equipe do Contrato",
          deadline: prazoPadrao,
          status: ""
        });
      });
    }

    const unitLabel = detectedUnit || "Unidade / Contrato";
    const summaryParts = [];
    summaryParts.push(
      `A reunião de indicadores do Contrato ${unitLabel} referente ao mês de ${refMonthYear.toLowerCase()} apresentou a análise dos resultados operacionais, quadro de colaboradores, horas extras, atestados e faltas.`
    );
    if (topics.length > 0) {
      summaryParts.push(
        `Entre os principais tópicos abordados destacaram-se: ${topics
          .map((t) => `${t.area} (${t.text})`)
          .join("; ")}.`
      );
    } else {
      summaryParts.push(
        "Também foram discutidos planos de ação para melhoria da disponibilidade operacional, controle de custos de frota e manutenção, e acompanhamento de ocorrências e metas contratuais."
      );
    }

    return {
      unitName: detectedUnit || currentContext.unitName || "",
      dateText: detectedDate || currentContext.dateText || "",
      timeText: detectedTime || currentContext.timeText || "",
      refMonthYear,
      nextMonthYear,
      title: `Ata de Reunião de Indicadores ${refMonthYear}`,
      participantsList: Array.from(speakerSet),
      participantsText: speakerSet.size > 0 ? `${Array.from(speakerSet).join(", ")}.` : "",
      summary: summaryParts.join(" "),
      topics,
      indicators,
      actions
    };
  }

  function findMentionedOwners(fullText, candidates, fallback) {
    const found = candidates.filter((name) => {
      if (name === "RH" || name === "DTM" || name === "Tráfego") {
        return new RegExp(`\\b${name}\\b`, "i").test(fullText);
      }
      const first = name.split(" ")[0];
      return new RegExp(`\\b${first}\\b`, "i").test(fullText);
    });
    return found.length > 0 ? found.join(", ") : fallback;
  }

  // Parseia planilha/CSV simples de indicadores (ex: Indicador;Valor;Status)
  function parseIndicatorsCSV(text) {
    const lines = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];
    const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
    const items = [];
    lines.forEach((line, idx) => {
      const cols = line.split(sep).map((c) => c.replace(/^"|"$/g, "").trim());
      if (cols.length < 2) return;
      if (idx === 0 && /^(indicador|m[eé]trica|nome|item)$/i.test(cols[0])) return;
      const rawStatus = (cols[2] || "").toLowerCase();
      let status = "ok";
      if (rawStatus.includes("crit") || rawStatus.includes("verm") || rawStatus.includes("alt") || rawStatus.includes("danger")) {
        status = "danger";
      } else if (rawStatus.includes("aten") || rawStatus.includes("amar") || rawStatus.includes("warn")) {
        status = "warn";
      }
      items.push({ label: cols[0], value: cols[1], status });
    });
    return items;
  }

  // Integração opcional com Gemini API caso o usuário forneça sua própria chave no painel avançado
  async function analyzeWithGeminiAI(apiKey, transcriptText, attendanceContext) {
    const prompt = `Você é um analista sênior do DIE (Departamento de Inteligência Estratégica) da LOCAR Gestão de Resíduos.
Analise a transcrição de reunião abaixo e retorne EXCLUSIVAMENTE um JSON válido (sem markdown) com:
{
  "unitName": "Nome da filial/contrato",
  "refMonthYear": "Mês/Ano de referência dos indicadores (ex: Outubro/2026)",
  "summary": "Resumo executivo formal em 1 parágrafo claro e completo começando com 'A reunião de indicadores do Contrato ...'",
  "topics": [{"area": "Nome da Área", "text": "Principais números e assuntos em uma linha"}],
  "indicators": [{"label": "Nome curto", "value": "Valor principal", "status": "ok|warn|danger"}],
  "actions": [{"action": "Descrição objetiva do item de ação", "owner": "Responsáveis", "deadline": "Próx. Reunião Mês/Ano", "status": ""}]
}
IMPORTANTE: O campo "status" dentro de cada item de "actions" DEVE vir SEMPRE como string vazia "" porque será preenchido à caneta no papel.
Contexto de presença: ${JSON.stringify(attendanceContext || {})}

Transcrição:
${transcriptText.slice(0, 45000)}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Erro na API Gemini (${res.status}): ${errBody.slice(0, 200)}`);
    }
    const json = await res.json();
    const rawOut = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = JSON.parse(rawOut);
    if (Array.isArray(parsed.actions)) {
      parsed.actions = parsed.actions.map((a) => ({
        action: a.action || "",
        owner: a.owner || "",
        deadline: a.deadline || "",
        status: ""
      }));
    }
    return parsed;
  }

  window.LocarParser = {
    decodeFileBuffer,
    extractTextFromDocx,
    parseAttendanceCSV,
    analyzeTranscript,
    parseIndicatorsCSV,
    analyzeWithGeminiAI
  };
})();
