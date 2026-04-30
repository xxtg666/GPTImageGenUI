const state = {
  mode: "text",
  images: [],
  prompts: [],
  tasks: [],
  taskPoller: null,
  resultImages: [],
  resultIndex: 0,
  editImageUrl: "",
  editImageName: "",
  paintedMaskBlob: null,
  maskHistory: [],
  maskDrawing: false,
  maskCanvasScale: 1,
  maskSourceWidth: 0,
  maskSourceHeight: 0,
  maskSourceKey: "",
  maskBaseImage: null,
  maskPaintCanvas: null,
  galleryColumns: 3,
  galleryTags: [],
  selectedGalleryTags: [],
  promptTags: [],
  selectedPromptTags: [],
  confirmResolve: null,
  textModeSize: "1024x1024",
  defaultRetries: 0,
  lightboxItem: null,
  lightboxUrl: "",
  lightboxTitle: "",
  endpoints: [],
  activeEndpointId: "",
  settingsLoaded: false,
  webIconUrl: "",
  webBackgroundUrl: "",
  webBackgroundOpacity: 0.22,
  colorTheme: "terracotta",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.remove("hidden");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.add("hidden"), 2600);
}

function setHint(selector, message) {
  $(selector).textContent = message || "";
}

function switchPage(page) {
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === page));
  $$(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${page}`));
  closeMobileNav();
  if (page === "gallery") loadGallery();
  if (page === "prompts") loadPrompts();
  if (page === "tasks") loadTasks();
}

function openMobileNav() {
  $(".sidebar").classList.add("open");
  document.body.classList.add("mobile-nav-open");
  $("#mobileNavBackdrop").classList.remove("hidden");
}

function closeMobileNav() {
  $(".sidebar").classList.remove("open");
  document.body.classList.remove("mobile-nav-open");
  $("#mobileNavBackdrop").classList.add("hidden");
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  $("#sidebarCollapseBtn").title = collapsed ? "展开侧栏" : "收起侧栏";
  $("#sidebarCollapseBtn i").className = collapsed ? "fa-solid fa-angles-right" : "fa-solid fa-angles-left";
  $("#sidebarCollapseBtn span").textContent = collapsed ? "展开侧栏" : "收起侧栏";
  localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
}

function collectSize() {
  const size = $("#sizeSelect").value;
  if (size === "custom") {
    return {
      size,
      width: $("#widthInput").value || "1024",
      height: $("#heightInput").value || "1024",
    };
  }
  return { size };
}

function collectImageOptions() {
  const options = {};
  const entries = {
    quality: $("#qualitySelect").value,
    style: $("#styleSelect").value,
    background: $("#backgroundSelect").value,
    moderation: $("#moderationSelect").value,
    output_format: $("#outputFormatSelect").value,
    output_compression: $("#outputCompressionInput").value,
  };
  Object.entries(entries).forEach(([key, value]) => {
    if (value !== "") options[key] = value;
  });
  return options;
}

function makeEndpointDraft(endpoint = {}) {
  return {
    id: endpoint.id || `endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    alias: endpoint.alias || "",
    base_url: endpoint.base_url || "https://api.openai.com/v1",
    model: endpoint.model || "gpt-image-1",
    api_key: endpoint.api_key || "",
    has_api_key: Boolean(endpoint.has_api_key || endpoint.api_key),
    collapsed: endpoint.collapsed ?? true,
  };
}

function renderEndpointList() {
  const container = $("#endpointList");
  container.innerHTML = state.endpoints
    .map(
      (endpoint, index) => `
        <section class="endpoint-card" data-endpoint-id="${endpoint.id}">
          <div class="endpoint-head">
            <button class="endpoint-toggle" type="button" data-action="toggle-endpoint" aria-expanded="${!endpoint.collapsed}">
              <i class="fa-solid fa-chevron-${endpoint.collapsed ? "right" : "down"}"></i>
              <span>${escapeHtml(endpoint.alias || `后端 ${index + 1}`)}</span>
              <small>${escapeHtml(endpoint.model || "")}</small>
            </button>
          </div>
          <div class="endpoint-body ${endpoint.collapsed ? "hidden" : ""}">
            <label class="field">
              <span>别名</span>
              <input class="endpoint-alias" value="${escapeHtml(endpoint.alias)}" placeholder="例如 主线路 / NewAPI / 备用节点" />
            </label>
            <label class="field">
              <span>接口基地址（含 /v1）</span>
              <input class="endpoint-base-url" value="${escapeHtml(endpoint.base_url)}" placeholder="https://your-api.example.com/v1" />
            </label>
            <label class="field">
              <span>模型名</span>
              <input class="endpoint-model" value="${escapeHtml(endpoint.model)}" placeholder="gpt-image-1 / gpt-image-2" />
            </label>
            <label class="field">
              <span>API Key</span>
              <div class="secret-row">
                <input class="endpoint-api-key" type="password" value="${escapeHtml(endpoint.api_key)}" placeholder="${endpoint.has_api_key ? "已保存" : "输入 API Key"}" />
                <button class="icon-btn" type="button" data-action="toggle-secret" title="显示或隐藏 API Key">
                  <i class="fa-regular fa-eye"></i>
                </button>
              </div>
            </label>
            <div class="endpoint-actions">
              <button class="ghost danger compact-danger" type="button" data-action="remove-endpoint">删除后端</button>
            </div>
          </div>
        </section>
      `,
    )
    .join("");
  renderEndpointSelectors();
}

function renderEndpointSelectors() {
  const options = state.endpoints
    .map((endpoint) => `<option value="${endpoint.id}">${escapeHtml(endpoint.alias || endpoint.model || endpoint.id)}</option>`)
    .join("");
  $("#activeEndpointSelect").innerHTML = options;
  $("#settingsActiveEndpointSelect").innerHTML = options;
  if (state.activeEndpointId) {
    $("#activeEndpointSelect").value = state.activeEndpointId;
    $("#settingsActiveEndpointSelect").value = state.activeEndpointId;
  }
}

function collectEndpointsFromForm() {
  return $$("#endpointList .endpoint-card").map((card, index) => {
    const existing = state.endpoints.find((endpoint) => endpoint.id === card.dataset.endpointId) || makeEndpointDraft();
    return {
      id: existing.id || `endpoint-${index + 1}`,
      alias: card.querySelector(".endpoint-alias").value.trim() || `后端 ${index + 1}`,
      base_url: card.querySelector(".endpoint-base-url").value.trim(),
      model: card.querySelector(".endpoint-model").value.trim(),
      api_key: card.querySelector(".endpoint-api-key").value.trim(),
      collapsed: existing.collapsed,
    };
  });
}

async function setActiveEndpoint(endpointId, persist = true) {
  state.activeEndpointId = endpointId;
  renderEndpointSelectors();
  if (!persist) return;
  await api("/api/settings", {
    method: "POST",
    body: { active_endpoint_id: endpointId },
  });
}

