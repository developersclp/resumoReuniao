"""Gerador de PDF definitivo A4 preservando 100% o layout institucional da folha LOCAR."""

from __future__ import annotations

import base64
import html
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from backend.config import BASE_DIR
from backend.security import sha256_hex

_CSS_PATH = BASE_DIR / "css" / "styles.css"
_WHITE_LOGO_PATH = BASE_DIR / "assets" / "logo-locar-white.png"
_COLOR_LOGO_PATH = BASE_DIR / "assets" / "logo-locar.png"
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _parse_hex_rgb(color: str | None, fallback: str) -> tuple[str, tuple[int, int, int]]:
    raw = str(color or "").strip()
    m = _HEX_RE.match(raw)
    if not m:
        raw = fallback
        m = _HEX_RE.match(raw)
    hx = m.group(1)
    if len(hx) == 3:
        hx = "".join(c * 2 for c in hx)
    r = int(hx[0:2], 16)
    g = int(hx[2:4], 16)
    b = int(hx[4:6], 16)
    return f"#{hx.lower()}", (r, g, b)


def _mix_rgb(rgb: tuple[int, int, int], target: tuple[int, int, int], ratio: float) -> str:
    r = max(0, min(255, round(rgb[0] * (1 - ratio) + target[0] * ratio)))
    g = max(0, min(255, round(rgb[1] * (1 - ratio) + target[1] * ratio)))
    b = max(0, min(255, round(rgb[2] * (1 - ratio) + target[2] * ratio)))
    return f"#{r:02x}{g:02x}{b:02x}"


def build_report_theme_style(primary_color: str | None, secondary_color: str | None) -> str:
    p_hex, (pr, pg, pb) = _parse_hex_rgb(primary_color, "#0a7e3a")
    s_hex, (sr, sg, sb) = _parse_hex_rgb(secondary_color, "#b4c85a")
    p_dark = _mix_rgb((pr, pg, pb), (0, 0, 0), 0.22)
    p_light = _mix_rgb((pr, pg, pb), (255, 255, 255), 0.14)
    p_soft = _mix_rgb((pr, pg, pb), (255, 255, 255), 0.92)
    return "; ".join(
        [
            f"--report-primary: {p_hex}",
            f"--report-primary-dark: {p_dark}",
            f"--report-primary-light: {p_light}",
            f"--report-primary-soft: {p_soft}",
            f"--report-primary-a44: rgba({pr}, {pg}, {pb}, 0.44)",
            f"--report-primary-a24: rgba({pr}, {pg}, {pb}, 0.24)",
            f"--report-secondary: {s_hex}",
            f"--report-secondary-a50: rgba({sr}, {sg}, {sb}, 0.50)",
            f"--report-secondary-a36: rgba({sr}, {sg}, {sb}, 0.36)",
        ]
    )


def _load_file_data_url(path: Path, mime: str = "image/png") -> str:
    raw = path.read_bytes()
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _read_styles_css() -> str:
    return _CSS_PATH.read_text(encoding="utf-8")


