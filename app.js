const state = {
  data: null, detector: null, file: null, level: "1", threshold: 3, hoverIndex: null,
  folders: null, localMode: location.protocol === "file:", localResultFiles: [], localLimitFiles: [],
  zoom: null, zoomDrag: null,
};
const PLOT_WIDTH = 960;
const PLOT_HEIGHT = 540;
const elements = {
  file: document.querySelector("#fileSelect"), threshold: document.querySelector("#threshold"), thresholdValue: document.querySelector("#thresholdValue"),
  levels: document.querySelector("#levelControl"),
  tabs: document.querySelector("#detectorTabs"), summary: document.querySelector("#summary"),
  source: document.querySelector("#sourceText"), band: document.querySelector("#bandText"),
  title: document.querySelector("#chartTitle"), canvas: document.querySelector("#chart"),
  workspace: document.querySelector(".workspace"),
  wrap: document.querySelector("#chartWrap"), tooltip: document.querySelector("#tooltip"),
  empty: document.querySelector("#empty"), rows: document.querySelector("#riskRows"),
  tableEmpty: document.querySelector("#tableEmpty"), coverage: document.querySelector("#coverageText"),
  exportButton: document.querySelector("#exportButton"), overviewButton: document.querySelector("#overviewButton"),
  resultDir: document.querySelector("#resultDir"), limitDir: document.querySelector("#limitDir"),
  browseResult: document.querySelector("#browseResult"), browseLimit: document.querySelector("#browseLimit"),
  resultPicker: document.querySelector("#resultFolderPicker"), limitPicker: document.querySelector("#limitFolderPicker"),
  fullscreenButton: document.querySelector("#fullscreenButton"), resetZoomButton: document.querySelector("#resetZoomButton"),
  helpButton: document.querySelector("#helpButton"), helpDialog: document.querySelector("#helpDialog"),
  closeHelpButton: document.querySelector("#closeHelpButton"),
  toast: document.querySelector("#toast"),
};

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      const error = new Error(`服务响应格式无效 (${response.status})`);
      error.status = response.status;
      throw error;
    }
  }
  if (!text && !response.ok) {
    const error = new Error(`服务请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!text) throw new Error("服务返回空响应，请确认 Python 服务正在运行");
  if (!response.ok) {
    const error = new Error(payload.error || `服务请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function loadFiles() {
  try {
    const { files, resultDir, limitDir } = await request("/api/files");
    state.folders = { resultDir, limitDir };
    elements.resultDir.value = resultDir;
    elements.limitDir.value = limitDir;
    elements.resultDir.title = resultDir;
    elements.limitDir.title = limitDir;
    if (!files.length) throw new Error("excel 文件夹中没有 .xls 文件");
    if (!files.includes(state.file)) {
      state.file = files[0];
      resetZoom(false);
    }
    populateFileSelect(files);
    await loadAnalysis();
  } catch (error) {
    activateLocalMode();
    if (![0, 404, 405].includes(error.status || 0)) showToast("未检测到工具服务，已切换为本地模式");
  }
}

function populateFileSelect(files) {
  elements.file.innerHTML = files.map(file => `<option value="${escapeHtml(file)}">${escapeHtml(file)}</option>`).join("");
  elements.file.value = state.file || files[0] || "";
  elements.file.disabled = files.length === 0;
}

async function browseFolder(kind) {
  const button = kind === "result" ? elements.browseResult : elements.browseLimit;
  button.disabled = true;
  button.textContent = "选择中...";
  showToast("请在 Windows 对话框中选择文件夹");
  try {
    const config = await request("/api/browse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!config.cancelled) {
      state.detector = null;
      await loadFiles();
      showToast(kind === "result" ? "结果文件夹已更新" : "限值文件夹已更新");
    }
  } catch (error) {
    if ([404, 405].includes(error.status)) {
      activateLocalMode();
      showToast("当前不是工具服务，已切换为本地文件夹选择");
    } else {
      showError(error);
    }
  }
  finally {
    button.disabled = false;
    button.textContent = "选择";
  }
}

async function loadAnalysis() {
  if (state.localMode) return loadLocalAnalysis();
  if (!state.file) return;
  elements.source.textContent = "正在分析...";
  try {
    const query = new URLSearchParams({ file: state.file, level: state.level, threshold: state.threshold });
    state.data = await request(`/api/analyze?${query}`);
    const names = state.data.detectors.map(item => item.name);
    if (!names.includes(state.detector)) state.detector = names[0] || null;
    render();
  } catch (error) { showError(error); }
}

function localFolderName(files) {
  const relativePath = files[0]?.webkitRelativePath || "";
  return relativePath.split("/")[0] || "已选择文件夹";
}

async function selectLocalFolder(kind, fileList) {
  const suffix = kind === "result" ? ".xls" : ".txt";
  const files = [...fileList].filter(file => file.name.toLowerCase().endsWith(suffix));
  if (!files.length) return showError(new Error(`所选文件夹中没有 ${suffix} 文件`));
  const label = `${localFolderName(files)} (${files.length} files)`;
  if (kind === "result") {
    state.localResultFiles = files.sort((a, b) => a.name.localeCompare(b.name));
    state.file = state.localResultFiles[0].name;
    resetZoom(false);
    populateFileSelect(state.localResultFiles.map(file => file.name));
    elements.resultDir.value = label;
    elements.resultDir.title = label;
  } else {
    state.localLimitFiles = files;
    elements.limitDir.value = label;
    elements.limitDir.title = label;
  }
  if (state.localResultFiles.length && state.localLimitFiles.length) await loadLocalAnalysis();
  else elements.source.textContent = "请继续选择另一个文件夹";
}

function normalizeLocalDetector(value) {
  const text = String(value).trim().toLowerCase().replaceAll("_", "-");
  return ({ peak: "Peak", pk: "Peak", "q-peak": "Q-Peak", qpeak: "Q-Peak", "quasi-peak": "Q-Peak", "quasi peak": "Q-Peak", qp: "Q-Peak", avg: "Avg", average: "Avg" })[text] || null;
}

function detectorFromHeader(value) {
  const match = String(value).trim().match(/^(.+?)\s*\(dB(?:u|µ)A\)$/i);
  return match ? normalizeLocalDetector(match[1]) : null;
}

function detectLocalBand(filename) {
  const normalized = filename.toLowerCase().replaceAll("_", ".");
  return ["0.1kHz", "0.2kHz", "9kHz", "120kHz", "1000kHz"].find(band => normalized.includes(band.toLowerCase())) || null;
}

function parseLocalResult(text) {
  const rows = text.split(/\r?\n/).map(line => line.split("\t"));
  const headers = [];
  rows.forEach((row, rowIndex) => {
    if (!row[0]?.trim().toLowerCase().startsWith("frequency")) return;
    const columns = {};
    row.forEach((value, columnIndex) => {
      const detector = detectorFromHeader(value);
      if (detector) columns[detector] = columnIndex;
    });
    if (Object.keys(columns).length && row[1]?.trim().toLowerCase() !== "sr#") headers.push([rowIndex, columns]);
  });
  if (!headers.length) throw new Error("结果文件中未找到完整扫频数据表头");
  const [headerRow, columns] = headers.at(-1);
  const series = Object.fromEntries(Object.keys(columns).map(detector => [detector, []]));
  rows.slice(headerRow + 1).forEach(row => {
    const frequency = Number(row[0]);
    if (!Number.isFinite(frequency) || frequency <= 0) return;
    Object.entries(columns).forEach(([detector, column]) => {
      const value = Number(row[column]);
      if (row[column]?.trim() !== "" && Number.isFinite(value)) series[detector].push([frequency, value]);
    });
  });
  return series;
}

function parseLocalLimits(text) {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const fields = line.trim().split(/\s+/);
    const values = fields.slice(0, 4).map(Number);
    const detector = normalizeLocalDetector(fields[4]);
    if (fields.length < 5 || values.some(value => !Number.isFinite(value)) || !detector) throw new Error(`限值文件第 ${index + 1} 行格式无效`);
    return { start: values[0], end: values[1], startValue: values[2], endValue: values[3], detector };
  });
}

