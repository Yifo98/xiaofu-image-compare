import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "XiaoFuMultiVideoCompare";
const VIDEO_FOLDER_NODE_ID = "XiaoFuLoadVideoFolder";
const WIDGET_NAME = "xiaofu_multi_video_compare";
const FRAME_SLOT_PREFIX = "frames_";
const NATIVE_SLOT_PREFIX = "clip_";
const MIN_FRAME_INPUTS = 0;
const MIN_NATIVE_INPUTS = 12;
const VIDEO_FOLDER_OUTPUT_COUNT = 12;
const DEFAULT_NODE_WIDTH = 680;
const DEFAULT_NODE_HEIGHT = 820;
const RUNAWAY_NODE_HEIGHT = 1900;
const MIN_PREVIEW_HEIGHT = 280;
const MAX_PREVIEW_HEIGHT = 1000;
const TOOLBAR_HEIGHT = 26;
const CONTROLS_HEIGHT = 28;
const LABEL_ROW_HEIGHT = 24;
const LABEL_GAP = 6;
const SELECTOR_ROW_HEIGHT = 24;
const WIDGET_PADDING = 10;
const WIDGET_BOTTOM_PADDING = 12;
const EDGE_SNAP_PX = 10;
const PRELOAD_FRAME_RADIUS = 10;
const SOURCE_STEP_FRAMES = 1;
const SOURCE_FAST_STEP_FRAMES = 5;
const SOURCE_SEEK_HOLD_MS = 360;
const SOURCE_SEEK_RETRY_MS = 80;
const SOURCE_SEEK_MAX_RETRIES = 8;
const VIDEO_BROWSER_STYLE_ID = "xiaofu-video-source-browser-style";
const CLIP_MAP_ROW_HEIGHT = 18;
const CLIP_MAP_HEADER_HEIGHT = 24;

let activeVideoCompareWidget = null;
let shortcutsInstalled = false;
let videoFolderWarningListenerInstalled = false;
let videoCompareNodeType = null;

function slotName(prefix, index) {
  return `${prefix}${String(index + 1).padStart(2, "0")}`;
}

function isNodes2Enabled() {
  return (
    app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled") === true ||
    globalThis.LiteGraph?.vueNodesMode === true
  );
}

function inputUsesPrefix(input, prefix) {
  return input?.name?.startsWith(prefix);
}

function isVideoCompareInput(input) {
  return inputUsesPrefix(input, FRAME_SLOT_PREFIX) || inputUsesPrefix(input, NATIVE_SLOT_PREFIX);
}

function isXiaoFuVideoFolderNode(node) {
  return (
    node?.constructor?.comfyClass === VIDEO_FOLDER_NODE_ID ||
    node?.comfyClass === VIDEO_FOLDER_NODE_ID ||
    node?.type === VIDEO_FOLDER_NODE_ID
  );
}

function getInputsByPrefix(node, prefix) {
  return (node.inputs || [])
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => inputUsesPrefix(input, prefix));
}

function getVideoCompareInputs(node) {
  return (node.inputs || [])
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => isVideoCompareInput(input));
}

function renameInputsByPrefix(node, prefix, type) {
  for (const [index, item] of getInputsByPrefix(node, prefix).entries()) {
    item.input.name = slotName(prefix, index);
    item.input.label = slotName(prefix, index);
    item.input.type = type;
  }
}

function addInputByPrefix(node, prefix, type) {
  const count = getInputsByPrefix(node, prefix).length;
  node.addInput(slotName(prefix, count), type);
  renameInputsByPrefix(node, prefix, type);
  node.setDirtyCanvas?.(true, true);
}

function addFrameInput(node) {
  addInputByPrefix(node, FRAME_SLOT_PREFIX, "IMAGE");
}

function addNativeVideoInput(node) {
  addInputByPrefix(node, NATIVE_SLOT_PREFIX, "*");
}

function stabilizeVideoInputs(node) {
  if (!node.inputs) {
    return;
  }

  let nativeInputs = getInputsByPrefix(node, NATIVE_SLOT_PREFIX);
  while (nativeInputs.length < MIN_NATIVE_INPUTS) {
    addNativeVideoInput(node);
    nativeInputs = getInputsByPrefix(node, NATIVE_SLOT_PREFIX);
  }

  let highestLinkedNative = -1;
  for (const [position, item] of nativeInputs.entries()) {
    if (item.input.link != null) {
      highestLinkedNative = position;
    }
  }

  const desiredNativeCount = Math.max(MIN_NATIVE_INPUTS, highestLinkedNative + 2);
  while (nativeInputs.length > desiredNativeCount) {
    const last = nativeInputs[nativeInputs.length - 1];
    if (!last || last.input.link != null) {
      break;
    }
    node.removeInput(last.index);
    nativeInputs = getInputsByPrefix(node, NATIVE_SLOT_PREFIX);
  }

  while (nativeInputs.length < desiredNativeCount) {
    addNativeVideoInput(node);
    nativeInputs = getInputsByPrefix(node, NATIVE_SLOT_PREFIX);
  }

  let frameInputs = getInputsByPrefix(node, FRAME_SLOT_PREFIX);
  let highestLinkedFrame = -1;
  for (const [position, item] of frameInputs.entries()) {
    if (item.input.link != null) {
      highestLinkedFrame = position;
    }
  }

  const desiredFrameCount = Math.max(MIN_FRAME_INPUTS, highestLinkedFrame >= 0 ? highestLinkedFrame + 2 : 0);
  while (frameInputs.length > desiredFrameCount) {
    const last = frameInputs[frameInputs.length - 1];
    if (!last || last.input.link != null) {
      break;
    }
    node.removeInput(last.index);
    frameInputs = getInputsByPrefix(node, FRAME_SLOT_PREFIX);
  }

  while (frameInputs.length < desiredFrameCount) {
    addFrameInput(node);
    frameInputs = getInputsByPrefix(node, FRAME_SLOT_PREFIX);
  }

  renameInputsByPrefix(node, NATIVE_SLOT_PREFIX, "*");
  renameInputsByPrefix(node, FRAME_SLOT_PREFIX, "IMAGE");
  node.setDirtyCanvas?.(true, true);
}

function removeEmptyVideoInputs(node) {
  const allInputs = getVideoCompareInputs(node);
  for (let i = allInputs.length - 1; i >= 0; i--) {
    const item = allInputs[i];
    const nativeInputs = getInputsByPrefix(node, NATIVE_SLOT_PREFIX);
    const isRequiredNativeInput =
      inputUsesPrefix(item.input, NATIVE_SLOT_PREFIX) &&
      nativeInputs.findIndex((native) => native.input === item.input) < MIN_NATIVE_INPUTS;
    if (!isRequiredNativeInput && item?.input.link == null) {
      node.removeInput(item.index);
    }
  }
  stabilizeVideoInputs(node);
}

function imageDataToUrl(data) {
  if (data.url) {
    return data.url;
  }
  return api.apiURL(
    `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type || "temp"}&subfolder=${
      data.subfolder || ""
    }${app.getPreviewFormatParam?.() || ""}${app.getRandParam?.() || ""}`,
  );
}

function videoDataToUrl(data) {
  const url = data?.video_url || data?.source_url;
  if (!url) {
    return "";
  }
  if (/^(https?:|blob:|data:)/i.test(url)) {
    return url;
  }
  return api.apiURL(url);
}

function isSourceVideo(video) {
  return !!video?.sourceUrl;
}

function canvasLooksMostlyBlack(canvas) {
  if (!canvas?.width || !canvas?.height) {
    return false;
  }
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const sampleWidth = Math.min(48, canvas.width);
    const sampleHeight = Math.min(48, canvas.height);
    const imageData = context.getImageData(
      Math.floor((canvas.width - sampleWidth) / 2),
      Math.floor((canvas.height - sampleHeight) / 2),
      sampleWidth,
      sampleHeight,
    ).data;
    let darkPixels = 0;
    let sampledPixels = 0;
    for (let index = 0; index < imageData.length; index += 16) {
      const luminance = imageData[index] + imageData[index + 1] + imageData[index + 2];
      if (luminance < 18) {
        darkPixels += 1;
      }
      sampledPixels += 1;
    }
    return sampledPixels > 0 && darkPixels / sampledPixels > 0.96;
  } catch (error) {
    return false;
  }
}