function fillWorkbench(prompt, size = "1024x1024") {
  $("#promptInput").value = prompt || "";
  const option = Array.from($("#sizeSelect").options).find((item) => item.value === size);
  if (option) {
    $("#sizeSelect").value = size;
  } else if (/^\d+x\d+$/.test(size)) {
    const [width, height] = size.split("x");
    $("#sizeSelect").value = "custom";
    $("#widthInput").value = width;
    $("#heightInput").value = height;
  }
  updateCustomSize();
  switchPage("workbench");
  toast("已填充到工作台");
}

function updateCustomSize() {
  const isCustom = $("#sizeSelect").value === "custom";
  $$(".custom-size").forEach((node) => node.classList.toggle("hidden", !isCustom));
}

function setMode(mode) {
  if (state.mode === "text" && mode === "image") {
    state.textModeSize = $("#sizeSelect").value || "1024x1024";
  }
  state.mode = mode;
  $$(".mode-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
  $("#imageEditFields").classList.toggle("hidden", mode !== "image");
  if (mode === "image") {
    $("#sizeSelect").value = "auto";
    updateCustomSize();
  } else {
    $("#sizeSelect").value = state.textModeSize || "1024x1024";
    updateCustomSize();
  }
}

function updateMaskStatus() {
  const uploaded = $("#maskImage").files[0];
  if (state.paintedMaskBlob) {
    $("#maskStatus").textContent = "已使用网页涂抹生成的蒙版。";
  } else if (uploaded) {
    $("#maskStatus").textContent = `已选择上传蒙版：${uploaded.name}`;
  } else {
    $("#maskStatus").textContent = "未设置蒙版。";
  }
}

function updateEditPreview() {
  const files = Array.from($("#editImage").files);
  const box = $("#editPreviewBox");
  state.paintedMaskBlob = null;
  state.maskHistory = [];
  state.maskSourceKey = "";
  state.maskBaseImage = null;
  state.maskPaintCanvas = null;
  if (state.editImageUrl) URL.revokeObjectURL(state.editImageUrl);
  if (!files.length) {
    state.editImageUrl = "";
    state.editImageName = "";
    box.classList.add("empty");
    box.innerHTML = "<p>选择图片后可直接涂抹蒙版。多图上传时会用第一张图绘制蒙版。</p>";
    updateMaskStatus();
    return;
  }
  state.editImageUrl = URL.createObjectURL(files[0]);
  state.editImageName = files[0].name || "reference.png";
  box.classList.remove("empty");
  box.innerHTML = `
    <img src="${state.editImageUrl}" alt="图生图参考预览">
    <div>
      <strong>${escapeHtml(files[0].name)}</strong>
      <p class="muted">${files.length > 1 ? `已选择 ${files.length} 张；蒙版基于第一张绘制。` : "已选择 1 张参考图。"}</p>
    </div>
  `;
  updateMaskStatus();
}

async function openMaskPainter() {
  const file = $("#editImage").files[0];
  if (!file) {
    toast("请先上传参考图片");
    return;
  }
  if (!state.editImageUrl) updateEditPreview();
  const sourceKey = `${file.name}:${file.size}:${file.lastModified}`;
  if (state.maskSourceKey === sourceKey && state.maskPaintCanvas && state.maskBaseImage) {
    renderMaskCanvas();
    $("#maskPainterDialog").classList.remove("hidden");
    return;
  }
  const image = await loadImage(state.editImageUrl);
  const canvas = $("#maskCanvas");
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  state.maskSourceWidth = image.naturalWidth;
  state.maskSourceHeight = image.naturalHeight;
  state.maskSourceKey = sourceKey;
  state.maskBaseImage = image;
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  state.maskCanvasScale = scale;
  state.maskPaintCanvas = document.createElement("canvas");
  state.maskPaintCanvas.width = canvas.width;
  state.maskPaintCanvas.height = canvas.height;
  state.maskHistory = [state.maskPaintCanvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)];
  renderMaskCanvas();
  $("#maskPainterDialog").classList.remove("hidden");
}