function localLimitFile(level, band) {
  const expected = `ce_cp_${band}`.toLowerCase();
  const candidates = state.localLimitFiles.filter(file => file.name.toLowerCase().startsWith(expected));
  const levelMatch = candidates.find(file => (file.webkitRelativePath || "").toLowerCase().includes(`level${level}`));
  if (levelMatch) return levelMatch;
  if (candidates.length === 1) return candidates[0];
  throw new Error(`找不到 Level ${level} / ${band} 对应的限值文件`);
}

function localLimitAt(frequency, detector, segments) {
  const values = segments.filter(segment => segment.detector === detector && segment.start <= frequency && frequency <= segment.end).map(segment => {
    if (segment.start === segment.end || segment.startValue === segment.endValue) return segment.startValue;
    const ratio = Math.log(frequency / segment.start) / Math.log(segment.end / segment.start);
    return segment.startValue + ratio * (segment.endValue - segment.startValue);
  });
  return values.length ? Math.min(...values) : null;
}

function localRegions(points, threshold) {
  const steps = points.slice(1).map((point, index) => point.frequency - points[index].frequency).filter(step => step > 0).sort((a, b) => a - b);
  const typicalStep = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const groups = [];
  let current = [];
  points.forEach(point => {
    const separated = current.length && typicalStep && point.frequency - current.at(-1).frequency > typicalStep * 3;
    if (point.margin < threshold && !separated) current.push(point);
    else {
      if (current.length) groups.push(current);
      current = point.margin < threshold ? [point] : [];
    }
  });
  if (current.length) groups.push(current);
  return groups.map(group => ({ start: group[0].frequency, end: group.at(-1).frequency, minimumMargin: Math.min(...group.map(point => point.margin)), points: group.length, failed: group.some(point => point.margin < 0) }));
}