def build_a4_html(meeting_snapshot: dict, city_snapshot: dict | None = None) -> str:
    """Constrói HTML autocontido idêntico à folha #a4Sheet para conversão fiel em PDF A4."""
    city_snapshot = city_snapshot or {}
    header_theme = (meeting_snapshot.get("headerTheme") or "die").strip().lower()
    is_die = header_theme != "locar"

    actions = meeting_snapshot.get("actions") or []
    topics = meeting_snapshot.get("topics") or []
    indicators = meeting_snapshot.get("indicators") or []
    show_topics = bool(meeting_snapshot.get("showTopics")) and len(topics) > 0
    show_kpis = bool(meeting_snapshot.get("showKpisOnSheet")) and len(indicators) > 0
    extra_blank_rows = max(0, min(6, int(meeting_snapshot.get("extraBlankRows") or 0)))
    density_mode = (meeting_snapshot.get("densityMode") or "auto").strip().lower()

    total_rows = len(actions) + extra_blank_rows
    should_compact = density_mode == "compact" or (
        density_mode == "auto"
        and (total_rows >= 8 or (show_topics and total_rows >= 6))
    )

    sheet_classes = ["a4-sheet"]
    if not is_die:
        sheet_classes.append("theme-locar")
    if should_compact:
        sheet_classes.append("density-compact")

    primary_color = meeting_snapshot.get("primaryColor") or city_snapshot.get("default_primary_color") or "#0a7e3a"
    secondary_color = meeting_snapshot.get("secondaryColor") or city_snapshot.get("default_secondary_color") or "#b4c85a"
    theme_style_attr = build_report_theme_style(primary_color, secondary_color)

    report_logo_url = (meeting_snapshot.get("reportLogoDataUrl") or city_snapshot.get("report_logo_data_url") or "").strip()
    if report_logo_url:
        locar_logo_url = report_logo_url
        sheet_classes.append("has-custom-report-logo")
    else:
        locar_logo_url = _load_file_data_url(_WHITE_LOGO_PATH if is_die else _COLOR_LOGO_PATH)
    city_logo_url = (city_snapshot.get("logo_data_url") or "").strip()

    unit_name = meeting_snapshot.get("unitName") or city_snapshot.get("name") or "Unidade"
    local = meeting_snapshot.get("local") or "Microsoft Teams"
    date_text = meeting_snapshot.get("dateText") or ""
    time_text = meeting_snapshot.get("timeText") or ""
    participants = meeting_snapshot.get("participants") or ""
    title = meeting_snapshot.get("title") or "Ata de Reunião de Indicadores"
    summary = meeting_snapshot.get("summary") or ""
    footer_text = meeting_snapshot.get("footerText") or "DIE – Departamento de Inteligência Estratégica"

    city_logo_html = ""
    if city_logo_url:
        city_logo_html = (
            '<div class="sheet-city-logo-box">'
            f'<img src="{html.escape(city_logo_url, quote=True)}" alt="Logotipo da Cidade" class="sheet-city-logo-img" />'
            "</div>"
        )

    topics_html = ""
    if show_topics:
        lines_html = "".join(
            f'<div class="topic-line"><span class="topic-area">{html.escape(str(t.get("area", "")))}:</span> '
            f'{html.escape(str(t.get("text", "")))}</div>'
            for t in topics
        )
        topics_html = (
            '<div class="topics-box">'
            '<div class="topics-box-title">Principais Tópicos e Assuntos Destacados</div>'
            f"<div>{lines_html}</div>"
            "</div>"
        )

    kpis_html = ""
    if show_kpis:
        cards_html = "".join(
            f'<div class="sheet-kpi-item">'
            f'<div class="sheet-kpi-label">{html.escape(str(k.get("label", "")))}</div>'
            f'<div class="sheet-kpi-val">{html.escape(str(k.get("value", "")))}</div>'
            f"</div>"
            for k in indicators[:8]
        )
        kpis_html = f'<div class="sheet-kpis" style="display:grid;">{cards_html}</div>'

    action_rows = []
    for item in actions:
        action_rows.append(
            "<tr>"
            f"<td>{html.escape(str(item.get('action', '')))}</td>"
            f"<td>{html.escape(str(item.get('owner', '')))}</td>"
            f"<td>{html.escape(str(item.get('deadline', '')))}</td>"
            f"<td>{html.escape(str(item.get('status', '') or ''))}</td>"
            "</tr>"
        )
    for _ in range(extra_blank_rows):
        action_rows.append('<tr class="blank-paper-row"><td></td><td></td><td></td><td></td></tr>')

    base_css = _read_styles_css()
    pdf_override_css = """
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: 210mm !important;
      height: auto !important;
      background: #ffffff !important;
    }
    .a4-sheet {
      width: 210mm !important;
      min-height: 296.2mm !important;
      margin: 0 !important;
      box-shadow: none !important;
      font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif !important;
      overflow: hidden !important;
    }
    .meta-top-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 6px;
    }
    .meta-fields-col {
      flex: 1;
      min-width: 0;
    }
    .sheet-city-logo-box {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 1mm 1.5mm;
      border: 1px solid #d5e2d7;
      border-radius: 5px;
      background: #ffffff;
    }
    .sheet-city-logo-img {
      max-width: 26mm;
      max-height: 14mm;
      width: auto;
      height: auto;
      object-fit: contain;
      display: block;
    }
    """

    return f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>{html.escape(title)}</title>
  <style>
{base_css}
{pdf_override_css}
  </style>