function normalizeHiddenIds(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function splitFromPoint(x, bounds) {
  const snap = Math.min(0.08, EDGE_SNAP_PX / Math.max(1, bounds.w));
  const value = (x - bounds.x) / bounds.w;
  if (value <= snap) {
    return 0;
  }
  if (value >= 1 - snap) {
    return 1;
  }
  return clamp(value, 0, 1);
}

function isPoint(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

function pointFromValue(value) {
  if (isPoint(value)) {
    return [Number(value[0]), Number(value[1])];
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [xKey, yKey] of [
    ["x", "y"],
    ["canvasX", "canvasY"],
    ["localX", "localY"],
    ["offsetX", "offsetY"],
  ]) {
    if (Number.isFinite(Number(value[xKey])) && Number.isFinite(Number(value[yKey]))) {
      return [Number(value[xKey]), Number(value[yKey])];
    }
  }

  return null;
}

function findPoint(values) {
  for (const value of values) {
    const point = pointFromValue(value);
    if (point) {
      return point;
    }
  }
  return null;
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let fitted = text;
  while (fitted.length > 1 && ctx.measureText(`${fitted}...`).width > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted}...`;
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}`;
}

function formatSizeMb(sizeMb) {
  const size = Number(sizeMb || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(size >= 10240 ? 0 : 1)} GB`;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} MB`;
}

function isTypingTarget(event) {
  const tagName = event?.target?.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || event?.target?.isContentEditable;
}

function isVideoBrowserTarget(event) {
  return event?.target?.closest?.(".xf-video-browser") != null;
}

function isPlayPauseShortcut(event) {
  return event.key === " " || event.key === "Spacebar" || event.code === "Space";
}

function isPreviousFrameShortcut(event) {
  return event.key === "ArrowLeft" || event.code === "ArrowLeft";
}

function isNextFrameShortcut(event) {
  return event.key === "ArrowRight" || event.code === "ArrowRight";
}

function consumeShortcut(event) {
  event.preventDefault();
  event.stopPropagation?.();
}

function handleGlobalShortcut(event) {
  if (isNodes2Enabled() || isTypingTarget(event) || isVideoBrowserTarget(event) || !activeVideoCompareWidget) {
    return;
  }
  if (activeVideoCompareWidget.handleShortcut(event)) {
    event.stopImmediatePropagation?.();
  }
}

function getNodeFromExecutionId(nodeId) {
  const graph = app.graph || app.canvas?.graph;
  const id = Number(nodeId);
  if (!graph || !Number.isFinite(id)) {
    return null;
  }
  return graph.getNodeById?.(id) || null;
}

function showVideoFolderWarnings(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) {
    return;
  }

  const detail = warnings.join(" | ");
  const toast = app.extensionManager?.toast;
  if (toast?.add) {
    toast.add({
      severity: "warn",
      summary: "XiaoFu Video Folder",
      detail,
      life: 9000,
    });
    return;
  }

  console.warn(`[XiaoFu Video Folder] ${detail}`);
}

function getVideoSourceWidget(node) {
  return (node.widgets || []).find((widget) => widget.name === "folder_path");
}

function setVideoSourcePaths(node, paths) {
  const widget = getVideoSourceWidget(node);
  if (!widget) {
    showVideoFolderWarnings(["The source path widget is missing on this node."]);
    return;
  }

  widget.value = (paths || []).join("\n");
  widget.callback?.(widget.value);
  updateVideoFolderOutputLabels(node);
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function basenameFromPath(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function truncateMiddle(text, maxLength = 34) {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

function splitSelectedVideoSources(node) {
  const widget = getVideoSourceWidget(node);
  return String(widget?.value || "")
    .split(/\r?\n/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function isVideoPath(path) {
  return /\.(mp4|mov|mkv|webm|m4v)$/i.test(String(path || ""));
}

function baseClipName(index) {
  return slotName(NATIVE_SLOT_PREFIX, index);
}

function labelForClip(index, filename, sizeMb) {
  const clip = baseClipName(index);
  if (!filename) {
    return clip;
  }
  const sizeText = formatSizeMb(sizeMb);
  const info = sizeText ? `${filename} · ${sizeText}` : filename;
  return `${truncateMiddle(info, 32)} · ${clip}`;
}

function ensureVideoFolderOutputs(node) {
  node.outputs = node.outputs || [];
  while (node.outputs.length < VIDEO_FOLDER_OUTPUT_COUNT && typeof node.addOutput === "function") {
    node.addOutput(baseClipName(node.outputs.length), "VIDEO");
  }

  for (let index = 0; index < Math.min(node.outputs.length, VIDEO_FOLDER_OUTPUT_COUNT); index++) {
    node.outputs[index].type = "VIDEO";
  }
}

function applyVideoFolderOutputLabels(node, filenames = []) {
  node.__xiaofuVideoFolderFilenames = filenames.slice(0, VIDEO_FOLDER_OUTPUT_COUNT);
  const previousDetails = node.__xiaofuVideoFolderDetails || [];
  node.__xiaofuVideoFolderDetails = node.__xiaofuVideoFolderFilenames.map((filename, index) =>
    previousDetails[index]?.name === filename ? previousDetails[index] : null,
  );
  ensureVideoFolderOutputs(node);
  for (let index = 0; index < Math.min(node.outputs?.length || 0, VIDEO_FOLDER_OUTPUT_COUNT); index++) {
    const detail = node.__xiaofuVideoFolderDetails?.[index] || null;
    const label = labelForClip(index, filenames[index], detail?.size_mb);
    node.outputs[index].name = label;
    node.outputs[index].label = label;
  }
  node.setDirtyCanvas?.(true, true);
}

function applyVideoFolderOutputDetails(node, details = []) {
  const normalized = details.slice(0, VIDEO_FOLDER_OUTPUT_COUNT).map((detail, index) => ({
    clip: detail.clip || baseClipName(index),
    path: detail.path || "",
    name: detail.name || basenameFromPath(detail.path),
    size_mb: detail.size_mb,
  }));
  node.__xiaofuVideoFolderDetails = normalized;
  applyVideoFolderOutputLabels(
    node,
    normalized.map((detail) => detail.name),
  );
}

function createLinkedVideoCompareNode(folderNode) {
  const graph = app.graph || app.canvas?.graph;
  const LiteGraph = globalThis.LiteGraph;
  const compareNode = LiteGraph?.createNode?.(NODE_ID) || (videoCompareNodeType ? new videoCompareNodeType() : null);
  if (!graph || !compareNode) {
    showVideoFolderWarnings(["Could not create the video compare node in this ComfyUI frontend."]);
    return;
  }

  compareNode.pos = [
    Number(folderNode.pos?.[0] || 0) + Number(folderNode.size?.[0] || 360) + 120,
    Number(folderNode.pos?.[1] || 0),
  ];
  graph.add(compareNode);
  stabilizeVideoInputs(compareNode);

  const filenames = folderNode.__xiaofuVideoFolderFilenames || [];
  const outputIndex = Math.max(0, filenames.findIndex(Boolean));
  const inputIndex = getInputsByPrefix(compareNode, NATIVE_SLOT_PREFIX)[0]?.index;
  if (Number.isFinite(inputIndex) && folderNode.outputs?.[outputIndex]) {
    folderNode.connect?.(outputIndex, compareNode, inputIndex);
  }

  compareNode.setDirtyCanvas?.(true, true);
  folderNode.setDirtyCanvas?.(true, true);
  graph.setDirtyCanvas?.(true, true);
  app.canvas?.selectNode?.(compareNode);
}

function clearVideoFolderLinks(folderNode) {
  const graph = folderNode.graph || app.graph || app.canvas?.graph;
  const linkIds = new Set();

  for (const output of folderNode.outputs || []) {
    for (const linkId of output?.links || []) {
      if (linkId != null) {
        linkIds.add(linkId);
      }
    }
  }

  if (!linkIds.size) {
    showVideoFolderWarnings(["No video links to clear on this node."]);
    return;
  }

  let removedCount = 0;
  for (const linkId of linkIds) {
    const link = graph?.links?.[linkId];
    const targetNode = link ? graph?.getNodeById?.(link.target_id) : null;
    if (targetNode?.disconnectInput && Number.isFinite(Number(link?.target_slot))) {
      targetNode.disconnectInput(link.target_slot);
      removedCount += 1;
    } else if (graph?.removeLink) {
      graph.removeLink(linkId);
      removedCount += 1;
    }
  }

  if (!removedCount && typeof folderNode.disconnectOutput === "function") {
    for (let index = 0; index < (folderNode.outputs || []).length; index++) {
      folderNode.disconnectOutput(index);
    }
  }

  folderNode.setDirtyCanvas?.(true, true);
  graph?.setDirtyCanvas?.(true, true);
}

class VideoFolderClipMapWidget {
  constructor(node) {
    this.name = "xiaofu_video_folder_clip_map";
    this.type = "custom";
    this.options = {};
    this.node = node;
    this.y = 0;
    this.last_y = 0;
  }

  getRows() {
    const details = this.node.__xiaofuVideoFolderDetails || [];
    return (this.node.__xiaofuVideoFolderFilenames || [])
      .slice(0, VIDEO_FOLDER_OUTPUT_COUNT)
      .map((filename, index) => ({ clip: baseClipName(index), filename, size_mb: details[index]?.size_mb }))
      .filter((item) => item.filename);
  }

  computeSize(width) {
    const rowCount = Math.max(1, this.getRows().length);
    return [width, CLIP_MAP_HEADER_HEIGHT + rowCount * CLIP_MAP_ROW_HEIGHT + 8];
  }

  draw(ctx, node, width, y) {
    this.y = y;
    this.last_y = y;
    const rows = this.getRows();
    const left = 10;
    const right = Math.max(left + 10, width - 10);

    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(235,235,235,0.82)";
    ctx.fillText("Clip Map", left, y + 12);

    if (!rows.length) {
      ctx.fillStyle = "rgba(220,220,220,0.55)";
      ctx.fillText("Choose videos to show clip mapping", left, y + CLIP_MAP_HEADER_HEIGHT + 8);
      ctx.restore();
      return;
    }

    ctx.font = "11px Arial";
    rows.forEach((row, index) => {
      const rowY = y + CLIP_MAP_HEADER_HEIGHT + index * CLIP_MAP_ROW_HEIGHT + CLIP_MAP_ROW_HEIGHT / 2;
      ctx.fillStyle = "rgba(135, 230, 158, 0.95)";
      ctx.fillText(row.clip, left, rowY);
      ctx.fillStyle = "rgba(235,235,235,0.84)";
      const sizeText = formatSizeMb(row.size_mb);
      const fileLabel = sizeText ? `${row.filename} · ${sizeText}` : row.filename;
      const fileText = truncateMiddle(fileLabel, Math.max(18, Math.floor((right - left - 62) / 7)));
      ctx.fillText(fileText, left + 62, rowY);
    });
    ctx.restore();
  }
}

async function updateVideoFolderOutputLabels(node) {
  const sources = splitSelectedVideoSources(node);
  if (!sources.length) {
    applyVideoFolderOutputLabels(node);
    return;
  }

  const token = Symbol("folderLabelRequest");
  node.__xiaofuVideoFolderLabelRequest = token;

  if (sources.length > 1 || isVideoPath(sources[0])) {
    applyVideoFolderOutputLabels(node, sources.slice(0, VIDEO_FOLDER_OUTPUT_COUNT).map(basenameFromPath));
    const info = await fetchVideoSourceInfo(sources);
    if (node.__xiaofuVideoFolderLabelRequest === token && info?.success) {
      applyVideoFolderOutputDetails(node, info.sources || []);
    }
    if (sources.length > VIDEO_FOLDER_OUTPUT_COUNT) {
      showVideoFolderWarnings([`Only the first ${VIDEO_FOLDER_OUTPUT_COUNT} selected videos are exposed as clip outputs.`]);
    }
    return;
  }

  applyVideoFolderOutputLabels(node);
  const [data, info] = await Promise.all([fetchVideoBrowserPath(sources[0]), fetchVideoSourceInfo(sources)]);
  if (node.__xiaofuVideoFolderLabelRequest !== token) {
    return;
  }
  if (info?.success) {
    applyVideoFolderOutputDetails(node, info.sources || []);
  } else if (data?.success) {
    const filenames = (data.entries || [])
      .filter((entry) => entry.is_video)
      .slice(0, VIDEO_FOLDER_OUTPUT_COUNT)
      .map((entry) => entry.name);
    applyVideoFolderOutputLabels(node, filenames);
  }
}

function ensureVideoBrowserStyle() {
  if (document.getElementById(VIDEO_BROWSER_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = VIDEO_BROWSER_STYLE_ID;
  style.textContent = `
.xf-video-browser {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.48);
  color: #f2f2f2;
  font: 13px Arial, sans-serif;
}
.xf-video-browser * {
  box-sizing: border-box;
}
.xf-video-browser__panel {
  width: min(860px, calc(100vw - 40px));
  height: min(680px, calc(100vh - 40px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: #242424;
  box-shadow: 0 18px 58px rgba(0, 0, 0, 0.46);
}
.xf-video-browser__header,
.xf-video-browser__toolbar,
.xf-video-browser__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.xf-video-browser__title {
  flex: 1;
  min-width: 0;
  font-weight: 700;
}
.xf-video-browser__path {
  flex: 1;
  min-width: 0;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
  background: #171717;
  color: #f2f2f2;
  padding: 0 9px;
}
.xf-video-browser__roots {
  min-width: 160px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
  background: #171717;
  color: #f2f2f2;
}
.xf-video-browser button {
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 5px;
  background: #363636;
  color: #f2f2f2;
  padding: 0 12px;
  cursor: pointer;
}
.xf-video-browser button:hover {
  background: #464646;
}
.xf-video-browser button:disabled {
  opacity: 0.42;
  cursor: default;
}
.xf-video-browser__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: #151515;
}
.xf-video-browser__row {
  width: 100%;
  min-height: 34px;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  cursor: pointer;
}
.xf-video-browser__row:hover {
  background: rgba(255, 255, 255, 0.06);
}
.xf-video-browser__row.is-selected {
  background: rgba(96, 165, 250, 0.24);
}
.xf-video-browser__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xf-video-browser__meta {
  color: rgba(242, 242, 242, 0.58);
  font-size: 12px;
}
.xf-video-browser__empty,
.xf-video-browser__error {
  padding: 18px;
  color: rgba(242, 242, 242, 0.7);
}
.xf-video-browser__error {
  color: #ffb4a8;
}
.xf-video-browser__footer-note {
  flex: 1;
  min-width: 0;
  color: rgba(242, 242, 242, 0.66);
}
`;
  document.head.appendChild(style);
}

async function fetchVideoBrowserPath(path) {
  try {
    const response = await api.fetchApi("/xiaofu-image-compare/video-sources/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: error?.message || String(error), entries: [], roots: [] };
  }
}

async function fetchVideoSourceInfo(paths) {
  try {
    const response = await api.fetchApi("/xiaofu-image-compare/video-sources/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: error?.message || String(error), sources: [] };
  }
}

async function chooseNativeVideoSources(node, mode) {
  try {
    const response = await api.fetchApi("/xiaofu-image-compare/video-sources/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await response.json();
    if (data?.success) {
      if (Array.isArray(data.paths) && data.paths.length) {
        setVideoSourcePaths(node, data.paths);
      }
      return;
    }

    showVideoFolderWarnings([`${data?.error || "Native picker failed."} Falling back to the in-page browser.`]);
    openVideoSourceBrowser(node, mode);
  } catch (error) {
    showVideoFolderWarnings([`${error?.message || String(error)} Falling back to the in-page browser.`]);
    openVideoSourceBrowser(node, mode);
  }
}

function videoBrowserTitle(mode) {
  if (mode === "folder") {
    return "Choose Video Folder";
  }
  if (mode === "file") {
    return "Choose Video";
  }
  return "Choose Videos";
}

function openVideoSourceBrowser(node, mode) {
  ensureVideoBrowserStyle();

  const selected = new Set();
  let currentPath = "";
  let lastData = null;

  const overlay = document.createElement("div");
  overlay.className = "xf-video-browser";

  const panel = document.createElement("div");
  panel.className = "xf-video-browser__panel";

  const header = document.createElement("div");
  header.className = "xf-video-browser__header";
  const title = document.createElement("div");
  title.className = "xf-video-browser__title";
  title.textContent = videoBrowserTitle(mode);
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  header.append(title, closeButton);

  const toolbar = document.createElement("div");
  toolbar.className = "xf-video-browser__toolbar";
  const upButton = document.createElement("button");
  upButton.type = "button";
  upButton.textContent = "Up";
  const rootsSelect = document.createElement("select");
  rootsSelect.className = "xf-video-browser__roots";
  const pathInput = document.createElement("input");
  pathInput.className = "xf-video-browser__path";
  pathInput.type = "text";
  const goButton = document.createElement("button");
  goButton.type = "button";
  goButton.textContent = "Go";
  toolbar.append(upButton, rootsSelect, pathInput, goButton);

  const list = document.createElement("div");
  list.className = "xf-video-browser__list";

  const footer = document.createElement("div");
  footer.className = "xf-video-browser__footer";
  const footerNote = document.createElement("div");
  footerNote.className = "xf-video-browser__footer-note";
  const chooseFolderButton = document.createElement("button");
  chooseFolderButton.type = "button";
  chooseFolderButton.textContent = "Use Current Folder";
  const chooseSelectedButton = document.createElement("button");
  chooseSelectedButton.type = "button";
  chooseSelectedButton.textContent = mode === "file" ? "Use Video" : "Use Selected";
  footer.append(footerNote);
  if (mode === "folder") {
    footer.append(chooseFolderButton);
  } else {
    footer.append(chooseSelectedButton);
  }

  panel.append(header, toolbar, list, footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  function updateFooter() {
    if (mode === "folder") {
      footerNote.textContent = currentPath || "";
      return;
    }
    const count = selected.size;
    const selectedSize = (lastData?.entries || [])
      .filter((entry) => selected.has(entry.path))
      .reduce((total, entry) => total + Number(entry.size_mb || 0), 0);
    const sizeText = formatSizeMb(selectedSize);
    footerNote.textContent = count ? `${count} selected${sizeText ? ` · ${sizeText}` : ""}` : "Select video files";
    chooseSelectedButton.disabled = count === 0;
  }

  function applySelection(paths) {
    if (!paths.length) {
      return;
    }
    setVideoSourcePaths(node, paths);
    close();
  }

  function renderRoots(roots) {
    rootsSelect.replaceChildren();
    for (const root of roots || []) {
      const option = document.createElement("option");
      option.value = root.path;
      option.textContent = root.name;
      rootsSelect.appendChild(option);
    }
  }

  function renderList(data) {
    list.replaceChildren();
    if (data.error) {
      const error = document.createElement("div");
      error.className = "xf-video-browser__error";
      error.textContent = data.error;
      list.appendChild(error);
    }

    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "xf-video-browser__empty";
      empty.textContent = "No video files in this folder";
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "xf-video-browser__row";
      if (selected.has(entry.path)) {
        row.classList.add("is-selected");
      }

      const icon = document.createElement("div");
      icon.textContent = entry.is_dir ? "Dir" : "Video";
      const name = document.createElement("div");
      name.className = "xf-video-browser__name";
      name.textContent = entry.name;
      name.title = entry.path;
      const meta = document.createElement("div");
      meta.className = "xf-video-browser__meta";
      meta.textContent = entry.is_dir ? "" : formatSizeMb(entry.size_mb);
      row.append(icon, name, meta);

      row.addEventListener("click", () => {
        if (entry.is_dir) {
          loadPath(entry.path);
          return;
        }
        if (!entry.is_video || mode === "folder") {
          return;
        }
        if (mode === "file") {
          selected.clear();
          selected.add(entry.path);
        } else if (selected.has(entry.path)) {
          selected.delete(entry.path);
        } else {
          selected.add(entry.path);
        }
        renderList(lastData);
        updateFooter();
      });

      row.addEventListener("dblclick", () => {
        if (entry.is_video && mode === "file") {
          applySelection([entry.path]);
        }
      });

      list.appendChild(row);
    }
  }

  async function loadPath(path) {
    list.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "xf-video-browser__empty";
    loading.textContent = "Loading...";
    list.appendChild(loading);

    const data = await fetchVideoBrowserPath(path);
    if (!data?.success) {
      showVideoFolderWarnings([data?.error || "Could not list this folder."]);
      list.replaceChildren();
      const error = document.createElement("div");
      error.className = "xf-video-browser__error";
      error.textContent = data?.error || "Could not list this folder.";
      list.appendChild(error);
      return;
    }

    currentPath = data.path || "";
    lastData = data;
    pathInput.value = currentPath;
    renderRoots(data.roots || []);
    rootsSelect.value = (data.roots || []).some((root) => root.path === currentPath) ? currentPath : "";
    upButton.disabled = !data.parent;
    renderList(data);
    updateFooter();
  }

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  upButton.addEventListener("click", () => {
    if (lastData?.parent) {
      loadPath(lastData.parent);
    }
  });
  rootsSelect.addEventListener("change", () => loadPath(rootsSelect.value));
  goButton.addEventListener("click", () => loadPath(pathInput.value));
  pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      loadPath(pathInput.value);
    }
  });
  chooseFolderButton.addEventListener("click", () => applySelection([currentPath]));
  chooseSelectedButton.addEventListener("click", () => applySelection([...selected]));

  updateFooter();
  loadPath(getVideoSourceWidget(node)?.value?.split?.("\n")?.[0] || "");
}

function installVideoFolderPickerWidgets(node) {
  if (node.__xiaofuVideoFolderPickerWidgets) {
    return;
  }
  node.__xiaofuVideoFolderPickerWidgets = true;

  ensureVideoFolderOutputs(node);
  const sourceWidget = getVideoSourceWidget(node);
  if (sourceWidget && !sourceWidget.__xiaofuVideoFolderLabelHooked) {
    sourceWidget.__xiaofuVideoFolderLabelHooked = true;
    const originalCallback = sourceWidget.callback;
    sourceWidget.callback = function () {
      const result = originalCallback?.apply(this, arguments);
      updateVideoFolderOutputLabels(node);
      return result;
    };
  }

  node.addWidget?.("button", "Choose Video", null, () => chooseNativeVideoSources(node, "file"));
  node.addWidget?.("button", "Choose Videos", null, () => chooseNativeVideoSources(node, "files"));
  node.addWidget?.("button", "Choose Folder", null, () => chooseNativeVideoSources(node, "folder"));
  node.addWidget?.("button", "Browse In Page", null, () => openVideoSourceBrowser(node, "files"));
  node.addWidget?.("button", "Create + Link Compare", null, () => createLinkedVideoCompareNode(node));
  node.addWidget?.("button", "Clear Links", null, () => clearVideoFolderLinks(node));
  if (!node.__xiaofuVideoFolderClipMapWidget) {
    const clipMapWidget = new VideoFolderClipMapWidget(node);
    node.__xiaofuVideoFolderClipMapWidget = clipMapWidget;
    if (typeof node.addCustomWidget === "function") {
      node.addCustomWidget(clipMapWidget);
    } else {
      node.widgets = node.widgets || [];
      node.widgets.push(clipMapWidget);
    }
  }
  updateVideoFolderOutputLabels(node);
  node.setDirtyCanvas?.(true, true);
}

function installVideoFolderWarningListener() {
  if (videoFolderWarningListenerInstalled) {
    return;
  }
  videoFolderWarningListenerInstalled = true;

  api.addEventListener("executed", (event) => {
    const detail = event.detail || {};
    const node = getNodeFromExecutionId(detail.display_node || detail.node);
    if (!isXiaoFuVideoFolderNode(node)) {
      return;
    }
    showVideoFolderWarnings(detail.output?.xiaofu_video_folder_warnings || []);
  });
}

class MultiVideoCompareWidget {
  constructor(node) {
    this.name = WIDGET_NAME;
    this.type = "custom";
    this.options = {};
    this.y = 0;
    this.last_y = 0;
    this.node = node;
    this.hitAreas = [];
    this.previewBounds = null;
    this.playTimer = null;
    this.animationFrame = null;
    this.lastStatus = "Run the node to show original videos";
    this.seekFallbackTimers = new WeakMap();
    this._value = {
      videos: [],
      leftId: null,
      rightId: null,
      hiddenIds: [],
      splitX: 0.5,
      frameIndex: 0,
      playing: false,
    };
  }

  get value() {
    return this._value;
  }

  set value(nextValue) {
    const value = nextValue || {};
    const videos = Array.isArray(value.videos) ? value.videos : [];
    this._value = {
      videos: videos.map((video, index) => this.prepareVideoRecord(video, index)),
      leftId: value.leftId || null,
      rightId: value.rightId || null,
      hiddenIds: normalizeHiddenIds(value.hiddenIds),
      splitX: Number.isFinite(value.splitX) ? clamp(value.splitX, 0, 1) : 0.5,
      frameIndex: Number.isFinite(value.frameIndex) ? Math.max(0, Math.floor(value.frameIndex)) : 0,
      playing: value.playing === true,
    };
    this.ensureSelection();
    this.ensureFrameIndex();
    this.requestDraw(true);
    this.syncPlaybackTimer();
  }

  prepareVideoRecord(video, index) {
    const frames = Array.isArray(video.frames)
      ? video.frames.map((frame) => ({ ...frame, url: imageDataToUrl(frame) }))
      : [];
    const id = video.id || video.source_slot || slotName(NATIVE_SLOT_PREFIX, index);
    const sourceUrl = videoDataToUrl(video);
    return {
      ...video,
      id,
      name: video.name || video.source_slot || slotName(NATIVE_SLOT_PREFIX, index),
      frame_count: frames.length,
      frames,
      sourceUrl,
      playback_mode: sourceUrl ? "source" : video.playback_mode,
    };
  }

  setVideos(serverVideos) {
    const previous = this._value;
    const previousHidden = new Set(previous.hiddenIds || []);
    const videos = (serverVideos || []).map((video, index) => this.prepareVideoRecord(video, index));
    const ids = new Set(videos.map((video) => video.id));
    this.lastStatus = videos.length ? "" : "No playable video data returned. Check the connected clip output.";

    this._value = {
      videos,
      leftId: ids.has(previous.leftId) ? previous.leftId : null,
      rightId: ids.has(previous.rightId) ? previous.rightId : null,
      hiddenIds: [...previousHidden].filter((id) => ids.has(id)),
      splitX: Number.isFinite(previous.splitX) ? previous.splitX : 0.5,
      frameIndex: Number.isFinite(previous.frameIndex) ? previous.frameIndex : 0,
      playing: previous.playing === true,
    };

    this.ensureSelection();
    this.ensureFrameIndex();
    this.preloadVisibleVideoFrames();
    this.requestDraw(true);
    this.syncPlaybackTimer();
  }

  getVisibleVideos() {
    const hidden = new Set(this._value.hiddenIds || []);
    return this._value.videos.filter((video) => !hidden.has(video.id));
  }

  getVideoById(id) {
    return this._value.videos.find((video) => video.id === id);
  }

  get leftVideo() {
    return this.getVideoById(this._value.leftId);
  }

  get rightVideo() {
    return this.getVideoById(this._value.rightId);
  }

  hasSourcePlayback() {
    return isSourceVideo(this.leftVideo) || isSourceVideo(this.rightVideo);
  }

  getVideoElement(video) {
    if (!isSourceVideo(video)) {
      return null;
    }
    if (video.element && video.element.getAttribute("src") === video.sourceUrl) {
      return video.element;
    }

    const element = document.createElement("video");
    element.preload = "metadata";
    element.muted = true;
    element.playsInline = true;
    element.loop = true;
    element.src = video.sourceUrl;

    video.status = "Loading original video";
    element.addEventListener("loadedmetadata", () => {
      video.duration = Number.isFinite(element.duration) ? element.duration : video.duration;
      video.width = element.videoWidth || video.width;
      video.height = element.videoHeight || video.height;
      video.status = "Ready";
      this.ensureFrameIndex();
      this.requestDraw(true);
    });
    element.addEventListener("loadeddata", () => {
      video.status = "Ready";
      this.requestDraw();
    });
    element.addEventListener("canplay", () => {
      video.status = "Ready";
      this.requestDraw();
    });
    element.addEventListener("error", () => {
      video.status = "Could not load original video";
      this.setPlaying(false);
      this.requestDraw();
    });
    element.addEventListener("timeupdate", () => this.updateFrameIndexFromSource());
    video.element = element;
    element.load?.();
    return element;
  }

  captureSourceFrame(video, element, { seeking = false, prefer = null } = {}) {
    if (!video || !element || element.readyState < 2 || !element.videoWidth || !element.videoHeight) {
      return false;
    }
    try {
      const canvas = document.createElement("canvas");
      if (canvas.width !== element.videoWidth || canvas.height !== element.videoHeight) {
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
      }
      canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height);
      if (video.seekSnapshot && canvasLooksMostlyBlack(canvas)) {
        if (seeking) {
          video.isSeeking = true;
        }
        if (prefer !== null) {
          video.preferSnapshot = prefer;
        }
        return false;
      }
      video.seekSnapshot = canvas;
      video.isSeeking = seeking;
      if (prefer !== null) {
        video.preferSnapshot = prefer;
      }
      return true;
    } catch (error) {
      if (!video.seekSnapshot) {
        video.isSeeking = false;
      }
      return false;
    }
  }

  finishSourceSeek(video, element) {
    if (!video || !element) {
      return;
    }

    const previousTimer = this.seekFallbackTimers.get(element);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const token = Symbol("source-seek");
    video.seekToken = token;
    const finish = (attempt = 0) => {
      if (video.seekToken !== token) {
        return;
      }

      const activeTimer = this.seekFallbackTimers.get(element);
      if (activeTimer) {
        clearTimeout(activeTimer);
        this.seekFallbackTimers.delete(element);
      }

      const captured = this.captureSourceFrame(video, element, {
        seeking: false,
        prefer: !this._value.playing,
      });

      if (!captured && attempt < SOURCE_SEEK_MAX_RETRIES) {
        video.isSeeking = true;
        const retryTimer = setTimeout(() => finish(attempt + 1), SOURCE_SEEK_RETRY_MS);
        this.seekFallbackTimers.set(element, retryTimer);
        this.requestDraw();
        return;
      }

      video.isSeeking = false;
      video.snapshotHoldUntil =
        this._value.playing || !captured ? performance.now() + SOURCE_SEEK_HOLD_MS : 0;
      this.requestDraw();
    };
    const fallbackTimer = setTimeout(() => finish(0), SOURCE_SEEK_RETRY_MS);
    this.seekFallbackTimers.set(element, fallbackTimer);

    if (typeof element.requestVideoFrameCallback === "function") {
      try {
        element.requestVideoFrameCallback(() => {
          finish(0);
        });
      } catch (error) {
        // The timeout above clears the hold frame if frame callbacks are unavailable.
      }
    }
  }

  captureVisibleSourceSnapshots(prefer = false) {
    for (const video of [this.leftVideo, this.rightVideo]) {
      const element = this.getVideoElement(video);
      if (element) {
        this.captureSourceFrame(video, element, { seeking: false, prefer });
      }
    }
  }

  clearSourceSnapshotPreference() {
    for (const video of [this.leftVideo, this.rightVideo]) {
      if (video) {
        video.preferSnapshot = false;
        video.snapshotHoldUntil = 0;
      }
    }
  }

  getSourceSnapshot(video) {
    if (!video?.seekSnapshot) {
      return null;
    }
    const holdUntil = Number(video.snapshotHoldUntil || 0);
    if (video.isSeeking || video.preferSnapshot || holdUntil > performance.now()) {
      return video.seekSnapshot;
    }
    return null;
  }

  getVideoDuration(video) {
    const element = this.getVideoElement(video);
    const duration = Number(element?.duration || video?.duration || 0);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  getTimelineDuration() {
    const durations = [this.leftVideo, this.rightVideo].map((video) => this.getVideoDuration(video));
    return Math.max(0, ...durations);
  }

  getSourceFps() {
    const fpsValues = [this.leftVideo?.fps, this.rightVideo?.fps]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    return fpsValues.length ? Math.min(...fpsValues) : 30;
  }

  getMaxFrameCount() {
    if (this.hasSourcePlayback()) {
      const duration = this.getTimelineDuration();
      return duration > 0 ? Math.max(2, Math.round(duration * this.getSourceFps())) : 2;
    }

    const counts = [this.leftVideo, this.rightVideo]
      .filter(Boolean)
      .map((video) => video.frames?.length || 0);
    return Math.max(0, ...counts);
  }

  getDisplayFps() {
    const fpsValues = [this.leftVideo?.fps, this.rightVideo?.fps]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!fpsValues.length) {
      return 12;
    }
    return clamp(Math.min(...fpsValues), 1, 60);
  }

  ensureSelection() {
    const visibleVideos = this.getVisibleVideos();
    if (!visibleVideos.length) {
      this._value.leftId = null;
      this._value.rightId = null;
      return;
    }

    if (!visibleVideos.some((video) => video.id === this._value.leftId)) {
      this._value.leftId = visibleVideos[0].id;
    }

    if (
      !visibleVideos.some((video) => video.id === this._value.rightId) ||
      this._value.rightId === this._value.leftId
    ) {
      this._value.rightId =
        visibleVideos.find((video) => video.id !== this._value.leftId)?.id || visibleVideos[0].id;
    }
  }

  ensureFrameIndex() {
    const maxFrame = Math.max(0, this.getMaxFrameCount() - 1);
    this._value.frameIndex = clamp(Math.floor(this._value.frameIndex || 0), 0, maxFrame);
    if (!this.getMaxFrameCount()) {
      this._value.playing = false;
    }
  }

  setLeft(video) {
    if (this.isHidden(video.id)) {
      return;
    }
    this._value.leftId = video.id;
    if (this._value.rightId === video.id) {
      this._value.rightId = this.getVisibleVideos().find((item) => item.id !== video.id)?.id || video.id;
    }
    this.ensureFrameIndex();
    this.preloadVisibleVideoFrames();
    this.requestDraw();
  }

  setRight(video) {
    if (this.isHidden(video.id)) {
      return;
    }
    this._value.rightId = video.id;
    if (this._value.leftId === video.id) {
      this._value.leftId = this.getVisibleVideos().find((item) => item.id !== video.id)?.id || video.id;
    }
    this.ensureFrameIndex();
    this.preloadVisibleVideoFrames();
    this.requestDraw();
  }

  toggleHidden(video) {
    const hidden = new Set(this._value.hiddenIds || []);
    if (hidden.has(video.id)) {
      hidden.delete(video.id);
    } else {
      hidden.add(video.id);
    }
    this._value.hiddenIds = [...hidden];
    this.ensureSelection();
    this.ensureFrameIndex();
    this.requestDraw();
  }

  isHidden(id) {
    return (this._value.hiddenIds || []).includes(id);
  }

  activate() {
    activeVideoCompareWidget = this;
  }

  handleShortcut(event) {
    if (isPlayPauseShortcut(event)) {
      consumeShortcut(event);
      this.setPlaying(!this._value.playing);
      return true;
    }
    if (isPreviousFrameShortcut(event)) {
      consumeShortcut(event);
      this.stepFrameBy(-1, event.shiftKey);
      return true;
    }
    if (isNextFrameShortcut(event)) {
      consumeShortcut(event);
      this.stepFrameBy(1, event.shiftKey);
      return true;
    }
    return false;
  }

  setPlaying(playing) {
    this._value.playing = playing === true && this.getMaxFrameCount() > 1;
    if (this._value.playing) {
      if (this.hasSourcePlayback()) {
        this.clearSourceSnapshotPreference();
        this.syncSourceVideosToFrame();
      } else {
        this.preloadVisibleVideoFrames();
      }
    } else if (this.hasSourcePlayback()) {
      this.captureVisibleSourceSnapshots(true);
    }
    this.syncPlaybackTimer();
    this.requestDraw();
  }

  syncPlaybackTimer() {
    if (this.playTimer) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.hasSourcePlayback()) {
      const sourceVideos = [this.leftVideo, this.rightVideo].filter(isSourceVideo);
      for (const video of sourceVideos) {
        const element = this.getVideoElement(video);
        if (!element) {
          continue;
        }
        if (this._value.playing) {
          element.playbackRate = 1;
          element.play?.().catch(() => {
            video.status = "Click Play again after the video is ready";
            this._value.playing = false;
            this.requestDraw();
          });
        } else {
          element.pause?.();
        }
      }
      if (this._value.playing) {
        const tick = () => {
          this.updateFrameIndexFromSource();
          this.requestDraw();
          this.animationFrame = requestAnimationFrame(tick);
        };
        this.animationFrame = requestAnimationFrame(tick);
      }
      return;
    }

    if (!this._value.playing) {
      return;
    }
    this.playTimer = setInterval(() => this.stepFrame(), 1000 / this.getDisplayFps());
  }

  stepFrame() {
    const frameCount = this.getMaxFrameCount();
    if (frameCount <= 1) {
      this.setPlaying(false);
      return;
    }
    this.setFrameIndex(this._value.frameIndex + 1, true);
  }

  setFrameIndex(index, wrap = false) {
    const frameCount = this.getMaxFrameCount();
    if (!frameCount) {
      this._value.frameIndex = 0;
      return;
    }
    let nextIndex = Math.floor(index);
    if (wrap) {
      nextIndex = ((nextIndex % frameCount) + frameCount) % frameCount;
    } else {
      nextIndex = clamp(nextIndex, 0, frameCount - 1);
    }
    this._value.frameIndex = nextIndex;
    if (this.hasSourcePlayback()) {
      this.syncSourceVideosToFrame();
    } else {
      this.preloadVisibleVideoFrames();
    }
    this.requestDraw();
  }

  syncSourceVideosToFrame(force = false) {
    const frameCount = this.getMaxFrameCount();
    const duration = this.getTimelineDuration();
    if (frameCount <= 1 || duration <= 0) {
      return;
    }

    const ratio = clamp(this._value.frameIndex / (frameCount - 1), 0, 1);
    for (const video of [this.leftVideo, this.rightVideo]) {
      const element = this.getVideoElement(video);
      const videoDuration = this.getVideoDuration(video);
      if (!element || videoDuration <= 0) {
        continue;
      }
      const targetTime = Math.min(videoDuration, ratio * videoDuration);
      if (force || Math.abs((element.currentTime || 0) - targetTime) > 0.015) {
        try {
          this.captureSourceFrame(video, element, { seeking: true, prefer: !this._value.playing });
          element.currentTime = targetTime;
          this.finishSourceSeek(video, element);
        } catch (error) {
          video.status = "Could not seek original video";
        }
      }
    }
  }

  updateFrameIndexFromSource() {
    if (!this.hasSourcePlayback()) {
      return;
    }
    const primary = this.getVideoElement(this.leftVideo) || this.getVideoElement(this.rightVideo);
    const duration = this.getTimelineDuration();
    const frameCount = this.getMaxFrameCount();
    if (!primary || duration <= 0 || frameCount <= 1) {
      return;
    }
    const ratio = clamp((primary.currentTime || 0) / duration, 0, 1);
    this._value.frameIndex = clamp(Math.round(ratio * (frameCount - 1)), 0, frameCount - 1);
  }

  getPrimarySourceElement() {
    return this.getVideoElement(this.leftVideo) || this.getVideoElement(this.rightVideo);
  }

  seekSourceByFrames(frames) {
    const duration = this.getTimelineDuration();
    const frameCount = this.getMaxFrameCount();
    const primary = this.getPrimarySourceElement();
    if (duration <= 0 || frameCount <= 1 || !primary) {
      return;
    }

    const fps = Math.max(1, this.getSourceFps());
    const nextTime = clamp((primary.currentTime || 0) + frames / fps, 0, duration);
    const ratio = duration > 0 ? nextTime / duration : 0;
    this._value.frameIndex = clamp(Math.round(ratio * (frameCount - 1)), 0, frameCount - 1);
    this.syncSourceVideosToFrame(true);
    this.requestDraw();
  }

  stepFrameBy(delta, fast = false) {
    if (this.hasSourcePlayback()) {
      const stepFrames = fast ? SOURCE_FAST_STEP_FRAMES : SOURCE_STEP_FRAMES;
      this.seekSourceByFrames(delta * stepFrames);
      return;
    }
    this.setFrameIndex(this._value.frameIndex + delta, false);
  }

  getFrameIndexForVideo(video) {
    if (!video?.frames?.length) {
      return 0;
    }
    const maxFrameCount = this.getMaxFrameCount();
    const ratio = maxFrameCount > 1 ? this._value.frameIndex / (maxFrameCount - 1) : 0;
    return clamp(Math.round(ratio * (video.frames.length - 1)), 0, video.frames.length - 1);
  }

  getFrameForVideo(video) {
    if (!video?.frames?.length) {
      return null;
    }
    return video.frames[this.getFrameIndexForVideo(video)] || null;
  }

  ensureFrameLoaded(frame) {
    if (!frame?.url || frame.img) {
      return;
    }
    const image = new Image();
    image.onload = () => this.requestDraw();
    image.src = frame.url;
    frame.img = image;
  }

  preloadVideoFrames(video) {
    if (!video?.frames?.length) {
      return;
    }
    const center = this.getFrameIndexForVideo(video);
    const start = Math.max(0, center - PRELOAD_FRAME_RADIUS);
    const end = Math.min(video.frames.length - 1, center + PRELOAD_FRAME_RADIUS);
    for (let index = start; index <= end; index++) {
      this.ensureFrameLoaded(video.frames[index]);
    }
    this.ensureFrameLoaded(video.frames[0]);
  }

  preloadVisibleVideoFrames() {
    this.preloadVideoFrames(this.leftVideo);
    this.preloadVideoFrames(this.rightVideo);
  }

  getDrawableFrameForVideo(video) {
    const target = this.getFrameForVideo(video);
    if (!target || target.img?.complete) {
      return target;
    }
    for (const frame of video?.frames || []) {
      if (frame.img?.complete) {
        return frame;
      }
    }
    return target;
  }

  updatePointer(pos) {
    this.activate();
    const normalized = this.normalizePos(pos, this.previewBounds);
    if (!normalized || !this.previewBounds) {
      return;
    }
    const bounds = this.previewBounds;
    const pad = EDGE_SNAP_PX;
    const inside =
      normalized[0] >= bounds.x - pad &&
      normalized[0] <= bounds.x + bounds.w + pad &&
      normalized[1] >= bounds.y - pad &&
      normalized[1] <= bounds.y + bounds.h + pad;
    if (inside) {
      this._value.splitX = splitFromPoint(normalized[0], bounds);
      this.node.imageIndex = this._value.splitX > 0.5 ? 1 : 0;
      this.requestDraw();
    }
  }

  getPosCandidates(pos) {
    const point = pointFromValue(pos);
    const candidates = [];
    const nodeX = Number(this.node?.pos?.[0] || 0);
    const nodeY = Number(this.node?.pos?.[1] || 0);
    const graphMouse = app.canvas?.graph_mouse;

    if (isPoint(graphMouse)) {
      candidates.push([Number(graphMouse[0]) - nodeX, Number(graphMouse[1]) - nodeY]);
    }

    if (!point) {
      return candidates;
    }

    const x = point[0];
    const y = point[1];
    candidates.push(
      [x, y],
      [x, y + this.last_y],
      [x - nodeX, y - nodeY],
      [x - nodeX, y - nodeY + this.last_y],
    );

    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = `${candidate[0].toFixed(3)},${candidate[1].toFixed(3)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  getInsideCandidate(pos, bounds) {
    const candidates = this.getPosCandidates(pos);
    if (!candidates.length) {
      return null;
    }

    if (!bounds) {
      return candidates[0];
    }

    const pad = EDGE_SNAP_PX;
    return candidates.find(
      (candidate) =>
        candidate[0] >= bounds.x - pad &&
        candidate[0] <= bounds.x + bounds.w + pad &&
        candidate[1] >= bounds.y - pad &&
        candidate[1] <= bounds.y + bounds.h + pad,
    );
  }

  normalizePos(pos, bounds) {
    const candidate = this.getInsideCandidate(pos, bounds);
    if (candidate) {
      return candidate;
    }

    const candidates = this.getPosCandidates(pos);
    if (!candidates.length) {
      return null;
    }
    return candidates[0];
  }

  findHitArea(pos) {
    for (const area of this.hitAreas) {
      const normalized = this.normalizePos(pos, area);
      if (
        normalized &&
        normalized[0] >= area.x &&
        normalized[0] <= area.x + area.w &&
        normalized[1] >= area.y &&
        normalized[1] <= area.y + area.h
      ) {
        return area;
      }
    }
    return null;
  }

  handlePointerDown(pos) {
    this.activate();
    const area = this.findHitArea(pos);
    if (area) {
      area.action(pos);
      this.requestDraw();
      return true;
    }
    this.updatePointer(pos);
    return false;
  }

  requestDraw(layout = false) {
    this.node.setDirtyCanvas?.(true, layout);
  }

  serializeValue() {
    return {
      videos: this._value.videos.map((video) => {
        const cleanVideo = {
          ...video,
          frames: (video.frames || []).map((frame) => {
            const clean = { ...frame };
            delete clean.img;
            return clean;
          }),
        };
        delete cleanVideo.element;
        delete cleanVideo.seekSnapshot;
        delete cleanVideo.seekToken;
        delete cleanVideo.isSeeking;
        delete cleanVideo.preferSnapshot;
        delete cleanVideo.snapshotHoldUntil;
        return cleanVideo;
      }),
      leftId: this._value.leftId,
      rightId: this._value.rightId,
      hiddenIds: this._value.hiddenIds || [],
      splitX: this._value.splitX,
      frameIndex: this._value.frameIndex,
      playing: false,
    };
  }

  getVideoAspect(video) {
    const element = this.getVideoElement(video);
    const width = Number(element?.videoWidth || video?.width || 0);
    const height = Number(element?.videoHeight || video?.height || 0);
    if (width > 0 && height > 0) {
      return width / height;
    }
    return null;
  }

  getCompareAspect() {
    const aspects = [this.getVideoAspect(this.leftVideo), this.getVideoAspect(this.rightVideo)].filter(
      (aspect) => Number.isFinite(aspect) && aspect > 0,
    );
    if (!aspects.length) {
      return 4 / 3;
    }
    return aspects.reduce((total, aspect) => total + aspect, 0) / aspects.length;
  }

  getPreviewHeight(width) {
    const availableWidth = Math.max(1, (width || DEFAULT_NODE_WIDTH) - WIDGET_PADDING * 2);
    return clamp(availableWidth / this.getCompareAspect(), MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT);
  }

  estimateSelectorHeight(width, rowHeight = SELECTOR_ROW_HEIGHT) {
    if (!this._value.videos.length) {
      return rowHeight;
    }

    const availableWidth = Math.max(1, (width || DEFAULT_NODE_WIDTH) - WIDGET_PADDING * 2);
    let x = 0;
    let rows = 1;
    for (const video of this._value.videos) {
      const itemWidth = Math.min(220, 92 + (video?.name?.length || 8) * 7);
      if (x > 0 && x + itemWidth > availableWidth) {
        rows += 1;
        x = 0;
      }
      x += itemWidth + 6;
    }
    return rows * rowHeight;
  }

  getDesiredWidgetHeight(width) {
    return (
      TOOLBAR_HEIGHT +
      6 +
      Math.max(MIN_PREVIEW_HEIGHT, this.getPreviewHeight(width)) +
      LABEL_GAP +
      CONTROLS_HEIGHT +
      LABEL_GAP +
      LABEL_ROW_HEIGHT +
      8 +
      this.estimateSelectorHeight(width) +
      WIDGET_PADDING
    );
  }

  computeSize(width) {
    return [width, this.getDesiredWidgetHeight(width)];
  }

  syncNodeHeight(width, y) {
    if (!this.node?.size) {
      return;
    }

    const desiredHeight = y + this.getDesiredWidgetHeight(width) + WIDGET_BOTTOM_PADDING;
    const currentHeight = this.node.size[1] || 0;
    if (currentHeight < desiredHeight - 1 || currentHeight > RUNAWAY_NODE_HEIGHT) {
      this.node.size[1] = desiredHeight;
      this.requestDraw(true);
    }
  }

  draw(ctx, node, width, y) {
    this.y = y;
    this.last_y = y;
    this.hitAreas = [];
    this.preloadVisibleVideoFrames();

    const widgetHeight = this.getDesiredWidgetHeight(width);
    this.syncNodeHeight(width, y);
    const padding = WIDGET_PADDING;
    const previewY = y + TOOLBAR_HEIGHT + 6;
    const selectorHeight = this.estimateSelectorHeight(width);
    const previewHeight = Math.min(
      widgetHeight - TOOLBAR_HEIGHT - selectorHeight - CONTROLS_HEIGHT - LABEL_ROW_HEIGHT - padding - 28,
      this.getPreviewHeight(width),
    );
    const previewBounds = {
      x: padding,
      y: previewY,
      w: width - padding * 2,
      h: previewHeight,
    };
    const compareBounds = this.getAspectBounds(previewBounds);
    this.previewBounds = compareBounds;

    this.drawToolbar(ctx, width, y, TOOLBAR_HEIGHT);
    this.drawPreview(ctx, previewBounds, compareBounds);
    const controlsY = previewY + previewHeight + LABEL_GAP;
    this.drawControls(ctx, width, controlsY, CONTROLS_HEIGHT);
    const labelY = controlsY + CONTROLS_HEIGHT + LABEL_GAP;
    this.drawPreviewLabels(ctx, compareBounds, labelY, this.leftVideo, this.rightVideo);
    this.drawSelector(ctx, width, labelY + LABEL_ROW_HEIGHT + 8, SELECTOR_ROW_HEIGHT);
  }

  drawToolbar(ctx, width, y, height) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#d6d6d6";
    ctx.fillText("Multi Video Compare", 10, y + height / 2);

    this.drawButton(ctx, width - 128, y + 3, 70, height - 6, "Add Video", () => addNativeVideoInput(this.node));
    this.drawButton(ctx, width - 52, y + 3, 42, height - 6, "Clean", () => removeEmptyVideoInputs(this.node));
    ctx.restore();
  }

  drawButton(ctx, x, y, width, height, label, action, disabled = false) {
    ctx.save();
    ctx.fillStyle = disabled ? "rgba(70,70,70,0.6)" : "rgba(70,70,70,0.95)";
    ctx.strokeStyle = disabled ? "rgba(140,140,140,0.25)" : "rgba(220,220,220,0.35)";
    ctx.beginPath();
    ctx.roundRect?.(x, y, width, height, 4);
    if (!ctx.roundRect) {
      ctx.rect(x, y, width, height);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = disabled ? "rgba(210,210,210,0.35)" : "#f2f2f2";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "11px Arial";
    ctx.fillText(label, x + width / 2, y + height / 2);
    ctx.restore();

    if (!disabled) {
      this.hitAreas.push({ x: x - 2, y: y - 2, w: width + 4, h: height + 4, action });
    }
  }

  getAspectBounds(bounds) {
    const aspect = this.getCompareAspect();
    const areaAspect = bounds.w / bounds.h;
    let width = bounds.w;
    let height = bounds.h;

    if (aspect > areaAspect) {
      height = bounds.w / aspect;
    } else {
      width = bounds.h * aspect;
    }

    return {
      x: bounds.x + (bounds.w - width) / 2,
      y: bounds.y + (bounds.h - height) / 2,
      w: width,
      h: height,
    };
  }

  drawPreview(ctx, bounds, imageBounds) {
    ctx.save();
    ctx.fillStyle = "#181818";
    ctx.fillRect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.strokeRect(imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h);

    const left = this.leftVideo;
    const right = this.rightVideo;
    const leftElement = this.getVideoElement(left);
    const rightElement = this.getVideoElement(right);
    const leftSourceReady = isSourceVideo(left) && leftElement?.readyState >= 2 && leftElement.videoWidth;
    const rightSourceReady = isSourceVideo(right) && rightElement?.readyState >= 2 && rightElement.videoWidth;
    const leftSourceCanvas = this.getSourceSnapshot(left);
    const rightSourceCanvas = this.getSourceSnapshot(right);
    const leftFrame = this.getDrawableFrameForVideo(left);
    const rightFrame = this.getDrawableFrameForVideo(right);
    const split = imageBounds.x + imageBounds.w * this._value.splitX;

    if (leftSourceCanvas) {
      this.drawContainedMedia(ctx, leftSourceCanvas, imageBounds, leftSourceCanvas.width, leftSourceCanvas.height);
    } else if (leftSourceReady) {
      this.drawContainedMedia(ctx, leftElement, imageBounds, leftElement.videoWidth, leftElement.videoHeight);
    } else if (leftFrame?.img?.naturalWidth && leftFrame?.img?.naturalHeight) {
      this.drawContainedImage(ctx, leftFrame.img, imageBounds);
    }

    if ((rightSourceCanvas || rightSourceReady || rightFrame?.img?.naturalWidth) && right?.id !== left?.id) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(split, imageBounds.y, imageBounds.x + imageBounds.w - split, imageBounds.h);
      ctx.clip();
      if (rightSourceCanvas) {
        this.drawContainedMedia(ctx, rightSourceCanvas, imageBounds, rightSourceCanvas.width, rightSourceCanvas.height);
      } else if (rightSourceReady) {
        this.drawContainedMedia(ctx, rightElement, imageBounds, rightElement.videoWidth, rightElement.videoHeight);
      } else {
        this.drawContainedImage(ctx, rightFrame.img, imageBounds);
      }
      ctx.restore();
    }

    if (!leftSourceCanvas && !rightSourceCanvas && !leftSourceReady && !rightSourceReady && !leftFrame && !rightFrame) {
      ctx.fillStyle = "rgba(230,230,230,0.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "13px Arial";
      const status = left?.status || right?.status || this.lastStatus || "Run the node to show original videos";
      ctx.fillText(status, imageBounds.x + imageBounds.w / 2, imageBounds.y + imageBounds.h / 2);
    }

    const status = [left, right].map((video) => video?.status).find((value) => value && value !== "Ready");
    if (status) {
      ctx.fillStyle = "rgba(20,20,20,0.72)";
      ctx.fillRect(imageBounds.x + 8, imageBounds.y + 8, Math.min(260, imageBounds.w - 16), 22);
      ctx.fillStyle = "rgba(245,245,245,0.86)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = "12px Arial";
      ctx.fillText(status, imageBounds.x + 16, imageBounds.y + 19);
    }

    this.drawSplitLine(ctx, split, imageBounds);
    ctx.restore();
  }

  drawContainedImage(ctx, image, bounds) {
    this.drawContainedMedia(ctx, image, bounds, image.naturalWidth, image.naturalHeight);
  }

  drawContainedMedia(ctx, media, bounds, mediaWidth, mediaHeight) {
    const imageAspect = mediaWidth / mediaHeight;
    const areaAspect = bounds.w / bounds.h;
    let drawWidth;
    let drawHeight;
    let drawX;
    let drawY;

    if (imageAspect > areaAspect) {
      drawWidth = bounds.w;
      drawHeight = bounds.w / imageAspect;
      drawX = bounds.x;
      drawY = bounds.y + (bounds.h - drawHeight) / 2;
    } else {
      drawHeight = bounds.h;
      drawWidth = bounds.h * imageAspect;
      drawX = bounds.x + (bounds.w - drawWidth) / 2;
      drawY = bounds.y;
    }

    ctx.drawImage(media, drawX, drawY, drawWidth, drawHeight);
  }

  drawSplitLine(ctx, split, bounds) {
    ctx.save();
    const x = Math.round(split) + 0.5;
    const centerY = bounds.y + bounds.h / 2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.78)";
    ctx.beginPath();
    ctx.moveTo(x, bounds.y);
    ctx.lineTo(x, bounds.y + bounds.h);
    ctx.stroke();

    ctx.fillStyle = "rgba(245,245,245,0.76)";
    ctx.strokeStyle = "rgba(90,90,90,0.72)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(x, centerY, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawControls(ctx, width, y, height) {
    const frameCount = this.getMaxFrameCount();
    const canPlay = frameCount > 1;
    const buttonLabel = this._value.playing ? "Pause" : "Play";
    this.drawButton(ctx, 10, y + 3, 32, height - 6, "<", () => this.stepFrameBy(-1), !canPlay);
    this.drawButton(ctx, 48, y + 3, 58, height - 6, buttonLabel, () => this.setPlaying(!this._value.playing), !canPlay);
    this.drawButton(ctx, 112, y + 3, 32, height - 6, ">", () => this.stepFrameBy(1), !canPlay);

    const trackX = 154;
    const trackY = y + height / 2 - 2;
    const trackW = width - 240;
    ctx.save();
    ctx.fillStyle = "rgba(70,70,70,0.95)";
    ctx.fillRect(trackX, trackY, trackW, 4);
    const progress = frameCount > 1 ? this._value.frameIndex / (frameCount - 1) : 0;
    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(trackX, trackY, trackW * progress, 4);
    ctx.beginPath();
    ctx.arc(trackX + trackW * progress, trackY + 2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(230,230,230,0.72)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "12px Arial";
    const frameLabel = this.hasSourcePlayback()
      ? `${formatTime((this._value.frameIndex / Math.max(1, frameCount - 1)) * this.getTimelineDuration())} / ${formatTime(
          this.getTimelineDuration(),
        )}`
      : frameCount
        ? `${this._value.frameIndex + 1}/${frameCount}`
        : "0/0";
    ctx.fillText(frameLabel, width - 10, y + height / 2);
    ctx.restore();

    if (canPlay) {
      this.hitAreas.push({
        x: trackX - 4,
        y: y,
        w: trackW + 8,
        h: height,
        action: (pos) => {
          const normalized = this.normalizePos(pos, { x: trackX, y, w: trackW, h: height });
          if (!normalized) {
            return;
          }
          const value = clamp((normalized[0] - trackX) / trackW, 0, 1);
          this.setFrameIndex(Math.round(value * (frameCount - 1)));
        },
      });
    }
  }

  drawPreviewLabels(ctx, bounds, y, left, right) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";
    const labelY = y + LABEL_ROW_HEIGHT / 2;
    this.drawOutsideLabel(ctx, `L: ${left?.name || "-"}`, bounds.x, labelY, "left");
    this.drawOutsideLabel(ctx, `R: ${right?.name || "-"}`, bounds.x + bounds.w, labelY, "right");
    ctx.restore();
  }

  drawOutsideLabel(ctx, text, x, y, align) {
    const maxWidth = Math.max(80, this.previewBounds.w * 0.42);
    const fitted = fitText(ctx, text, maxWidth);
    const textWidth = ctx.measureText(fitted).width;
    const boxWidth = textWidth + 16;
    const boxHeight = 20;
    const boxX = align === "right" ? x - boxWidth : x;
    const boxY = y - boxHeight / 2;

    ctx.fillStyle = "rgba(45,45,45,0.92)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.roundRect?.(boxX, boxY, boxWidth, boxHeight, 5);
    if (!ctx.roundRect) {
      ctx.rect(boxX, boxY, boxWidth, boxHeight);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f7f7f7";
    ctx.textAlign = align;
    ctx.fillText(fitted, align === "right" ? x - 8 : x + 8, y + 0.5);
  }

  drawSelector(ctx, width, y, rowHeight) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";

    if (!this._value.videos.length) {
      ctx.fillStyle = "rgba(210,210,210,0.55)";
      ctx.fillText("Run the node to show videos", 10, y + rowHeight / 2);
      ctx.restore();
      return;
    }

    let x = 10;
    const maxX = width - 10;
    for (const video of this._value.videos) {
      const itemWidth = Math.min(220, Math.max(126, 76 + ctx.measureText(video.name).width));
      if (x > 10 && x + itemWidth > maxX) {
        x = 10;
        y += rowHeight;
      }
      this.drawSelectorItem(ctx, video, x, y + 2, itemWidth, rowHeight - 4);
      x += itemWidth + 6;
    }

    ctx.restore();
  }

  drawSelectorItem(ctx, video, x, y, width, height) {
    const hidden = this.isHidden(video.id);
    const isLeft = this._value.leftId === video.id;
    const isRight = this._value.rightId === video.id;

    ctx.save();
    ctx.fillStyle = hidden ? "rgba(45,45,45,0.75)" : "rgba(50,50,50,0.95)";
    ctx.strokeStyle = isLeft || isRight ? "#ffffff" : "rgba(210,210,210,0.22)";
    ctx.lineWidth = isLeft || isRight ? 1.5 : 1;
    ctx.beginPath();
    ctx.roundRect?.(x, y, width, height, 4);
    if (!ctx.roundRect) {
      ctx.rect(x, y, width, height);
    }
    ctx.fill();
    ctx.stroke();

    let cursor = x + 4;
    this.drawSmallToggle(ctx, cursor, y + 3, "L", isLeft, () => this.setLeft(video), hidden);
    cursor += 22;
    this.drawSmallToggle(ctx, cursor, y + 3, "R", isRight, () => this.setRight(video), hidden);
    cursor += 22;
    this.drawSmallToggle(ctx, cursor, y + 3, hidden ? "S" : "H", hidden, () => this.toggleHidden(video));
    cursor += 24;

    ctx.fillStyle = hidden ? "rgba(220,220,220,0.35)" : "#eeeeee";
    ctx.textAlign = "left";
    const label = fitText(ctx, video.name, Math.max(30, width - (cursor - x) - 8));
    ctx.fillText(label, cursor, y + height / 2 + 1);
    ctx.restore();
  }

  drawSmallToggle(ctx, x, y, label, active, action, disabled = false) {
    const size = 18;
    ctx.save();
    ctx.fillStyle = active ? "#ffffff" : "rgba(90,90,90,0.95)";
    ctx.strokeStyle = disabled ? "rgba(180,180,180,0.15)" : "rgba(230,230,230,0.35)";
    ctx.beginPath();
    ctx.roundRect?.(x, y, size, size, 4);
    if (!ctx.roundRect) {
      ctx.rect(x, y, size, size);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? "#111111" : disabled ? "rgba(240,240,240,0.3)" : "#eeeeee";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "11px Arial";
    ctx.fillText(label, x + size / 2, y + size / 2 + 0.5);
    ctx.restore();

    if (!disabled) {
      this.hitAreas.push({ x: x - 2, y: y - 2, w: size + 4, h: size + 4, action });
    }
  }

  mouse(event, pos) {
    const pointerPos = findPoint([pos, event]);
    const eventType = event?.type;
    if (eventType === "pointerdown" || eventType === "mousedown" || eventType === "click") {
      return this.handlePointerDown(pointerPos);
    }

    if (eventType === "pointermove" || eventType === "mousemove") {
      this.updatePointer(pointerPos);
      return true;
    }

    return false;
  }
}

function installWidget(node) {
  if (isNodes2Enabled()) {
    return null;
  }

  if (node[WIDGET_NAME]) {
    return node[WIDGET_NAME];
  }

  node.serialize_widgets = true;
  node.properties = node.properties || {};
  node.imageIndex = 0;
  node.imgs = [];

  const widget = new MultiVideoCompareWidget(node);
  node[WIDGET_NAME] = widget;
  widget.activate();

  if (typeof node.addCustomWidget === "function") {
    node.addCustomWidget(widget);
  } else {
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }

  const currentWidth = node.size?.[0] || 0;
  const currentHeight = node.size?.[1] || 0;
  if (
    !node.size ||
    currentWidth < DEFAULT_NODE_WIDTH ||
    currentHeight < DEFAULT_NODE_HEIGHT ||
    currentHeight > RUNAWAY_NODE_HEIGHT
  ) {
    node.size = [
      Math.max(currentWidth, DEFAULT_NODE_WIDTH),
      currentHeight > RUNAWAY_NODE_HEIGHT ? DEFAULT_NODE_HEIGHT : Math.max(currentHeight, DEFAULT_NODE_HEIGHT),
    ];
  }

  return widget;
}

app.registerExtension({
  name: "xiaofu.MultiVideoCompare",

  async setup() {
    if (!shortcutsInstalled) {
      document.addEventListener("keydown", handleGlobalShortcut, true);
      shortcutsInstalled = true;
    }
    installVideoFolderWarningListener();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === VIDEO_FOLDER_NODE_ID) {
      const proto = nodeType.prototype;
      const originalOnNodeCreated = proto.onNodeCreated;

      proto.onNodeCreated = function () {
        const result = originalOnNodeCreated?.apply(this, arguments);
        installVideoFolderPickerWidgets(this);
        return result;
      };
      return;
    }

    if (nodeData.name !== NODE_ID) {
      return;
    }

    videoCompareNodeType = nodeType;

    const proto = nodeType.prototype;
    const originalOnNodeCreated = proto.onNodeCreated;
    const originalOnExecuted = proto.onExecuted;
    const originalOnConnectionsChange = proto.onConnectionsChange;
    const originalOnMouseMove = proto.onMouseMove;
    const originalOnMouseDown = proto.onMouseDown;
    const originalOnMouseLeave = proto.onMouseLeave;
    const originalOnSerialize = proto.onSerialize;
    const originalOnDrawBackground = proto.onDrawBackground;
    const originalOnDrawForeground = proto.onDrawForeground;
    const originalGetExtraMenuOptions = proto.getExtraMenuOptions;

    proto.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      if (isNodes2Enabled()) {
        return result;
      }
      installWidget(this);
      stabilizeVideoInputs(this);
      return result;
    };

    proto.onExecuted = function (output) {
      if (isNodes2Enabled()) {
        return originalOnExecuted?.apply(this, arguments);
      }
      const widget = installWidget(this);
      widget?.setVideos(output?.xiaofu_videos || []);
      return undefined;
    };

    proto.onConnectionsChange = function () {
      const result = originalOnConnectionsChange?.apply(this, arguments);
      if (isNodes2Enabled()) {
        return result;
      }
      setTimeout(() => stabilizeVideoInputs(this), 32);
      return result;
    };

    proto.onMouseMove = function (event, pos) {
      const result = originalOnMouseMove?.apply(this, arguments);
      if (isNodes2Enabled()) {
        return result;
      }
      const pointerPos = findPoint([pos, event]);
      if (pointerPos) {
        this[WIDGET_NAME]?.updatePointer(pointerPos);
      }
      return result;
    };

    proto.onMouseDown = function (event, pos) {
      if (isNodes2Enabled()) {
        return originalOnMouseDown?.apply(this, arguments);
      }
      const pointerPos = findPoint([pos, event]);
      if (pointerPos) {
        const handled = this[WIDGET_NAME]?.handlePointerDown(pointerPos);
        if (handled) {
          return true;
        }
      }
      return originalOnMouseDown?.apply(this, arguments);
    };

    proto.onMouseLeave = function () {
      if (isNodes2Enabled()) {
        return originalOnMouseLeave?.apply(this, arguments);
      }
      if (this[WIDGET_NAME]) {
        this[WIDGET_NAME].pointerOverPreview = false;
      }
      return originalOnMouseLeave?.apply(this, arguments);
    };

    const withoutNativePreviewImages = function (node, callback, args) {
      const imgs = node.imgs;
      const imageIndex = node.imageIndex;
      node.imgs = [];
      node.imageIndex = 0;
      try {
        return callback?.apply(node, args);
      } finally {
        node.imgs = imgs;
        node.imageIndex = imageIndex;
      }
    };

    proto.onDrawBackground = function () {
      if (isNodes2Enabled()) {
        return originalOnDrawBackground?.apply(this, arguments);
      }
      return withoutNativePreviewImages(this, originalOnDrawBackground, arguments);
    };

    proto.onDrawForeground = function () {
      if (isNodes2Enabled()) {
        return originalOnDrawForeground?.apply(this, arguments);
      }
      return withoutNativePreviewImages(this, originalOnDrawForeground, arguments);
    };

    proto.onSerialize = function (serialized) {
      const result = originalOnSerialize?.apply(this, arguments);
      if (isNodes2Enabled()) {
        return result;
      }
      const widget = this[WIDGET_NAME];
      if (widget && Array.isArray(serialized?.widgets_values)) {
        for (const [index, item] of (this.widgets || []).entries()) {
          if (item?.name === WIDGET_NAME) {
            serialized.widgets_values[index] = widget.serializeValue();
          }
        }
      }
      return result;
    };

    proto.getExtraMenuOptions = function (_, options) {
      originalGetExtraMenuOptions?.apply(this, arguments);
      if (isNodes2Enabled()) {
        return;
      }
      options.push(
        null,
        {
          content: "Add Video Input",
          callback: () => addNativeVideoInput(this),
        },
        {
          content: "Remove Empty Video Inputs",
          callback: () => removeEmptyVideoInputs(this),
        },
      );
    };
  },
});