async function analyzeLocalFile(file, level, threshold) {
  const band = detectLocalBand(file.name);
  if (!band) throw new Error(`无法从文件名识别带宽：${file.name}`);
  const limitFile = localLimitFile(level, band);
  const [series, segments] = await Promise.all([file.text().then(parseLocalResult), limitFile.text().then(parseLocalLimits)]);
  const detectors = ["Peak", "Q-Peak", "Avg"].filter(detector => series[detector]).map(detector => {
    const points = series[detector].map(([frequency, result]) => {
      const limit = localLimitAt(frequency, detector, segments);
      return limit === null ? null : { frequency, result, limit, margin: limit - result };
    }).filter(Boolean);
    return points.length ? { name: detector, points, regions: localRegions(points, threshold), minimumMargin: Math.min(...points.map(point => point.margin)), failCount: points.filter(point => point.margin < 0).length, totalPoints: series[detector].length } : null;
  }).filter(Boolean);
  return { file: file.name, level, band, limitFile: limitFile.name, threshold, detectors };
}

async function loadLocalAnalysis() {
  if (!state.localResultFiles.length || !state.localLimitFiles.length) return;
  elements.source.textContent = "正在本地分析...";
  try {
    const file = state.localResultFiles.find(item => item.name === state.file) || state.localResultFiles[0];
    state.data = await analyzeLocalFile(file, state.level, state.threshold);
    const names = state.data.detectors.map(item => item.name);
    if (!names.includes(state.detector)) state.detector = names[0] || null;
    render();
  } catch (error) { showError(error); }
}

function detectorData() {
  return state.data?.detectors.find(item => item.name === state.detector);
}