</head>
<body>
  <article class="{' '.join(sheet_classes)}" style="{html.escape(theme_style_attr, quote=True)}">
    <div class="sheet-banner">
      <span class="sheet-unit-name">{html.escape(unit_name)}</span>
    </div>

    <header class="sheet-header">
      <div class="logo-organic-container">
        <div class="organic-blob">
          <span class="blob-circle-extra"></span>
          <img src="{html.escape(locar_logo_url, quote=True)}" alt="Logo do Relatório" class="sheet-logo-img" />
        </div>
      </div>

      <div class="sheet-meta">
        <div class="meta-top-row">
          <div class="meta-fields-col">
            <div class="meta-row">
              <svg class="meta-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
              <div><span class="meta-label">Local:</span> <span>{html.escape(local)}</span></div>
            </div>
            <div class="meta-row">
              <svg class="meta-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z"/></svg>
              <div><span class="meta-label">Data:</span> <span>{html.escape(date_text)}</span></div>
            </div>
            <div class="meta-row">
              <svg class="meta-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
              <div><span class="meta-label">Hora:</span> <span>{html.escape(time_text)}</span></div>
            </div>
          </div>
          {city_logo_html}
        </div>
        <div class="meta-participants">
          <span class="meta-label">Participação:</span> <span>{html.escape(participants)}</span>
        </div>
      </div>
    </header>

    <div class="sheet-body">
      <h1 class="sheet-title">{html.escape(title)}</h1>

      <div class="summary-block">
        <span class="summary-roman">I.</span>
        <div class="summary-text">{html.escape(summary)}</div>
      </div>

      {topics_html}
      {kpis_html}

      <table class="action-table">
        <colgroup>
          <col class="col-action" />
          <col class="col-owner" />
          <col class="col-deadline" />
          <col class="col-status" />
        </colgroup>
        <thead>
          <tr>
            <th>Itens de ação</th>
            <th>Proprietários</th>
            <th>Prazo</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {''.join(action_rows)}
        </tbody>
      </table>
    </div>

    <footer class="sheet-footer">
      <span class="footer-label">{html.escape(footer_text)}</span>
      <div class="footer-circles" aria-hidden="true">
        <span class="fc-1"></span>
        <span class="fc-2"></span>
        <span class="fc-3"></span>
      </div>
    </footer>
  </article>
</body>
</html>
"""


def detect_chromium_binary() -> str | None:
    """Localiza o binário Chromium/Chrome/Edge disponível no sistema."""
    env_bin = os.environ.get("CHROMIUM_PATH", "").strip()
    if env_bin and os.path.exists(env_bin):
        return env_bin

    for candidate in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "msedge"):
        found = shutil.which(candidate)
        if found:
            return found

    windows_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ]
    for path in windows_paths:
        if os.path.exists(path):
            return path
    return None


def get_pdf_engine_status() -> str:
    if detect_chromium_binary():
        return "chromium"
    try:
        import weasyprint  # noqa: F401

        return "weasyprint"
    except Exception:
        return "unavailable"


def _render_via_chromium(html_content: str, browser_bin: str) -> bytes:
    tmp_dir = Path(tempfile.mkdtemp(prefix="locar_pdf_"))
    try:
        html_path = tmp_dir / "ata.html"
        pdf_path = tmp_dir / "ata.pdf"
        profile_dir = tmp_dir / "chrome_profile"
        profile_dir.mkdir(parents=True, exist_ok=True)

        html_path.write_text(html_content, encoding="utf-8")
        file_uri = html_path.resolve().as_uri()

        base_flags = [
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-extensions",
            "--no-first-run",
            "--no-default-browser-check",
            "--no-pdf-header-footer",
            f"--user-data-dir={profile_dir}",
            f"--print-to-pdf={pdf_path}",
            file_uri,
        ]

        last_err = ""
        for headless_flag in ("--headless=new", "--headless"):
            if pdf_path.exists():
                pdf_path.unlink()
            cmd = [browser_bin, headless_flag, *base_flags]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
            if proc.returncode == 0 and pdf_path.exists() and pdf_path.stat().st_size > 100:
                pdf_bytes = pdf_path.read_bytes()
                if pdf_bytes.startswith(b"%PDF-"):
                    return pdf_bytes
            last_err = (proc.stderr or proc.stdout or f"returncode={proc.returncode}")[:400]

        raise RuntimeError(f"Falha ao renderizar PDF via Chromium: {last_err}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _render_via_weasyprint(html_content: str) -> bytes:
    from weasyprint import HTML

    pdf_bytes = HTML(string=html_content, base_url=str(BASE_DIR)).write_pdf()
    if not pdf_bytes.startswith(b"%PDF-"):
        raise RuntimeError("WeasyPrint retornou arquivo PDF inválido.")
    return pdf_bytes


def render_meeting_pdf(meeting_snapshot: dict, city_snapshot: dict | None = None) -> tuple[bytes, str, str]:
    """Gera o PDF definitivo da ata A4 e retorna (pdf_bytes, sha256_hex, engine_name)."""
    html_content = build_a4_html(meeting_snapshot, city_snapshot)
    browser_bin = detect_chromium_binary()
    if browser_bin:
        pdf_bytes = _render_via_chromium(html_content, browser_bin)
        return pdf_bytes, sha256_hex(pdf_bytes), "chromium"

    try:
        pdf_bytes = _render_via_weasyprint(html_content)
        return pdf_bytes, sha256_hex(pdf_bytes), "weasyprint"
    except Exception as exc:
        raise RuntimeError(
            "Nenhum motor de PDF disponível (Chromium/Chrome/Edge ou WeasyPrint)."
        ) from exc