function renderMaskCanvas() {
  const canvas = $("#maskCanvas");
  if (!canvas.width || !state.maskBaseImage) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.maskBaseImage, 0, 0, canvas.width, canvas.height);
  if (!state.maskPaintCanvas) return;
  const overlay = document.createElement("canvas");
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  const overlayCtx = overlay.getContext("2d");
  overlayCtx.fillStyle = "rgba(200, 82, 27, 0.34)";
  overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
  overlayCtx.globalCompositeOperation = "destination-in";
  overlayCtx.drawImage(state.maskPaintCanvas, 0, 0);
  ctx.drawImage(overlay, 0, 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function maskPointerPosition(event) {
  const canvas = $("#maskCanvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function beginMaskStroke(event) {
  const canvas = $("#maskCanvas");
  if (!canvas.width || !canvas.height || !state.maskPaintCanvas) return;
  state.maskDrawing = true;
  canvas.setPointerCapture(event.pointerId);
  const ctx = state.maskPaintCanvas.getContext("2d");
  const pos = maskPointerPosition(event);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(255, 255, 255, 1)";
  ctx.strokeStyle = "rgba(255, 255, 255, 1)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Number($("#brushSizeInput").value);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
  ctx.arc(pos.x, pos.y, ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.fill();
  renderMaskCanvas();
}

function continueMaskStroke(event) {
  if (!state.maskDrawing) return;
  const ctx = state.maskPaintCanvas.getContext("2d");
  const pos = maskPointerPosition(event);
  ctx.lineWidth = Number($("#brushSizeInput").value);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  renderMaskCanvas();
}

function endMaskStroke() {
  if (!state.maskDrawing) return;
  state.maskDrawing = false;
  const canvas = $("#maskCanvas");
  const ctx = state.maskPaintCanvas.getContext("2d");
  state.maskHistory.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (state.maskHistory.length > 20) state.maskHistory.shift();
}

function undoMaskStroke() {
  const canvas = $("#maskCanvas");
  if (state.maskHistory.length <= 1 || !state.maskPaintCanvas) return;
  state.maskHistory.pop();
  state.maskPaintCanvas.getContext("2d").putImageData(state.maskHistory[state.maskHistory.length - 1], 0, 0);
  renderMaskCanvas();
}

function clearMaskCanvas() {
  const canvas = $("#maskCanvas");
  if (!state.maskPaintCanvas) return;
  const ctx = state.maskPaintCanvas.getContext("2d");
  ctx.clearRect(0, 0, state.maskPaintCanvas.width, state.maskPaintCanvas.height);
  state.maskHistory = [ctx.getImageData(0, 0, canvas.width, canvas.height)];
  state.paintedMaskBlob = null;
  renderMaskCanvas();
  updateMaskStatus();
}

async function savePaintedMask() {
  const canvas = $("#maskCanvas");
  if (!state.maskPaintCanvas) {
    toast("没有可用蒙版");
    return;
  }
  const source = state.maskPaintCanvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const small = document.createElement("canvas");
  small.width = canvas.width;
  small.height = canvas.height;
  const smallCtx = small.getContext("2d");
  const mask = smallCtx.createImageData(small.width, small.height);
  for (let i = 0; i < source.data.length; i += 4) {
    const edited = source.data[i + 3] > 0;
    mask.data[i] = 0;
    mask.data[i + 1] = 0;
    mask.data[i + 2] = 0;
    mask.data[i + 3] = edited ? 0 : 255;
  }
  smallCtx.putImageData(mask, 0, 0);
  const output = document.createElement("canvas");
  output.width = state.maskSourceWidth || canvas.width;
  output.height = state.maskSourceHeight || canvas.height;
  const ctx = output.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, output.width, output.height);
  state.paintedMaskBlob = await new Promise((resolve) => output.toBlob(resolve, "image/png"));
  $("#maskImage").value = "";
  $("#maskPainterDialog").classList.add("hidden");
  updateMaskStatus();
  toast("蒙版已生成，将随图生图任务提交");
}

async function initAuth() {
  const me = await api("/api/me");
  if (me.password_set && !me.authenticated) {
    $("#loginOverlay").classList.remove("hidden");
  } else {
    $("#loginOverlay").classList.add("hidden");
    await Promise.all([loadGallery(), loadPrompts(), state.settingsLoaded ? Promise.resolve() : loadSettings(), loadTasks()]);
    startTaskPolling();
  }
}

async function login(event) {
  event.preventDefault();
  setHint("#loginHint", "");
  try {
    await api("/api/login", {
      method: "POST",
      body: { password: $("#loginPassword").value },
    });
    $("#loginOverlay").classList.add("hidden");
    $("#loginPassword").value = "";
    await initAuth();
  } catch (error) {
    setHint("#loginHint", error.message);
  }
}

async function generate() {
  const prompt = $("#promptInput").value.trim();
  if (!prompt) {
    toast("请输入提示词");
    return;
  }
  const button = $("#generateBtn");
  button.disabled = true;
  button.textContent = "提交中...";
  setHint("#workbenchHint", "任务已提交后会在后台并行执行，可在任务列表查看进度和原始错误。");
  try {
    let data;
    const retries = state.defaultRetries || "0";
    if (state.mode === "text") {
      data = await api("/api/generate", {
        method: "POST",
        body: { prompt, retries, endpoint_id: state.activeEndpointId, ...collectSize(), ...collectImageOptions() },
      });
    } else {
      const files = Array.from($("#editImage").files);
      if (!files.length) throw new Error("图生图需要上传参考图片");
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("retries", retries);
      form.append("endpoint_id", state.activeEndpointId);
      Object.entries(collectSize()).forEach(([key, value]) => form.append(key, value));
      Object.entries(collectImageOptions()).forEach(([key, value]) => form.append(key, value));
      files.forEach((file) => form.append(files.length > 1 ? "image[]" : "image", file));
      const mask = $("#maskImage").files[0];
      if (state.paintedMaskBlob) {
        form.append("mask", state.paintedMaskBlob, `painted-mask-${Date.now()}.png`);
      } else if (mask) {
        form.append("mask", mask);
      }
      data = await api("/api/edit", { method: "POST", body: form });
    }
    await loadTasks();
    startTaskPolling();
    setHint("#workbenchHint", `任务 ${data.task.id.slice(0, 8)} 已提交，最多尝试 ${data.task.max_attempts} 次。`);
  } catch (error) {
    setHint("#workbenchHint", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "提交生成任务";
  }
}

function renderResults(images) {
  state.resultImages = images || [];
  state.resultIndex = 0;
  renderResultViewer();
}

function renderResultViewer() {
  const viewer = $("#resultViewer");
  const images = state.resultImages;
  viewer.classList.toggle("empty", images.length === 0);
  if (!images.length) {
    viewer.innerHTML = "<p>接口没有返回可保存的图片，请检查上游返回格式。</p>";
    return;
  }
  const index = Math.min(state.resultIndex, images.length - 1);
  const item = images[index];
  const title = item.title || item.revised_prompt || "未命名图片";
  viewer.innerHTML = `
    <div class="result-stage">
      <button class="result-image-btn" type="button" data-action="open-lightbox" data-image-id="${item.id}" aria-label="查看大图">
        <img src="${item.url}" alt="${escapeHtml(title)}">
      </button>
    </div>
    <div class="result-pager">
      <button class="ghost icon-btn" data-action="result-prev" ${images.length <= 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-left"></i></button>
      <strong>${escapeHtml(title)}</strong>
      <button class="ghost icon-btn" data-action="result-next" ${images.length <= 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-right"></i></button>
    </div>
  `;
}

async function loadTasks() {
  const data = await api("/api/tasks");
  state.tasks = data.tasks || [];
  renderTasks();
  const newestSuccess = state.tasks.find((task) => task.status === "succeeded" && task.images?.length);
  if (newestSuccess) {
    renderResults(newestSuccess.images);
  }
  if (state.tasks.some((task) => ["queued", "running"].includes(task.status))) {
    startTaskPolling();
  }
}

function startTaskPolling() {
  if (state.taskPoller) return;
  state.taskPoller = window.setInterval(async () => {
    try {
      await loadTasks();
      if (!state.tasks.some((task) => ["queued", "running"].includes(task.status))) {
        window.clearInterval(state.taskPoller);
        state.taskPoller = null;
      }
    } catch (error) {
      window.clearInterval(state.taskPoller);
      state.taskPoller = null;
      toast(error.message);
    }
  }, 1800);
}

function renderTasks() {
  const fullList = $("#taskList");
  const compactList = $("#workbenchTaskList");
  updateTaskControls();
  const html = state.tasks.length
    ? state.tasks.map(renderTaskCard).join("")
    : `<p class="muted">暂无任务。提交生成后会显示状态、重试次数和错误详情。</p>`;
  if (fullList) fullList.innerHTML = html;
  if (compactList) {
    compactList.innerHTML = state.tasks.length
      ? state.tasks.slice(0, 5).map(renderTaskCard).join("")
      : `<p class="muted">暂无任务。</p>`;
  }
}

function updateTaskControls() {
  const clearButton = $("#taskClearHistory");
  if (!clearButton) return;
  const hasTasks = state.tasks.length > 0;
  const hasActiveTasks = state.tasks.some((task) => ["queued", "running"].includes(task.status));
  clearButton.classList.toggle("hidden", !hasTasks || hasActiveTasks);
  clearButton.disabled = hasActiveTasks;
}

function renderTaskCard(task) {
  const statusText = {
    queued: "排队中",
    running: "生成中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已中断",
  }[task.status] || task.status;
  const canCancel = ["queued", "running"].includes(task.status);
  const images = task.images?.length
    ? `<div class="task-images">${task.images.map((image) => `<img src="${image.url}" alt="${escapeHtml(image.prompt)}" loading="lazy">`).join("")}</div>`
    : "";
  const rawError = task.raw_error
    ? `<details class="raw-error"><summary>查看原始报错</summary><pre>${escapeHtml(JSON.stringify(task.raw_error, null, 2))}</pre></details>`
    : "";
  const elapsed = taskElapsedSeconds(task);
  const expected = Math.max(5, Number(task.expected_seconds || 90));
  const progress = task.status === "succeeded" ? 100 : Math.min(100, Math.round((elapsed / expected) * 100));
  return `
    <article class="task-card ${task.status}">
      <div class="task-main">
        <div>
          <strong>${statusText}</strong>
          <span class="muted">#${task.id.slice(0, 8)} · ${task.mode === "image" ? "图生图" : "文生图"} · ${escapeHtml(task.size)} · ${escapeHtml(task.endpoint_alias || "默认后端")}</span>
        </div>
        <span class="task-badge">${task.attempt}/${task.max_attempts}</span>
      </div>
      <div class="task-progress-row">
        <span>已用 ${formatDuration(elapsed)}</span>
        <span>预期 ${formatDuration(expected)}</span>
      </div>
      <div class="task-progress" aria-label="任务进度">
        <span style="width: ${progress}%"></span>
      </div>
      <p class="prompt-text">${escapeHtml(task.prompt)}</p>
      ${task.error ? `<p class="task-error">${escapeHtml(task.error)}</p>` : ""}
      ${rawError}
      ${images}
      ${canCancel ? `<div class="card-actions compact-actions"><button class="ghost danger" data-action="cancel-task" data-task-id="${task.id}"><i class="fa-solid fa-stop"></i> 中断任务</button></div>` : ""}
      ${
        task.images?.length
          ? `<div class="card-actions"><button data-action="fill" data-prompt="${encodeURIComponent(task.prompt)}" data-size="${escapeHtml(task.size)}">填充</button><button data-action="copy" data-prompt="${encodeURIComponent(task.prompt)}">复制提示词</button></div>`
          : ""
      }
    </article>
  `;
}

function taskElapsedSeconds(task) {
  const end = task.completed_at || Math.floor(Date.now() / 1000);
  return Math.max(0, end - task.created_at);
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

async function clearTaskHistory() {
  const finishedTasks = state.tasks.filter((task) => ["succeeded", "failed", "cancelled"].includes(task.status));
  if (!finishedTasks.length) {
    toast("当前没有可清空的任务历史");
    return;
  }
  const confirmed = await confirmAction("清空任务历史", `确认清空 ${finishedTasks.length} 条任务历史？进行中的任务不会被删除。`);
  if (!confirmed) return;
  await api("/api/tasks", { method: "DELETE" });
  await loadTasks();
  toast("任务历史已清空");
}

async function cancelTask(taskId) {
  const confirmed = await confirmAction("中断任务", `确认中断任务 #${taskId.slice(0, 8)}？`);
  if (!confirmed) return;
  await api(`/api/tasks/${taskId}/cancel`, { method: "POST" });
  await loadTasks();
  toast("任务已中断");
}

function renderImageCard(item) {
  const tags = (item.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const title = item.title || item.revised_prompt || "未命名图片";
  const archivedBadge = item.archived ? `<span class="tag archive-tag">已归档</span>` : "";
  const sourceButton = item.mode === "image" && item.source_url
    ? `<button class="icon-btn" data-action="open-source-lightbox" title="查看原图"><i class="fa-regular fa-image"></i></button>`
    : "";
  return `
    <article class="image-card" data-id="${item.id}">
      <button class="image-preview" data-action="open-lightbox" data-image-id="${item.id}" aria-label="查看大图">
        <img src="${item.url}" alt="${escapeHtml(title)}" loading="lazy">
      </button>
      <div class="card-body">
        <h3 class="image-title">${escapeHtml(title)}</h3>
        <div class="meta-row">
          <span>${escapeHtml(item.size || "")}</span>
          <span>${escapeHtml(item.model || "")}</span>
          <span>${item.mode === "image" ? "图生图" : "文生图"}</span>
          ${archivedBadge}
          ${tags}
        </div>
        <div class="icon-actions">
          <span class="prompt-tooltip-wrap">
            <button class="icon-btn" data-action="copy" data-prompt="${encodeURIComponent(item.prompt)}" title="复制提示词"><i class="fa-regular fa-copy"></i></button>
            <span class="prompt-popup">${escapeHtml(item.prompt)}</span>
          </span>
          <button class="icon-btn" data-action="fill" data-prompt="${encodeURIComponent(item.prompt)}" data-size="${escapeHtml(item.size || "1024x1024")}" title="填充到工作台"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
          <a class="icon-btn" href="/api/images/${item.id}/download" title="下载图片"><i class="fa-solid fa-download"></i></a>
          ${sourceButton}
          <button class="icon-btn" data-action="open-image-edit" title="编辑标题和标签"><i class="fa-solid fa-gear"></i></button>
        </div>
      </div>
    </article>
  `;
}

async function loadGallery() {
  const query = new URLSearchParams({
    q: $("#gallerySearch")?.value || "",
    tags: state.selectedGalleryTags.join(","),
    show_archived: $("#showArchivedImages")?.checked ? "1" : "",
  });
  const data = await api(`/api/images?${query.toString()}`);
  state.images = data.images || [];
  state.galleryTags = data.available_tags || [];
  renderGalleryTagFilter();
  renderGallery();
}

function renderGalleryTagFilter() {
  const menu = $("#galleryTagMenu");
  const summary = $("#galleryTagSummary");
  state.selectedGalleryTags = state.selectedGalleryTags.filter((tag) => state.galleryTags.includes(tag));
  summary.textContent = state.selectedGalleryTags.length ? `已选择 ${state.selectedGalleryTags.length} 个标签` : "全部标签";
  if (!state.galleryTags.length) {
    menu.innerHTML = `<p class="muted">暂无标签</p>`;
    return;
  }
  menu.innerHTML = `
    <button class="tag-clear" type="button" data-action="clear-gallery-tags">清除选择</button>
    <div class="tag-options">
      ${state.galleryTags
        .map(
          (tag) => `
            <label class="tag-option">
              <input type="checkbox" value="${escapeHtml(tag)}" ${state.selectedGalleryTags.includes(tag) ? "checked" : ""}>
              <span>${escapeHtml(tag)}</span>
            </label>
          `,
        )
        .join("")}
    </div>
  `;
}

function getGalleryColumnCount() {
  const width = $("#galleryGrid").clientWidth || window.innerWidth;
  if (width < 680) return 1;
  if (width < 1120) return 2;
  if (width < 1500) return 3;
  return 4;
}

function renderGallery() {
  const grid = $("#galleryGrid");
  if (!state.images.length) {
    grid.innerHTML = `<section class="panel"><p class="muted">暂无图片。生成图片后会自动出现在这里。</p></section>`;
    return;
  }
  state.galleryColumns = getGalleryColumnCount();
  grid.style.setProperty("--gallery-columns", state.galleryColumns);
  const columns = Array.from({ length: state.galleryColumns }, () => []);
  state.images.forEach((item, index) => columns[index % state.galleryColumns].push(item));
  grid.innerHTML = columns
    .map((items) => `<div class="gallery-column">${items.map(renderImageCard).join("")}</div>`)
    .join("");
}

async function saveImageMeta(card) {
  const id = $("#editImageId").value;
  const title = $("#editImageTitle").value;
  const tags = $("#editImageTags").value;
  const archived = $("#editImageArchived").checked;
  await api(`/api/images/${id}`, { method: "PATCH", body: { title, tags, archived } });
  $("#imageEditDialog").classList.add("hidden");
  await loadGallery();
  toast("图片信息已保存");
}

async function deleteImageById(id, title) {
  const confirmed = await confirmAction("删除图片", `确认删除「${title}」？此操作会删除本地图片文件。`);
  if (!confirmed) return;
  await api(`/api/images/${id}`, { method: "DELETE" });
  $("#imageEditDialog").classList.add("hidden");
  await loadGallery();
  toast("图片已删除");
}

function confirmAction(title, message) {
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmDialog").classList.remove("hidden");
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}

function resolveConfirm(value) {
  $("#confirmDialog").classList.add("hidden");
  if (state.confirmResolve) state.confirmResolve(value);
  state.confirmResolve = null;
}

function findImage(id) {
  return [...state.images, ...state.resultImages].find((item) => item.id === id);
}

function openImageEdit(id) {
  const item = findImage(id);
  if (!item) return;
  $("#editImageId").value = item.id;
  $("#editImageTitle").value = item.title || item.revised_prompt || "";
  $("#editImageTags").value = (item.tags || []).join(", ");
  $("#editImageArchived").checked = Boolean(item.archived);
  $("#imageEditDialog").classList.remove("hidden");
}

function openLightbox(id, variant = "generated") {
  const item = findImage(id);
  if (!item) return;
  const title = item.title || item.revised_prompt || "未命名图片";
  const isSource = variant === "source" && item.source_url;
  const url = isSource ? item.source_url : item.url;
  const displayTitle = isSource ? `${title} · 原图` : title;
  state.lightboxItem = item;
  state.lightboxUrl = url;
  state.lightboxTitle = displayTitle;
  $("#lightboxImage").src = url;
  $("#lightboxImage").alt = displayTitle;
  $("#lightboxTitle").textContent = displayTitle;
  $("#lightboxDownload").href = isSource ? item.source_url : `/api/images/${item.id}/download`;
  $("#lightboxDownload").setAttribute("download", isSource ? item.source_filename || "source-image" : "");
  $("#lightboxEditBtn").classList.remove("hidden");
  $("#lightboxEditBtn").disabled = false;
  $("#lightbox").classList.remove("hidden");
}

function openPromptReferenceLightbox(id) {
  const item = state.prompts.find((prompt) => prompt.id === id);
  if (!item?.reference_url) return;
  const title = `${item.title || "提示词参考图"} · 参考图`;
  state.lightboxItem = null;
  state.lightboxUrl = item.reference_url;
  state.lightboxTitle = title;
  $("#lightboxImage").src = item.reference_url;
  $("#lightboxImage").alt = title;
  $("#lightboxTitle").textContent = title;
  $("#lightboxDownload").href = item.reference_url;
  $("#lightboxDownload").setAttribute("download", `${safeDownloadName(title)}${pathExt(item.reference_url)}`);
  $("#lightboxEditBtn").classList.add("hidden");
  $("#lightboxEditBtn").disabled = true;
  $("#lightbox").classList.remove("hidden");
}

async function fillImageEditFromLightbox() {
  if (!state.lightboxUrl) return;
  const response = await fetch(state.lightboxUrl);
  if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const ext = mimeToExt(blob.type);
  const file = new File([blob], `${safeDownloadName(state.lightboxTitle || "image")}${ext}`, {
    type: blob.type || "image/png",
  });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  $("#editImage").files = transfer.files;
  updateEditPreview();
  setMode("image");
  $("#lightbox").classList.add("hidden");
  switchPage("workbench");
  toast("已填充到图生图原图位置");
}

function mimeToExt(type) {
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/webp") return ".webp";
  return ".png";
}

function pathExt(value) {
  const match = String(value || "").split("?")[0].match(/\.(png|jpe?g|webp)$/i);
  return match ? match[0].toLowerCase() : ".png";
}

function safeDownloadName(value) {
  return String(value || "image")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 60) || "image";
}

async function loadPrompts() {
  const data = await api("/api/prompts");
  state.prompts = data.prompts || [];
  renderPromptTagFilter();
  renderPrompts();
}

function renderPrompts() {
  const q = ($("#promptSearch")?.value || "").toLowerCase().trim();
  let prompts = q
    ? state.prompts.filter((item) =>
        [item.title, item.prompt, ...(item.tags || [])].join(" ").toLowerCase().includes(q),
      )
    : state.prompts;
  if (state.selectedPromptTags.length) {
    const selected = new Set(state.selectedPromptTags.map((tag) => tag.toLowerCase()));
    prompts = prompts.filter((item) => {
      const tags = new Set((item.tags || []).map((tag) => tag.toLowerCase()));
      return Array.from(selected).every((tag) => tags.has(tag));
    });
  }
  $("#promptList").innerHTML = prompts.length
    ? prompts.map(renderPromptCard).join("")
    : `<p class="muted">还没有收藏提示词。</p>`;
}

function renderPromptTagFilter() {
  const menu = $("#promptTagMenu");
  const summary = $("#promptTagSummary");
  state.promptTags = Array.from(new Set(state.prompts.flatMap((item) => item.tags || []))).sort((a, b) =>
    a.localeCompare(b),
  );
  state.selectedPromptTags = state.selectedPromptTags.filter((tag) => state.promptTags.includes(tag));
  summary.textContent = state.selectedPromptTags.length ? `已选择 ${state.selectedPromptTags.length} 个标签` : "全部标签";
  if (!state.promptTags.length) {
    menu.innerHTML = `<p class="muted">暂无标签</p>`;
    return;
  }
  menu.innerHTML = `
    <button class="tag-clear" type="button" data-action="clear-prompt-tags">清除选择</button>
    <div class="tag-options">
      ${state.promptTags
        .map(
          (tag) => `
            <label class="tag-option">
              <input type="checkbox" value="${escapeHtml(tag)}" ${state.selectedPromptTags.includes(tag) ? "checked" : ""}>
              <span>${escapeHtml(tag)}</span>
            </label>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderPromptCard(item) {
  const tags = (item.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const reference = item.reference_url
    ? `
      <button class="prompt-reference-btn" type="button" data-action="open-prompt-reference" title="查看参考图大图">
        <img class="prompt-reference-thumb" src="${item.reference_url}" alt="${escapeHtml(item.title)} 的参考图" loading="lazy">
      </button>
    `
    : "";
  return `
    <article class="prompt-card ${item.reference_url ? "has-reference" : ""}" data-id="${item.id}">
      ${reference}
      <div class="prompt-card-content">
        <h3>${escapeHtml(item.title)}</h3>
        <p class="prompt-text">${escapeHtml(item.prompt)}</p>
      </div>
      <div class="meta-row">${tags}</div>
      <div class="icon-actions prompt-actions">
        <button class="icon-btn" data-action="prompt-fill" data-prompt="${encodeURIComponent(item.prompt)}" title="填充到工作台">
          <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </button>
        <button class="icon-btn" data-action="prompt-copy" data-prompt="${encodeURIComponent(item.prompt)}" title="复制提示词">
          <i class="fa-regular fa-copy"></i>
        </button>
        <button class="icon-btn" data-action="prompt-edit" title="编辑提示词">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="icon-btn danger-icon" data-action="prompt-delete" title="删除提示词">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </article>
  `;
}

async function addPrompt(event) {
  event?.preventDefault?.();
  try {
    const form = new FormData();
    form.append("title", $("#promptTitle").value);
    form.append("prompt", $("#promptText").value);
    form.append("tags", $("#promptTags").value);
    const reference = $("#promptReferenceImage").files[0];
    if (reference) form.append("reference_image", reference);
    await api("/api/prompts", { method: "POST", body: form });
    $("#promptTitle").value = "";
    $("#promptText").value = "";
    $("#promptTags").value = "";
    $("#promptReferenceImage").value = "";
    renderReferencePreview("#promptReferencePreview", "");
    $("#promptDialog").classList.add("hidden");
    await loadPrompts();
    toast("提示词已保存");
  } catch (error) {
    toast(error.message);
  }
}

async function deletePrompt(card) {
  const title = card.querySelector("h3")?.textContent || "这条提示词";
  const confirmed = await confirmAction("删除提示词", `确认删除「${title}」？此操作不可恢复。`);
  if (!confirmed) return;
  await api(`/api/prompts/${card.dataset.id}`, { method: "DELETE" });
  await loadPrompts();
  toast("提示词已删除");
}

function openPromptEdit(card) {
  const item = state.prompts.find((prompt) => prompt.id === card.dataset.id);
  if (!item) return;
  $("#editPromptId").value = item.id;
  $("#editPromptTitle").value = item.title || "";
  $("#editPromptText").value = item.prompt || "";
  $("#editPromptTags").value = (item.tags || []).join(", ");
  $("#editPromptReferenceImage").value = "";
  $("#clearPromptReference").checked = false;
  renderReferencePreview("#editPromptReferencePreview", item.reference_url || "");
  $("#promptEditDialog").classList.remove("hidden");
}

async function savePromptEdit(event) {
  event.preventDefault();
  const form = new FormData();
  form.append("title", $("#editPromptTitle").value);
  form.append("prompt", $("#editPromptText").value);
  form.append("tags", $("#editPromptTags").value);
  if ($("#clearPromptReference").checked) form.append("clear_reference", "true");
  const reference = $("#editPromptReferenceImage").files[0];
  if (reference) form.append("reference_image", reference);
  await api(`/api/prompts/${$("#editPromptId").value}`, { method: "PATCH", body: form });
  $("#promptEditDialog").classList.add("hidden");
  await loadPrompts();
  toast("提示词已更新");
}

function renderReferencePreview(selector, url, title = "参考图") {
  const node = $(selector);
  if (!node) return;
  if (!url) {
    node.classList.add("empty");
    node.innerHTML = `<p class="muted">未添加参考图。</p>`;
    return;
  }
  node.classList.remove("empty");
  node.innerHTML = `<img src="${url}" alt="${escapeHtml(title)}">`;
}

function previewPromptReference(inputSelector, previewSelector) {
  const file = $(inputSelector).files[0];
  renderReferencePreview(previewSelector, file ? URL.createObjectURL(file) : "", file?.name || "参考图");
}

function applyWebIcon(url) {
  state.webIconUrl = url || "";
  $("#faviconLink").href = state.webIconUrl || "";
  $$(".app-brand-mark").forEach((node) => {
    if (state.webIconUrl) {
      node.innerHTML = `<img src="${escapeHtml(state.webIconUrl)}" alt="应用图标">`;
      node.classList.add("has-image");
    } else {
      node.textContent = "G";
      node.classList.remove("has-image");
    }
  });
}

function normalizeOpacity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.22;
  return Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
}

function applyAppearance(backgroundUrl, opacity) {
  state.webBackgroundUrl = backgroundUrl || "";
  state.webBackgroundOpacity = normalizeOpacity(opacity);
  document.documentElement.style.setProperty(
    "--app-bg-image",
    state.webBackgroundUrl ? `url("${state.webBackgroundUrl.replaceAll('"', "%22")}")` : "none",
  );
  document.documentElement.style.setProperty("--app-bg-opacity", String(state.webBackgroundOpacity));
  if ($("#webBackgroundUrlInput")) $("#webBackgroundUrlInput").value = state.webBackgroundUrl;
  if ($("#webBackgroundOpacityInput")) {
    $("#webBackgroundOpacityInput").value = String(Math.round(state.webBackgroundOpacity * 100));
  }
  if ($("#webBackgroundOpacityText")) {
    $("#webBackgroundOpacityText").textContent = `${Math.round(state.webBackgroundOpacity * 100)}%`;
  }
}

function applyColorTheme(theme) {
  const allowedThemes = ["terracotta", "forest", "ocean", "slate", "rose"];
  state.colorTheme = allowedThemes.includes(theme) ? theme : "terracotta";
  document.documentElement.dataset.theme = state.colorTheme;
  if ($("#colorThemeSelect")) $("#colorThemeSelect").value = state.colorTheme;
}

async function loadSettings() {
  const settings = await api("/api/settings");
  state.settingsLoaded = true;
  state.endpoints = (settings.endpoints || []).map(makeEndpointDraft);
  state.activeEndpointId = settings.active_endpoint_id || state.endpoints[0]?.id || "";
  renderEndpointList();
  $("#expectedTaskSecondsInput").value = settings.expected_task_seconds || 90;
  $("#serverPortInput").value = settings.server_port || 7860;
  $("#webIconUrlInput").value = settings.web_icon_url || "";
  $("#colorThemeSelect").value = settings.color_theme || "terracotta";
  $("#webBackgroundUrlInput").value = settings.web_background_url || "";
  $("#webBackgroundOpacityInput").value = Math.round(normalizeOpacity(settings.web_background_opacity) * 100);
  $("#webBackgroundOpacityText").textContent = `${$("#webBackgroundOpacityInput").value}%`;
  $("#defaultRetriesInput").value = settings.default_retries || 0;
  $("#defaultTextSizeSelect").value = settings.default_text_size || "1024x1024";
  $("#defaultQualitySelect").value = settings.default_quality || "";
  $("#defaultStyleSelect").value = settings.default_style || "";
  $("#defaultBackgroundSelect").value = settings.default_background || "";
  $("#defaultModerationSelect").value = settings.default_moderation || "";
  $("#defaultOutputFormatSelect").value = settings.default_output_format || "";
  $("#defaultOutputCompressionInput").value = settings.default_output_compression || "";
  $("#qualitySelect").value = settings.default_quality || "";
  $("#styleSelect").value = settings.default_style || "";
  $("#backgroundSelect").value = settings.default_background || "";
  $("#moderationSelect").value = settings.default_moderation || "";
  $("#outputFormatSelect").value = settings.default_output_format || "";
  $("#outputCompressionInput").value = settings.default_output_compression || "";
  state.defaultRetries = settings.default_retries || 0;
  state.textModeSize = settings.default_text_size || "1024x1024";
  if (state.mode === "text") {
    $("#sizeSelect").value = state.textModeSize;
    updateCustomSize();
  }
  $("#passwordInput").placeholder = settings.password_set ? "已设置，留空则保持不变" : "设置 WebUI 密码";
  applyWebIcon(settings.web_icon_url || "");
  applyAppearance(settings.web_background_url || "", settings.web_background_opacity ?? 0.22);
  applyColorTheme(settings.color_theme || "terracotta");
}

async function saveSettings() {
  setHint("#settingsHint", "");
  try {
    await api("/api/settings", {
      method: "POST",
      body: {
        endpoints: collectEndpointsFromForm(),
        active_endpoint_id: $("#settingsActiveEndpointSelect").value,
        expected_task_seconds: $("#expectedTaskSecondsInput").value,
        server_port: $("#serverPortInput").value,
        web_icon_url: $("#webIconUrlInput").value,
        color_theme: $("#colorThemeSelect").value,
        web_background_url: $("#webBackgroundUrlInput").value,
        web_background_opacity: Number($("#webBackgroundOpacityInput").value) / 100,
        default_retries: $("#defaultRetriesInput").value,
        default_text_size: $("#defaultTextSizeSelect").value,
        default_quality: $("#defaultQualitySelect").value,
        default_style: $("#defaultStyleSelect").value,
        default_background: $("#defaultBackgroundSelect").value,
        default_moderation: $("#defaultModerationSelect").value,
        default_output_format: $("#defaultOutputFormatSelect").value,
        default_output_compression: $("#defaultOutputCompressionInput").value,
        password: $("#passwordInput").value,
        clear_password: $("#clearPassword").checked,
      },
    });
    state.endpoints = collectEndpointsFromForm().map(makeEndpointDraft);
    state.activeEndpointId = $("#settingsActiveEndpointSelect").value || state.endpoints[0]?.id || "";
    renderEndpointSelectors();
    $("#passwordInput").value = "";
    $("#clearPassword").checked = false;
    applyWebIcon($("#webIconUrlInput").value.trim());
    applyColorTheme($("#colorThemeSelect").value);
    applyAppearance($("#webBackgroundUrlInput").value.trim(), Number($("#webBackgroundOpacityInput").value) / 100);
    setHint("#settingsHint", "设置已保存。");
  } catch (error) {
    setHint("#settingsHint", error.message);
  }
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  toast("已复制");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("click", async (event) => {
  const clickedElement = event.target instanceof Element ? event.target : event.target.parentElement;
  if (!clickedElement?.closest("#galleryTagFilter")) {
    $("#galleryTagMenu")?.classList.add("hidden");
  }
  if (!clickedElement?.closest("#promptTagFilter")) {
    $("#promptTagMenu")?.classList.add("hidden");
  }
  if (!clickedElement?.closest(".inline-control")) {
    $("#backgroundOptionsPopover")?.classList.add("hidden");
  }
  if (event.target.id === "lightbox") {
    $("#lightbox").classList.add("hidden");
    return;
  }
  if (event.target.id === "imageEditDialog") {
    $("#imageEditDialog").classList.add("hidden");
    return;
  }
  if (event.target.id === "promptDialog") {
    $("#promptDialog").classList.add("hidden");
    return;
  }
  if (event.target.id === "promptEditDialog") {
    $("#promptEditDialog").classList.add("hidden");
    return;
  }
  if (event.target.id === "confirmDialog") {
    resolveConfirm(false);
    return;
  }
  if (event.target.id === "maskPainterDialog") {
    $("#maskPainterDialog").classList.add("hidden");
    return;
  }
  const target = clickedElement?.closest("button, a");
  if (!target) return;
  const action = target.dataset.action;
  const card = target.closest("[data-id]");
  const endpointCard = target.closest("[data-endpoint-id]");
  try {
    if (target.dataset.page) switchPage(target.dataset.page);
    if (target.classList.contains("mode-btn")) setMode(target.dataset.mode);
    if (target.id === "openPromptDialog") $("#promptDialog").classList.remove("hidden");
    if (action === "close-prompt-dialog") $("#promptDialog").classList.add("hidden");
    if (action === "close-prompt-edit") $("#promptEditDialog").classList.add("hidden");
    if (action === "close-image-edit") $("#imageEditDialog").classList.add("hidden");
    if (action === "close-lightbox") $("#lightbox").classList.add("hidden");
    if (action === "close-mask-painter") $("#maskPainterDialog").classList.add("hidden");
    if (action === "open-image-edit") openImageEdit(card.dataset.id);
    if (action === "open-lightbox") openLightbox(target.dataset.imageId);
    if (action === "open-source-lightbox") openLightbox(card.dataset.id, "source");
    if (action === "open-prompt-reference") openPromptReferenceLightbox(card.dataset.id);
    if (action === "result-prev") {
      state.resultIndex = Math.max(0, state.resultIndex - 1);
      renderResultViewer();
    }
    if (action === "result-next") {
      state.resultIndex = Math.min(state.resultImages.length - 1, state.resultIndex + 1);
      renderResultViewer();
    }
    if (action === "copy") await copyText(decodeURIComponent(target.dataset.prompt));
    if (action === "fill") fillWorkbench(decodeURIComponent(target.dataset.prompt), target.dataset.size);
    if (action === "prompt-fill") fillWorkbench(decodeURIComponent(target.dataset.prompt));
    if (action === "prompt-copy") await copyText(decodeURIComponent(target.dataset.prompt));
    if (action === "prompt-edit") openPromptEdit(card);
    if (action === "prompt-delete") await deletePrompt(card);
    if (action === "cancel-task") await cancelTask(target.dataset.taskId);
    if (action === "toggle-secret") {
      const input = target.closest(".secret-row")?.querySelector("input");
      if (input) input.type = input.type === "password" ? "text" : "password";
      const icon = target.querySelector("i");
      if (icon) icon.className = input?.type === "text" ? "fa-regular fa-eye-slash" : "fa-regular fa-eye";
    }
    if (action === "clear-gallery-tags") {
      state.selectedGalleryTags = [];
      await loadGallery();
    }
    if (action === "clear-prompt-tags") {
      state.selectedPromptTags = [];
      renderPromptTagFilter();
      renderPrompts();
    }
    if (action === "toggle-endpoint" && endpointCard) {
      state.endpoints = collectEndpointsFromForm();
      const endpoint = state.endpoints.find((item) => item.id === endpointCard.dataset.endpointId);
      if (endpoint) endpoint.collapsed = !endpoint.collapsed;
      renderEndpointList();
    }
    if (action === "remove-endpoint" && endpointCard) {
      if (state.endpoints.length <= 1) throw new Error("至少保留一个后端接口");
      state.endpoints = collectEndpointsFromForm();
      const endpoint = state.endpoints.find((item) => item.id === endpointCard.dataset.endpointId);
      const confirmed = await confirmAction("删除后端", `确认删除「${endpoint?.alias || "这个后端"}」？保存设置后生效。`);
      if (!confirmed) return;
      state.endpoints = state.endpoints.filter((item) => item.id !== endpointCard.dataset.endpointId);
      if (!state.endpoints.find((item) => item.id === state.activeEndpointId)) {
        state.activeEndpointId = state.endpoints[0]?.id || "";
      }
      renderEndpointList();
    }
  } catch (error) {
    toast(error.message);
  }
});

$("#loginForm").addEventListener("submit", login);
$("#mobileMenuBtn").addEventListener("click", openMobileNav);
$("#mobileNavBackdrop").addEventListener("click", closeMobileNav);
$("#sidebarCollapseBtn").addEventListener("click", () => {
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
});
$("#generateBtn").addEventListener("click", generate);
$("#addEndpointBtn").addEventListener("click", () => {
  state.endpoints = collectEndpointsFromForm();
  state.endpoints.push(makeEndpointDraft({ alias: `后端 ${state.endpoints.length + 1}`, collapsed: false }));
  renderEndpointList();
});
$("#activeEndpointSelect").addEventListener("change", (event) => {
  setActiveEndpoint(event.target.value).catch((error) => toast(error.message));
});
$("#settingsActiveEndpointSelect").addEventListener("change", (event) => {
  state.activeEndpointId = event.target.value;
  renderEndpointSelectors();
});
$("#sizeSelect").addEventListener("change", updateCustomSize);
$("#galleryReload").addEventListener("click", loadGallery);
$("#taskReload").addEventListener("click", loadTasks);
$("#taskClearHistory").addEventListener("click", () => {
  clearTaskHistory().catch((error) => toast(error.message));
});
$("#gallerySearch").addEventListener("input", () => window.clearTimeout(loadGallery.timer) || (loadGallery.timer = setTimeout(loadGallery, 250)));
$("#showArchivedImages").addEventListener("change", loadGallery);
$("#galleryTagToggle").addEventListener("click", () => {
  $("#galleryTagMenu").classList.toggle("hidden");
});
$("#galleryTagMenu").addEventListener("change", (event) => {
  if (event.target.type !== "checkbox") return;
  state.selectedGalleryTags = Array.from($("#galleryTagMenu").querySelectorAll("input[type='checkbox']:checked")).map(
    (input) => input.value,
  );
  loadGallery().catch((error) => toast(error.message));
});
$("#promptTagToggle").addEventListener("click", () => {
  $("#promptTagMenu").classList.toggle("hidden");
});
$("#promptTagMenu").addEventListener("change", (event) => {
  if (event.target.type !== "checkbox") return;
  state.selectedPromptTags = Array.from($("#promptTagMenu").querySelectorAll("input[type='checkbox']:checked")).map(
    (input) => input.value,
  );
  renderPromptTagFilter();
  renderPrompts();
});
$("#promptForm").addEventListener("submit", addPrompt);
$("#promptEditForm").addEventListener("submit", savePromptEdit);
$("#confirmOkBtn").addEventListener("click", () => resolveConfirm(true));
$("#confirmCancelBtn").addEventListener("click", () => resolveConfirm(false));
$("#lightboxEditBtn").addEventListener("click", () => {
  fillImageEditFromLightbox().catch((error) => toast(error.message));
});
$("#lightboxImage").addEventListener("click", () => {
  if (state.lightboxUrl) window.open(state.lightboxUrl, "_blank", "noopener");
});
$("#imageEditForm").addEventListener("submit", (event) => {
  event.preventDefault();
  saveImageMeta().catch((error) => toast(error.message));
});
$("#deleteImageBtn").addEventListener("click", () => {
  const id = $("#editImageId").value;
  const title = $("#editImageTitle").value || "这张图片";
  deleteImageById(id, title).catch((error) => toast(error.message));
});
$("#openMaskPainterBtn").addEventListener("click", () => openMaskPainter().catch((error) => toast(error.message)));
$("#clearPaintedMaskBtn").addEventListener("click", () => {
  state.paintedMaskBlob = null;
  if (state.maskPaintCanvas) clearMaskCanvas();
  updateMaskStatus();
});
$("#maskImage").addEventListener("change", () => {
  state.paintedMaskBlob = null;
  updateMaskStatus();
});
$("#maskCanvas").addEventListener("pointerdown", beginMaskStroke);
$("#maskCanvas").addEventListener("pointermove", continueMaskStroke);
$("#maskCanvas").addEventListener("pointerup", endMaskStroke);
$("#maskCanvas").addEventListener("pointercancel", endMaskStroke);
$("#maskUndoBtn").addEventListener("click", undoMaskStroke);
$("#maskClearBtn").addEventListener("click", clearMaskCanvas);
$("#maskSaveBtn").addEventListener("click", () => savePaintedMask().catch((error) => toast(error.message)));
$("#promptSearch").addEventListener("input", renderPrompts);
$("#promptReferenceImage").addEventListener("change", () => previewPromptReference("#promptReferenceImage", "#promptReferencePreview"));
$("#editPromptReferenceImage").addEventListener("change", () => {
  $("#clearPromptReference").checked = false;
  previewPromptReference("#editPromptReferenceImage", "#editPromptReferencePreview");
});
$("#clearPromptReference").addEventListener("change", () => {
  if ($("#clearPromptReference").checked) {
    $("#editPromptReferenceImage").value = "";
    renderReferencePreview("#editPromptReferencePreview", "");
  } else {
    const item = state.prompts.find((prompt) => prompt.id === $("#editPromptId").value);
    renderReferencePreview("#editPromptReferencePreview", item?.reference_url || "");
  }
});
$("#saveSettingsBtn").addEventListener("click", saveSettings);
$("#backgroundOptionsBtn").addEventListener("click", () => {
  $("#backgroundOptionsPopover").classList.toggle("hidden");
});
$("#webBackgroundUrlInput").addEventListener("input", () => {
  applyAppearance($("#webBackgroundUrlInput").value.trim(), Number($("#webBackgroundOpacityInput").value) / 100);
});
$("#webBackgroundOpacityInput").addEventListener("input", () => {
  applyAppearance($("#webBackgroundUrlInput").value.trim(), Number($("#webBackgroundOpacityInput").value) / 100);
});
$("#colorThemeSelect").addEventListener("change", (event) => {
  applyColorTheme(event.target.value);
});
$("#clearBackgroundBtn").addEventListener("click", () => {
  $("#webBackgroundUrlInput").value = "";
  applyAppearance("", Number($("#webBackgroundOpacityInput").value) / 100);
});
$("#editImage").addEventListener("change", updateEditPreview);
window.addEventListener("resize", () => {
  window.clearTimeout(renderGallery.timer);
  renderGallery.timer = window.setTimeout(() => {
    if ($("#page-gallery").classList.contains("active")) renderGallery();
  }, 150);
});

setSidebarCollapsed(localStorage.getItem("sidebarCollapsed") === "1");

initAuth().catch((error) => {
  toast(error.message);
});