function render() {
  const detector = detectorData();
  if (elements.file.value !== state.data.file) elements.file.value = state.data.file;
  elements.title.textContent = state.data.file;
  elements.band.textContent = `频段 ${state.data.band} · Level ${state.data.level}`;
  elements.source.textContent = `LIMIT  ${state.data.limitFile}`;
  elements.tabs.innerHTML = state.data.detectors.map(item =>
    `<button role="tab" aria-selected="${item.name === state.detector}" class="${item.name === state.detector ? "active" : ""}" data-detector="${item.name}">${item.name}</button>`
  ).join("");
  elements.tabs.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    state.detector = button.dataset.detector; state.hoverIndex = null; resetZoom(false); render();
  }));
  elements.empty.hidden = Boolean(detector);
  if (!detector) return;

  const failed = detector.failCount > 0;
  elements.summary.classList.toggle("fail", failed);
  elements.summary.innerHTML = `<span class="verdict">${failed ? "FAIL" : "PASS"}</span><dl>
    <div><dt>最小裕量</dt><dd>${detector.minimumMargin.toFixed(2)} dB</dd></div>
    <div><dt>风险频段</dt><dd>${detector.regions.length}</dd></div>
    <div><dt>超限点</dt><dd>${detector.failCount}</dd></div></dl>`;
  elements.coverage.textContent = `限值覆盖 ${detector.points.length} / ${detector.totalPoints} 点`;
  elements.rows.innerHTML = detector.regions.map(region => `<tr>
    <td><span class="status ${region.failed ? "fail" : "near"}">${region.failed ? "超限" : "接近限值"}</span></td>
    <td>${formatFrequency(region.start)}</td><td>${formatFrequency(region.end)}</td>
    <td>${region.minimumMargin.toFixed(2)} dB</td><td>${region.points}</td></tr>`).join("");
  elements.tableEmpty.hidden = detector.regions.length > 0;
  drawChart();
}

