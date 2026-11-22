// Camada HTTP para a API administrativa da plataforma Grupo LOCAR
(function () {
  async function apiRequest(path, options = {}) {
    const opts = {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {
        ...(options.headers || {})
      }
    };

    if (options.body !== undefined) {
      if (typeof options.body === "string") {
        opts.body = options.body;
      } else {
        opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
        opts.body = JSON.stringify(options.body);
      }
    }

    const res = await fetch(path, opts);
    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");

    if (!res.ok) {
      const msg = (isJson && data && data.error) ? data.error : `Erro HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && !options.skipAuthEvent) {
        window.dispatchEvent(new CustomEvent("locar:unauthorized"));
      }
      throw err;
    }

    return data;
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } finally {
      ta.remove();
    }
  }

  window.LocarApi = {
    request: apiRequest,
    copyToClipboard,
    get: (path, opts) => apiRequest(path, { ...(opts || {}), method: "GET" }),
    post: (path, body, opts) => apiRequest(path, { ...(opts || {}), method: "POST", body }),
    put: (path, body, opts) => apiRequest(path, { ...(opts || {}), method: "PUT", body }),
    patch: (path, body, opts) => apiRequest(path, { ...(opts || {}), method: "PATCH", body }),
    del: (path, opts) => apiRequest(path, { ...(opts || {}), method: "DELETE" })
  };
})();