function drawChart() {
  const detector = detectorData();
  if (!detector?.points.length) return;
  const canvas = elements.canvas;
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(PLOT_WIDTH * ratio);
  const pixelHeight = Math.round(PLOT_HEIGHT * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = PLOT_WIDTH, height = PLOT_HEIGHT;
  const pad = { left: 70, right: 24, top: 24, bottom: 48 };
  const plot = { left: pad.left, top: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
  const points = detector.points;
  const fullLogMin = Math.log10(points[0].frequency), fullLogMax = Math.log10(points.at(-1).frequency);
  const values = points.flatMap(point => [point.result, point.limit]);
  let fullYMin = Math.floor((Math.min(...values) - 5) / 10) * 10;
  let fullYMax = Math.ceil((Math.max(...values) + 5) / 10) * 10;
  if (fullYMax === fullYMin) fullYMax += 10;
  const fullBounds = { logMin: fullLogMin, logMax: fullLogMax, yMin: fullYMin, yMax: fullYMax };
  const view = state.zoom || fullBounds;
  const { logMin, logMax, yMin, yMax } = view;
  const x = value => plot.left + (Math.log10(value) - logMin) / (logMax - logMin || 1) * plot.width;
  const y = value => plot.top + (yMax - value) / (yMax - yMin) * plot.height;

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  detector.regions.forEach(region => {
    ctx.fillStyle = region.failed ? "rgba(197,58,49,.13)" : "rgba(228,148,35,.14)";
    ctx.fillRect(x(region.start), plot.top, Math.max(2, x(region.end) - x(region.start)), plot.height);
  });
  ctx.restore();

  ctx.font = "11px Consolas, monospace"; ctx.fillStyle = "#66716d"; ctx.strokeStyle = "#dfdbd1"; ctx.lineWidth = 1;
  const yStep = niceStep((yMax - yMin) / 6);
  for (let value = Math.ceil(yMin / yStep) * yStep; value <= yMax; value += yStep) {
    const py = y(value); ctx.beginPath(); ctx.moveTo(plot.left, py); ctx.lineTo(plot.left + plot.width, py); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(value.toFixed(0), plot.left - 10, py + 4);
  }
  const firstPower = Math.floor(logMin), lastPower = Math.ceil(logMax);
  for (let power = firstPower; power <= lastPower; power++) {
    [1, 2, 5].forEach(multiplier => {
      const value = multiplier * 10 ** power;
      if (Math.log10(value) < logMin || Math.log10(value) > logMax) return;
      const px = x(value); ctx.strokeStyle = multiplier === 1 ? "#d2cec4" : "#ece8df";
      ctx.beginPath(); ctx.moveTo(px, plot.top); ctx.lineTo(px, plot.top + plot.height); ctx.stroke();
      if (multiplier === 1 || lastPower - firstPower < 2) {
        ctx.fillStyle = "#66716d"; ctx.textAlign = "center"; ctx.fillText(formatAxisFrequency(value), px, plot.top + plot.height + 21);
      }
    });
  }
  ctx.fillStyle = "#66716d"; ctx.textAlign = "center";
  ctx.fillText("频率 (MHz, log)", plot.left + plot.width / 2, height - 9);
  ctx.save(); ctx.translate(16, plot.top + plot.height / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("幅值 (dBµA)", 0, 0); ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  drawLine(ctx, points, point => point.limit, x, y, "#202927", 1.6, [7, 5]);
  drawLine(ctx, points, point => point.result, x, y, "#12766f", 1.35, []);
  points.forEach(point => {
    if (point.margin >= state.threshold) return;
    ctx.fillStyle = point.margin < 0 ? "#c53a31" : "#e49423";
    ctx.beginPath(); ctx.arc(x(point.frequency), y(point.result), point.margin < 0 ? 2.7 : 2.1, 0, Math.PI * 2); ctx.fill();
  });

  if (state.hoverIndex !== null && points[state.hoverIndex]) {
    const point = points[state.hoverIndex], px = x(point.frequency), py = y(point.result);
    ctx.strokeStyle = "rgba(23,35,33,.35)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(px, plot.top); ctx.lineTo(px, plot.top + plot.height); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#12766f"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  if (state.zoomDrag) {
    const left = Math.min(state.zoomDrag.startX, state.zoomDrag.currentX);
    const top = Math.min(state.zoomDrag.startY, state.zoomDrag.currentY);
    const dragWidth = Math.abs(state.zoomDrag.currentX - state.zoomDrag.startX);
    const dragHeight = Math.abs(state.zoomDrag.currentY - state.zoomDrag.startY);
    ctx.fillStyle = "rgba(18,118,111,.14)";
    ctx.strokeStyle = "#12766f";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(left, top, dragWidth, dragHeight);
    ctx.strokeRect(left, top, dragWidth, dragHeight);
    ctx.setLineDash([]);
  }
  state.chartGeometry = { plot, x, y, logMin, logMax, yMin, yMax, fullBounds };
  elements.resetZoomButton.disabled = !state.zoom;
}

function drawLine(ctx, points, pick, x, y, color, width, dash) {
  ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  points.forEach((point, index) => { const px = x(point.frequency), py = y(pick(point)); index ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke(); ctx.setLineDash([]);
}

function handlePointer(event) {
  const detector = detectorData(), geometry = state.chartGeometry;
  if (!detector || !geometry) return;
  const rect = elements.canvas.getBoundingClientRect();
  const { x: mouseX, y: mouseY } = canvasPoint(event, rect);
  if (state.zoomDrag) {
    state.zoomDrag.currentX = Math.max(geometry.plot.left, Math.min(geometry.plot.left + geometry.plot.width, mouseX));
    state.zoomDrag.currentY = Math.max(geometry.plot.top, Math.min(geometry.plot.top + geometry.plot.height, mouseY));
    elements.tooltip.hidden = true;
    drawChart();
    return;
  }
  if (mouseX < geometry.plot.left || mouseX > geometry.plot.left + geometry.plot.width || mouseY < geometry.plot.top || mouseY > geometry.plot.top + geometry.plot.height) {
    elements.tooltip.hidden = true; state.hoverIndex = null; drawChart(); return;
  }
  const logValue = geometry.logMin + (mouseX - geometry.plot.left) / geometry.plot.width * (geometry.logMax - geometry.logMin);
  const frequency = 10 ** logValue;
  let low = 0, high = detector.points.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); detector.points[mid].frequency < frequency ? low = mid + 1 : high = mid; }
  state.hoverIndex = Math.max(0, low > 0 && frequency - detector.points[low - 1].frequency < detector.points[low].frequency - frequency ? low - 1 : low);
  const point = detector.points[state.hoverIndex];
  elements.tooltip.innerHTML = `<b>${formatFrequency(point.frequency)}</b><br>结果 ${point.result.toFixed(2)} dBµA<br>限值 ${point.limit.toFixed(2)} dBµA<br>裕量 ${point.margin.toFixed(2)} dB`;
  elements.tooltip.hidden = false;
  elements.tooltip.style.left = `${Math.min(rect.width - 175, Math.max(8, event.clientX - rect.left + 14))}px`;
  elements.tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 35)}px`;
  drawChart();
}

function beginZoom(event) {
  if (event.button !== 0 || !state.chartGeometry) return;
  const rect = elements.canvas.getBoundingClientRect();
  const { x, y } = canvasPoint(event, rect);
  const plot = state.chartGeometry.plot;
  if (x < plot.left || x > plot.left + plot.width || y < plot.top || y > plot.top + plot.height) return;
  state.zoomDrag = { startX: x, startY: y, currentX: x, currentY: y };
  elements.canvas.setPointerCapture(event.pointerId);
}

function endZoom(event) {
  if (!state.zoomDrag || !state.chartGeometry) return;
  const drag = state.zoomDrag;
  state.zoomDrag = null;
  if (elements.canvas.hasPointerCapture(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
  if (Math.abs(drag.currentX - drag.startX) < 8 || Math.abs(drag.currentY - drag.startY) < 8) {
    drawChart();
    return;
  }
  const geometry = state.chartGeometry;
  const left = Math.min(drag.startX, drag.currentX);
  const right = Math.max(drag.startX, drag.currentX);
  const top = Math.min(drag.startY, drag.currentY);
  const bottom = Math.max(drag.startY, drag.currentY);
  state.zoom = {
    logMin: geometry.logMin + (left - geometry.plot.left) / geometry.plot.width * (geometry.logMax - geometry.logMin),
    logMax: geometry.logMin + (right - geometry.plot.left) / geometry.plot.width * (geometry.logMax - geometry.logMin),
    yMin: geometry.yMax - (bottom - geometry.plot.top) / geometry.plot.height * (geometry.yMax - geometry.yMin),
    yMax: geometry.yMax - (top - geometry.plot.top) / geometry.plot.height * (geometry.yMax - geometry.yMin),
  };
  state.hoverIndex = null;
  drawChart();
}

function zoomWithWheel(event) {
  const geometry = state.chartGeometry;
  if (!geometry) return;
  const rect = elements.canvas.getBoundingClientRect();
  const { x: mouseX, y: mouseY } = canvasPoint(event, rect);
  const plot = geometry.plot;
  if (mouseX < plot.left || mouseX > plot.left + plot.width || mouseY < plot.top || mouseY > plot.top + plot.height) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? 0.78 : 1 / 0.78;
  const xRatio = (mouseX - plot.left) / plot.width;
  const yRatio = (mouseY - plot.top) / plot.height;
  const logCenter = geometry.logMin + xRatio * (geometry.logMax - geometry.logMin);
  const yCenter = geometry.yMax - yRatio * (geometry.yMax - geometry.yMin);
  const logSpan = (geometry.logMax - geometry.logMin) * factor;
  const ySpan = (geometry.yMax - geometry.yMin) * factor;
  const candidate = {
    logMin: logCenter - logSpan * xRatio,
    logMax: logCenter + logSpan * (1 - xRatio),
    yMin: yCenter - ySpan * (1 - yRatio),
    yMax: yCenter + ySpan * yRatio,
  };
  state.zoom = constrainZoom(candidate, geometry.fullBounds);
  drawChart();
}

function constrainZoom(view, full) {
  const constrain = (min, max, fullMin, fullMax) => {
    const span = max - min;
    if (span >= fullMax - fullMin) return [fullMin, fullMax];
    if (min < fullMin) return [fullMin, fullMin + span];
    if (max > fullMax) return [fullMax - span, fullMax];
    return [min, max];
  };
  const [logMin, logMax] = constrain(view.logMin, view.logMax, full.logMin, full.logMax);
  const [yMin, yMax] = constrain(view.yMin, view.yMax, full.yMin, full.yMax);
  const result = { logMin, logMax, yMin, yMax };
  const isFull = logMin === full.logMin && logMax === full.logMax && yMin === full.yMin && yMax === full.yMax;
  return isFull ? null : result;
}

function resetZoom(redraw = true) {
  state.zoom = null;
  state.zoomDrag = null;
  state.hoverIndex = null;
  if (redraw) drawChart();
}

function canvasPoint(event, rect = elements.canvas.getBoundingClientRect()) {
  return {
    x: (event.clientX - rect.left) * PLOT_WIDTH / rect.width,
    y: (event.clientY - rect.top) * PLOT_HEIGHT / rect.height,
  };
}

function exportCsv() {
  const detector = detectorData();
  if (!detector?.regions.length) return showToast("当前没有风险频段");
  const rows = [["Detector", "Status", "Start (MHz)", "End (MHz)", "Minimum margin (dB)", "Points"]];
  detector.regions.forEach(region => rows.push([detector.name, region.failed ? "FAIL" : "NEAR", region.start, region.end, region.minimumMargin.toFixed(3), region.points]));
  downloadCsv(rows, `${state.data.file.replace(/\.xls$/i, "")}_${detector.name}_risk.csv`);
}

async function exportOverview() {
  elements.overviewButton.disabled = true;
  elements.overviewButton.textContent = "正在生成...";
  try {
    if (state.localMode) {
      const rows = [
        ["Emission Margin Overview"],
        ["Result folder", elements.resultDir.value],
        ["Limit folder", elements.limitDir.value],
        ["Limit level", `Level ${state.level}`],
        ["Highlight threshold (dB)", state.threshold],
        [],
        ["Result file", "Band", "Level", "Detector", "Verdict", "Minimum margin (dB)", "Risk regions", "Fail points", "Covered points", "Total points", "Limit file"],
      ];
      let reportRows = 0;
      for (const file of state.localResultFiles) {
        const report = await analyzeLocalFile(file, state.level, state.threshold);
        report.detectors.forEach(item => {
          rows.push([report.file, report.band, `Level ${report.level}`, item.name, item.failCount ? "FAIL" : "PASS", item.minimumMargin.toFixed(3), item.regions.length, item.failCount, item.points.length, item.totalPoints, report.limitFile]);
          reportRows += 1;
        });
      }
      downloadCsv(rows, `Emission_Overview_Level${state.level}.csv`);
      showToast(`Overview 已导出：${reportRows} 条记录`);
      return;
    }
    const query = new URLSearchParams({ level: state.level, threshold: state.threshold });
    const link = document.createElement("a");
    link.href = `/api/overview.csv?${query}`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast("Overview 报告正在下载");
  } catch (error) { showError(error); }
  finally {
    elements.overviewButton.disabled = false;
    elements.overviewButton.textContent = "导出 Overview 报告";
  }
}

function downloadCsv(rows, filename) {
  const escape = value => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const csv = "\ufeff" + rows.map(row => row.map(escape).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}

function niceStep(raw) { const power = 10 ** Math.floor(Math.log10(raw)); const scaled = raw / power; return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power; }
function formatAxisFrequency(value) { return value < .001 ? `${(value * 1000).toPrecision(1)}k` : value >= 1000 ? `${(value / 1000).toPrecision(1)}G` : `${Number(value.toPrecision(3))}`; }
function formatFrequency(value) { return value < .001 ? `${(value * 1000).toFixed(3)} kHz` : `${value.toFixed(value < 1 ? 4 : 3)} MHz`; }
function escapeHtml(text) { const node = document.createElement("div"); node.textContent = text; return node.innerHTML; }
function showToast(message) { elements.toast.textContent = message; elements.toast.hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => elements.toast.hidden = true, 2800); }
function showError(error) { elements.source.textContent = error.message; showToast(error.message); }

function initializeLocalMode() {
  elements.resultDir.placeholder = "请选择结果文件夹";
  elements.limitDir.placeholder = "请选择限值文件夹";
  elements.source.textContent = "本地模式：请依次选择结果和限值文件夹";
  elements.summary.innerHTML = `<span class="verdict">READY</span><dl>
    <div><dt>结果文件夹</dt><dd>待选择</dd></div>
    <div><dt>限值文件夹</dt><dd>待选择</dd></div></dl>`;
}

function activateLocalMode() {
  state.localMode = true;
  state.data = null;
  state.file = null;
  elements.file.disabled = true;
  elements.file.innerHTML = "<option>请先选择结果文件夹</option>";
  resetZoom(false);
  initializeLocalMode();
}

async function toggleFullscreenChart() {
  try {
    if (document.fullscreenElement === elements.workspace) {
      await document.exitFullscreen();
    } else {
      await elements.workspace.requestFullscreen();
    }
  } catch (_error) {
    showToast("当前浏览器不支持全屏显示");
  }
}


elements.file.addEventListener("change", () => {
  state.file = elements.file.value;
  resetZoom(false);
  loadAnalysis();
});
elements.levels.addEventListener("click", event => {
  const button = event.target.closest("button"); if (!button) return;
  state.level = button.dataset.level;
  elements.levels.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
  loadAnalysis();
});
elements.threshold.addEventListener("input", () => { state.threshold = Number(elements.threshold.value); elements.thresholdValue.value = `${state.threshold.toFixed(1)} dB`; });
elements.threshold.addEventListener("change", loadAnalysis);
elements.canvas.addEventListener("pointerdown", beginZoom);
elements.canvas.addEventListener("pointermove", handlePointer);
elements.canvas.addEventListener("pointerup", endZoom);
elements.canvas.addEventListener("pointercancel", endZoom);
elements.canvas.addEventListener("pointerleave", () => { elements.tooltip.hidden = true; state.hoverIndex = null; drawChart(); });
elements.canvas.addEventListener("wheel", zoomWithWheel, { passive: false });
elements.canvas.addEventListener("dblclick", () => resetZoom());
elements.resetZoomButton.addEventListener("click", () => resetZoom());
elements.helpButton.addEventListener("click", () => elements.helpDialog.showModal());
elements.closeHelpButton.addEventListener("click", () => elements.helpDialog.close());
elements.helpDialog.addEventListener("click", event => {
  if (event.target === elements.helpDialog) elements.helpDialog.close();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && elements.helpDialog.open) elements.helpDialog.close();
});
elements.exportButton.addEventListener("click", exportCsv);
elements.overviewButton.addEventListener("click", exportOverview);
elements.browseResult.addEventListener("click", () => state.localMode ? elements.resultPicker.click() : browseFolder("result"));
elements.browseLimit.addEventListener("click", () => state.localMode ? elements.limitPicker.click() : browseFolder("limit"));
elements.resultPicker.addEventListener("change", () => selectLocalFolder("result", elements.resultPicker.files));
elements.limitPicker.addEventListener("change", () => selectLocalFolder("limit", elements.limitPicker.files));
elements.fullscreenButton.addEventListener("click", toggleFullscreenChart);
document.addEventListener("fullscreenchange", () => {
  elements.fullscreenButton.textContent = document.fullscreenElement === elements.workspace ? "×" : "⛶";
  elements.fullscreenButton.title = document.fullscreenElement === elements.workspace ? "退出完整图" : "查看完整图";
  requestAnimationFrame(drawChart);
});
new ResizeObserver(drawChart).observe(elements.wrap);
if (state.localMode) initializeLocalMode();
else loadFiles();
