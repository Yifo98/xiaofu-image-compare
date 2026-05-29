import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "XiaoFuMultiVideoCompare";
const NODE2_WIDGET_NAME = "xiaofu_multi_video_compare_node2";
const FRAME_SLOT_PREFIX = "frames_";
const NATIVE_SLOT_PREFIX = "clip_";
const MIN_FRAME_INPUTS = 0;
const MIN_NATIVE_INPUTS = 12;
const STYLE_ID = "xiaofu-video-compare-node2-style";
const MIN_PREVIEW_HEIGHT = 280;
const MAX_PREVIEW_HEIGHT = 1000;
const NODE_BOTTOM_PADDING = 18;
const HEIGHT_TOLERANCE = 80;
const EDGE_SNAP_PX = 10;
const TOOLBAR_HEIGHT = 28;
const CONTROLS_HEIGHT = 30;
const LABEL_ROW_HEIGHT = 22;
const SELECTOR_ROW_HEIGHT = 30;
const SECTION_GAP = 8;
const WIDGET_VERTICAL_PADDING = 16;
const PRELOAD_FRAME_RADIUS = 10;
const SOURCE_STEP_FRAMES = 1;
const SOURCE_FAST_STEP_FRAMES = 5;
const SOURCE_SEEK_HOLD_MS = 360;
const SOURCE_SEEK_RETRY_MS = 80;
const SOURCE_SEEK_MAX_RETRIES = 8;

let activeNode2VideoCompareView = null;
let shortcutsInstalled = false;

function slotName(prefix, index) {
  return `${prefix}${String(index + 1).padStart(2, "0")}`;
}

function isNodes2Enabled() {
  return (
    app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled") === true ||
    globalThis.LiteGraph?.vueNodesMode === true
  );
}

function isXiaoFuVideoNode(node) {
  return node?.constructor?.comfyClass === NODE_ID || node?.comfyClass === NODE_ID || node?.type === NODE_ID;
}

function inputUsesPrefix(input, prefix) {
  return input?.name?.startsWith(prefix);
}

function isVideoCompareInput(input) {
  return inputUsesPrefix(input, FRAME_SLOT_PREFIX) || inputUsesPrefix(input, NATIVE_SLOT_PREFIX);
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

  let frameInputs = getInputsByPrefix(node, FRAME_SLOT_PREFIX);
  while (frameInputs.length < MIN_FRAME_INPUTS) {
    addFrameInput(node);
    frameInputs = getInputsByPrefix(node, FRAME_SLOT_PREFIX);
  }

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

  renameInputsByPrefix(node, FRAME_SLOT_PREFIX, "IMAGE");
  renameInputsByPrefix(node, NATIVE_SLOT_PREFIX, "*");
  node.setDirtyCanvas?.(true, true);
}

function removeEmptyVideoInputs(node) {
  const allInputs = getVideoCompareInputs(node);
  for (let i = allInputs.length - 1; i >= 0; i--) {
    const item = allInputs[i];
    const frameInputs = getInputsByPrefix(node, FRAME_SLOT_PREFIX);
    const nativeInputs = getInputsByPrefix(node, NATIVE_SLOT_PREFIX);
    const isRequiredFrameInput =
      inputUsesPrefix(item.input, FRAME_SLOT_PREFIX) &&
      frameInputs.findIndex((frame) => frame.input === item.input) < MIN_FRAME_INPUTS;
    const isRequiredNativeInput =
      inputUsesPrefix(item.input, NATIVE_SLOT_PREFIX) &&
      nativeInputs.findIndex((native) => native.input === item.input) < MIN_NATIVE_INPUTS;
    if (!isRequiredFrameInput && !isRequiredNativeInput && item?.input.link == null) {
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

function splitFromClientX(clientX, bounds) {
  const snap = Math.min(0.08, EDGE_SNAP_PX / Math.max(1, bounds.width));
  const value = (clientX - bounds.left) / bounds.width;
  if (value <= snap) {
    return 0;
  }
  if (value >= 1 - snap) {
    return 1;
  }
  return clamp(value, 0, 1);
}

function stopNodeDrag(event) {
  event.stopPropagation();
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const wholeSeconds = Math.floor(value % 60);
  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}`;
}

function isTypingTarget(event) {
  const tagName = event?.target?.tagName?.toLowerCase();
  if (tagName === "textarea" || tagName === "select" || event?.target?.isContentEditable) {
    return true;
  }
  if (tagName !== "input") {
    return false;
  }
  const inputType = event.target?.type?.toLowerCase?.() || "text";
  return !["button", "checkbox", "radio", "range", "submit"].includes(inputType);
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
  if (!isNodes2Enabled() || isTypingTarget(event) || isVideoBrowserTarget(event) || !activeNode2VideoCompareView) {
    return;
  }
  if (activeNode2VideoCompareView.handleShortcut(event)) {
    event.stopImmediatePropagation?.();
  }
}

function installGlobalShortcuts() {
  if (shortcutsInstalled) {
    return;
  }
  document.addEventListener("keydown", handleGlobalShortcut, true);
  shortcutsInstalled = true;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.xf-video-compare-node2 {
  box-sizing: border-box;
  width: 100%;
  min-width: 340px;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  color: #f2f2f2;
  font: 12px Arial, sans-serif;
  user-select: none;
}
.xf-video-compare-node2 * {
  box-sizing: border-box;
}
.xf-video-compare-node2:focus {
  outline: none;
}
.xf-video-compare-node2__toolbar,
.xf-video-compare-node2__controls {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
}
.xf-video-compare-node2__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(242, 242, 242, 0.86);
  font-weight: 600;
}
.xf-video-compare-node2 button {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(55, 55, 55, 0.94);
  color: #f5f5f5;
  min-width: 34px;
  height: 24px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
  font: 11px Arial, sans-serif;
}
.xf-video-compare-node2 button:hover {
  background: rgba(78, 78, 78, 0.98);
}
.xf-video-compare-node2 button.is-active {
  background: #f5f5f5;
  color: #111;
}
.xf-video-compare-node2 button:disabled {
  cursor: default;
  opacity: 0.42;
}
.xf-video-compare-node2__preview {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  aspect-ratio: 1 / 1;
  min-height: ${MIN_PREVIEW_HEIGHT}px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  background: #101010;
}
.xf-video-compare-node2__preview [hidden] {
  display: none !important;
}
.xf-video-compare-node2__preview img,
.xf-video-compare-node2__preview video,
.xf-video-compare-node2__preview canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  pointer-events: none;
  background: #101010;
}
.xf-video-compare-node2__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(235, 235, 235, 0.58);
}
.xf-video-compare-node2__divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 255, 255, 0.82);
  transform: translateX(-0.5px);
  pointer-events: none;
}
.xf-video-compare-node2__divider::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1px solid rgba(80, 80, 80, 0.74);
  background: rgba(245, 245, 245, 0.82);
  transform: translate(-50%, -50%);
}
.xf-video-compare-node2__scrubber {
  flex: 1;
  min-width: 80px;
}
.xf-video-compare-node2__frame {
  min-width: 68px;
  text-align: right;
  color: rgba(242, 242, 242, 0.76);
}
.xf-video-compare-node2__labels {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
}
.xf-video-compare-node2__label {
  max-width: 48%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 5px;
  background: rgba(45, 45, 45, 0.92);
  padding: 3px 8px;
  color: #f7f7f7;
}
.xf-video-compare-node2__selector {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}
.xf-video-compare-node2__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 24px;
  padding: 2px 4px;
  border: 1px solid rgba(210, 210, 210, 0.22);
  border-radius: 5px;
  background: rgba(50, 50, 50, 0.95);
}
.xf-video-compare-node2__item.is-selected {
  border-color: rgba(255, 255, 255, 0.86);
}
.xf-video-compare-node2__item.is-hidden {
  opacity: 0.5;
}
.xf-video-compare-node2__item-name {
  min-width: 46px;
  max-width: 124px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #eeeeee;
}
`;
  document.head.appendChild(style);
}

class Node2VideoCompareView {
  constructor(node, element) {
    this.node = node;
    this.element = element;
    this.domWidget = null;
    this.playTimer = null;
    this.animationFrame = null;
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

    this.build();
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
    this.render();
    this.syncPlaybackTimer();
  }

  build() {
    ensureStyle();
    this.element.className = "xf-video-compare-node2";
    this.element.tabIndex = 0;
    this.element.addEventListener("pointerenter", () => this.activate());
    this.element.addEventListener("pointermove", () => this.activate());
    this.element.addEventListener("focusin", () => this.activate());
    this.element.addEventListener("pointerdown", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
    });
    this.element.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
    });
    this.element.addEventListener("dblclick", stopNodeDrag);
    this.element.addEventListener("keydown", (event) => this.handleShortcut(event));

    this.toolbar = document.createElement("div");
    this.toolbar.className = "xf-video-compare-node2__toolbar";

    this.title = document.createElement("div");
    this.title.className = "xf-video-compare-node2__title";
    this.title.textContent = "Multi Video Compare";

    this.addVideoButton = document.createElement("button");
    this.addVideoButton.type = "button";
    this.addVideoButton.textContent = "Add Video";
    this.addVideoButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      addNativeVideoInput(this.node);
    });

    this.cleanButton = document.createElement("button");
    this.cleanButton.type = "button";
    this.cleanButton.textContent = "Clean";
    this.cleanButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      removeEmptyVideoInputs(this.node);
    });

    this.toolbar.append(this.title, this.addVideoButton, this.cleanButton);

    this.preview = document.createElement("div");
    this.preview.className = "xf-video-compare-node2__preview";
    this.preview.addEventListener("pointerdown", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      this.updateSplitFromEvent(event);
      this.preview.setPointerCapture?.(event.pointerId);
    });
    this.preview.addEventListener("pointermove", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.updateSplitFromEvent(event);
    });

    this.leftImageEl = document.createElement("img");
    this.rightImageEl = document.createElement("img");
    this.leftVideoEl = this.makeSourceVideoElement();
    this.rightVideoEl = this.makeSourceVideoElement();
    this.leftSnapshotEl = document.createElement("canvas");
    this.rightSnapshotEl = document.createElement("canvas");
    this.leftSnapshotEl.hidden = true;
    this.rightSnapshotEl.hidden = true;
    this.divider = document.createElement("div");
    this.divider.className = "xf-video-compare-node2__divider";
    this.empty = document.createElement("div");
    this.empty.className = "xf-video-compare-node2__empty";
    this.empty.textContent = "No videos";
    this.preview.append(
      this.leftImageEl,
      this.leftVideoEl,
      this.leftSnapshotEl,
      this.rightImageEl,
      this.rightVideoEl,
      this.rightSnapshotEl,
      this.divider,
      this.empty,
    );

    this.controls = document.createElement("div");
    this.controls.className = "xf-video-compare-node2__controls";

    this.prevButton = document.createElement("button");
    this.prevButton.type = "button";
    this.prevButton.textContent = "<";
    this.prevButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      this.stepFrameBy(-1);
    });

    this.playButton = document.createElement("button");
    this.playButton.type = "button";
    this.playButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      this.setPlaying(!this._value.playing);
    });

    this.nextButton = document.createElement("button");
    this.nextButton.type = "button";
    this.nextButton.textContent = ">";
    this.nextButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      this.stepFrameBy(1);
    });

    this.scrubber = document.createElement("input");
    this.scrubber.type = "range";
    this.scrubber.min = "0";
    this.scrubber.step = "1";
    this.scrubber.className = "xf-video-compare-node2__scrubber";
    this.scrubber.addEventListener("input", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      this.setFrameIndex(Number(event.target.value) || 0);
    });

    this.frameLabel = document.createElement("div");
    this.frameLabel.className = "xf-video-compare-node2__frame";
    this.controls.append(this.prevButton, this.playButton, this.nextButton, this.scrubber, this.frameLabel);

    this.labels = document.createElement("div");
    this.labels.className = "xf-video-compare-node2__labels";
    this.leftLabel = document.createElement("div");
    this.leftLabel.className = "xf-video-compare-node2__label";
    this.rightLabel = document.createElement("div");
    this.rightLabel.className = "xf-video-compare-node2__label";
    this.labels.append(this.leftLabel, this.rightLabel);

    this.selector = document.createElement("div");
    this.selector.className = "xf-video-compare-node2__selector";

    this.element.append(this.toolbar, this.preview, this.controls, this.labels, this.selector);
  }

  makeSourceVideoElement() {
    const element = document.createElement("video");
    element.preload = "metadata";
    element.muted = true;
    element.playsInline = true;
    element.loop = true;
    element.hidden = true;
    element.addEventListener("loadedmetadata", () => {
      this.ensureFrameIndex();
      this.render();
      this.requestLayout();
    });
    element.addEventListener("canplay", () => this.renderPreview());
    element.addEventListener("timeupdate", () => {
      this.updateFrameIndexFromSource();
      this.renderControls();
    });
    element.addEventListener("error", () => {
      this.setPlaying(false);
      this.empty.textContent = "Could not load original video";
      this.renderPreview();
    });
    return element;
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
    this.render();
    this.requestLayout();
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

  getElementForVideo(video) {
    if (!isSourceVideo(video)) {
      return null;
    }
    if (video.id === this.leftVideo?.id) {
      return this.leftVideoEl;
    }
    if (video.id === this.rightVideo?.id) {
      return this.rightVideoEl;
    }
    return null;
  }

  getVideoDuration(video) {
    const element = this.getElementForVideo(video);
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

  ensureFrameIndex() {
    const maxFrame = Math.max(0, this.getMaxFrameCount() - 1);
    this._value.frameIndex = clamp(Math.floor(this._value.frameIndex || 0), 0, maxFrame);
    if (!this.getMaxFrameCount()) {
      this._value.playing = false;
    }
  }

  getPreviewAspectRatio() {
    const video = this.leftVideo || this.rightVideo;
    const element = this.getElementForVideo(video);
    const width = Number(element?.videoWidth || video?.width);
    const height = Number(element?.videoHeight || video?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return clamp(width / height, 0.35, 2.75);
    }
    return 1;
  }

  getPreviewHeight() {
    const nodeWidth = Number(this.node?.size?.[0]) || 680;
    const availableWidth = Math.max(340, nodeWidth - 16);
    return clamp(availableWidth / this.getPreviewAspectRatio(), MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT);
  }

  getSelectorRows() {
    return Math.max(1, Math.ceil((this._value.videos.length || 1) / 2));
  }

  getReservedHeight() {
    return (
      WIDGET_VERTICAL_PADDING +
      TOOLBAR_HEIGHT +
      CONTROLS_HEIGHT +
      LABEL_ROW_HEIGHT +
      this.getSelectorRows() * SELECTOR_ROW_HEIGHT +
      SECTION_GAP * 4
    );
  }

  isHidden(id) {
    return (this._value.hiddenIds || []).includes(id);
  }

  activate() {
    activeNode2VideoCompareView = this;
  }

  handleShortcut(event) {
    if (isTypingTarget(event)) {
      return false;
    }
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
    this.render();
    this.syncPlaybackTimer();
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
    this.render();
    this.syncPlaybackTimer();
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
    this.render();
    this.syncPlaybackTimer();
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
    this.renderControls();
    this.syncPlaybackTimer();
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
      for (const element of [this.leftVideoEl, this.rightVideoEl]) {
        if (!element.src) {
          continue;
        }
        if (this._value.playing) {
          element.playbackRate = 1;
          element.play?.().catch(() => {
            this._value.playing = false;
            this.renderControls();
          });
        } else {
          element.pause?.();
        }
      }
      if (this._value.playing) {
        const tick = () => {
          this.updateFrameIndexFromSource();
          this.renderControls();
          this.animationFrame = requestAnimationFrame(tick);
        };
        this.animationFrame = requestAnimationFrame(tick);
      }
      return;
    }

    if (!this._value.playing) {
      return;
    }
    const frameMs = 1000 / this.getDisplayFps();
    this.playTimer = setInterval(() => this.stepFrame(), frameMs);
  }

  stepFrame() {
    const maxFrameCount = this.getMaxFrameCount();
    if (maxFrameCount <= 1) {
      this.setPlaying(false);
      return;
    }
    this.setFrameIndex(this._value.frameIndex + 1, true);
  }

  setFrameIndex(index, wrap = false) {
    const maxFrameCount = this.getMaxFrameCount();
    if (!maxFrameCount) {
      this._value.frameIndex = 0;
      return;
    }
    let nextIndex = Math.floor(index);
    if (wrap) {
      nextIndex = ((nextIndex % maxFrameCount) + maxFrameCount) % maxFrameCount;
    } else {
      nextIndex = clamp(nextIndex, 0, maxFrameCount - 1);
    }
    this._value.frameIndex = nextIndex;
    if (this.hasSourcePlayback()) {
      this.syncSourceVideosToFrame();
    } else {
      this.preloadVisibleVideoFrames();
    }
    this.renderPreview();
    this.renderControls();
  }

  captureSourceFrame(video, element, canvas, { seeking = false, prefer = null } = {}) {
    if (!video || !element || !canvas || element.readyState < 2 || !element.videoWidth || !element.videoHeight) {
      return false;
    }
    try {
      const nextCanvas = document.createElement("canvas");
      nextCanvas.width = element.videoWidth;
      nextCanvas.height = element.videoHeight;
      nextCanvas.getContext("2d")?.drawImage(element, 0, 0, nextCanvas.width, nextCanvas.height);

      if (video.hasSnapshot && canvasLooksMostlyBlack(nextCanvas)) {
        if (seeking) {
          video.isSeeking = true;
        }
        if (prefer !== null) {
          video.preferSnapshot = prefer;
        }
        return false;
      }

      if (canvas.width !== nextCanvas.width || canvas.height !== nextCanvas.height) {
        canvas.width = nextCanvas.width;
        canvas.height = nextCanvas.height;
      }
      canvas.getContext("2d")?.drawImage(nextCanvas, 0, 0, canvas.width, canvas.height);
      video.hasSnapshot = true;
      canvas.hidden = false;
      video.isSeeking = seeking;
      if (prefer !== null) {
        video.preferSnapshot = prefer;
      }
      return true;
    } catch (error) {
      if (!video.isSeeking && !video.preferSnapshot) {
        canvas.hidden = true;
      }
      return false;
    }
  }

  finishSourceSeek(video, element, canvas) {
    if (!video || !element || !canvas) {
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

      const captured = this.captureSourceFrame(video, element, canvas, {
        seeking: false,
        prefer: !this._value.playing,
      });

      if (!captured && attempt < SOURCE_SEEK_MAX_RETRIES) {
        video.isSeeking = true;
        const retryTimer = setTimeout(() => finish(attempt + 1), SOURCE_SEEK_RETRY_MS);
        this.seekFallbackTimers.set(element, retryTimer);
        this.updateSourceSnapshotVisibility();
        this.renderPreview();
        return;
      }

      video.isSeeking = false;
      video.snapshotHoldUntil =
        this._value.playing || !captured ? performance.now() + SOURCE_SEEK_HOLD_MS : 0;
      this.updateSourceSnapshotVisibility();
      this.renderPreview();
      this.renderControls();
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
    for (const [video, element, canvas] of [
      [this.leftVideo, this.leftVideoEl, this.leftSnapshotEl],
      [this.rightVideo, this.rightVideoEl, this.rightSnapshotEl],
    ]) {
      if (element?.src) {
        this.captureSourceFrame(video, element, canvas, { seeking: false, prefer });
      }
    }
    this.updateSourceSnapshotVisibility();
  }

  clearSourceSnapshotPreference() {
    for (const [video, canvas] of [
      [this.leftVideo, this.leftSnapshotEl],
      [this.rightVideo, this.rightSnapshotEl],
    ]) {
      if (video) {
        video.preferSnapshot = false;
        video.snapshotHoldUntil = 0;
      }
      if (canvas) {
        canvas.hidden = true;
      }
    }
  }

  shouldShowSourceSnapshot(video, canvas) {
    if (!isSourceVideo(video) || !canvas || !video.hasSnapshot) {
      return false;
    }
    const holdUntil = Number(video.snapshotHoldUntil || 0);
    return video.isSeeking || video.preferSnapshot || holdUntil > performance.now();
  }

  updateSourceSnapshotVisibility() {
    this.leftSnapshotEl.hidden = !this.shouldShowSourceSnapshot(this.leftVideo, this.leftSnapshotEl);
    this.rightSnapshotEl.hidden = !this.shouldShowSourceSnapshot(this.rightVideo, this.rightSnapshotEl);
  }

  syncSourceVideosToFrame(force = false) {
    const maxFrameCount = this.getMaxFrameCount();
    if (maxFrameCount <= 1) {
      return;
    }
    const ratio = clamp(this._value.frameIndex / (maxFrameCount - 1), 0, 1);
    for (const [video, element, canvas] of [
      [this.leftVideo, this.leftVideoEl, this.leftSnapshotEl],
      [this.rightVideo, this.rightVideoEl, this.rightSnapshotEl],
    ]) {
      if (!isSourceVideo(video) || !element?.src) {
        continue;
      }
      const duration = this.getVideoDuration(video);
      if (duration <= 0) {
        continue;
      }
      const targetTime = Math.min(duration, ratio * duration);
      if (force || Math.abs((element.currentTime || 0) - targetTime) > 0.015) {
        try {
          this.captureSourceFrame(video, element, canvas, { seeking: true, prefer: !this._value.playing });
          element.currentTime = targetTime;
          this.finishSourceSeek(video, element, canvas);
        } catch (error) {
          this.empty.textContent = "Could not seek original video";
        }
      }
    }
  }

  updateFrameIndexFromSource() {
    if (!this.hasSourcePlayback()) {
      return;
    }
    const primary = this.leftVideoEl.src ? this.leftVideoEl : this.rightVideoEl.src ? this.rightVideoEl : null;
    const duration = this.getTimelineDuration();
    const maxFrameCount = this.getMaxFrameCount();
    if (!primary || duration <= 0 || maxFrameCount <= 1) {
      return;
    }
    const ratio = clamp((primary.currentTime || 0) / duration, 0, 1);
    this._value.frameIndex = clamp(Math.round(ratio * (maxFrameCount - 1)), 0, maxFrameCount - 1);
  }

  getPrimarySourceElement() {
    return this.leftVideoEl.src ? this.leftVideoEl : this.rightVideoEl.src ? this.rightVideoEl : null;
  }

  seekSourceByFrames(frames) {
    const duration = this.getTimelineDuration();
    const maxFrameCount = this.getMaxFrameCount();
    const primary = this.getPrimarySourceElement();
    if (duration <= 0 || maxFrameCount <= 1 || !primary) {
      return;
    }

    const fps = Math.max(1, this.getSourceFps());
    const nextTime = clamp((primary.currentTime || 0) + frames / fps, 0, duration);
    const ratio = duration > 0 ? nextTime / duration : 0;
    this._value.frameIndex = clamp(Math.round(ratio * (maxFrameCount - 1)), 0, maxFrameCount - 1);
    this.syncSourceVideosToFrame(true);
    this.renderPreview();
    this.renderControls();
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

  updateSplitFromEvent(event) {
    const bounds = this.preview.getBoundingClientRect();
    if (!bounds.width) {
      return;
    }
    this._value.splitX = splitFromClientX(event.clientX, bounds);
    this.node.imageIndex = this._value.splitX > 0.5 ? 1 : 0;
    this.renderPreview();
  }

  getFrameForVideo(video) {
    if (!video?.frames?.length) {
      return null;
    }
    return video.frames[this.getFrameIndexForVideo(video)] || null;
  }

  ensureFrameLoaded(frame) {
    if (!frame?.url || frame.preloadImage) {
      return;
    }
    const image = new Image();
    image.onload = () => this.renderPreview();
    image.src = frame.url;
    frame.preloadImage = image;
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
    if (!target || target.preloadImage?.complete) {
      return target;
    }
    for (const frame of video?.frames || []) {
      if (frame.preloadImage?.complete) {
        return frame;
      }
    }
    return target;
  }

  render() {
    this.renderPreview();
    this.renderControls();
    this.renderSelector();
    this.syncNodeHeight();
  }

  renderPreview() {
    const left = this.leftVideo;
    const right = this.rightVideo;
    const leftFrame = this.getDrawableFrameForVideo(left);
    const rightFrame = this.getDrawableFrameForVideo(right);
    const hasVideos = !!(isSourceVideo(left) || isSourceVideo(right) || leftFrame || rightFrame);
    const split = `${this._value.splitX * 100}%`;
    const aspectRatio = this.getPreviewAspectRatio();

    this.empty.hidden = hasVideos;
    this.empty.style.display = hasVideos ? "none" : "flex";
    this.empty.textContent = isSourceVideo(left) || isSourceVideo(right) ? "Loading original video" : "No videos";
    this.divider.hidden = !hasVideos;
    this.divider.style.left = split;
    this.preview.style.aspectRatio = `${aspectRatio}`;
    this.preview.style.height = `${this.getPreviewHeight()}px`;

    if (isSourceVideo(left)) {
      this.setImageElement(this.leftImageEl, "");
      this.setVideoElement(this.leftVideoEl, left);
    } else {
      this.leftSnapshotEl.hidden = true;
      this.setVideoElement(this.leftVideoEl, null);
      this.setImageElement(this.leftImageEl, leftFrame?.url || "");
    }

    const showRight = !!rightFrame && right?.id !== left?.id;
    const showRightSource = isSourceVideo(right) && right?.id !== left?.id;
    if (showRightSource) {
      this.setImageElement(this.rightImageEl, "");
      this.setVideoElement(this.rightVideoEl, right);
    } else {
      this.rightSnapshotEl.hidden = true;
      this.setVideoElement(this.rightVideoEl, null);
      this.setImageElement(this.rightImageEl, showRight ? rightFrame.url : "");
    }
    this.rightImageEl.style.clipPath = `inset(0 0 0 ${split})`;
    this.rightVideoEl.style.clipPath = `inset(0 0 0 ${split})`;
    this.rightSnapshotEl.style.clipPath = `inset(0 0 0 ${split})`;
    this.updateSourceSnapshotVisibility();

    this.leftLabel.textContent = `L: ${left?.name || "-"}`;
    this.rightLabel.textContent = `R: ${right?.name || "-"}`;
  }

  renderControls() {
    const maxFrameCount = this.getMaxFrameCount();
    const maxFrame = Math.max(0, maxFrameCount - 1);
    this.prevButton.disabled = maxFrameCount <= 1;
    this.scrubber.max = `${maxFrame}`;
    this.scrubber.value = `${clamp(this._value.frameIndex, 0, maxFrame)}`;
    this.scrubber.disabled = maxFrameCount <= 1;
    this.playButton.textContent = this._value.playing ? "Pause" : "Play";
    this.playButton.disabled = maxFrameCount <= 1;
    this.nextButton.disabled = maxFrameCount <= 1;
    this.frameLabel.textContent = this.hasSourcePlayback()
      ? `${formatTime((this._value.frameIndex / Math.max(1, maxFrameCount - 1)) * this.getTimelineDuration())} / ${formatTime(
          this.getTimelineDuration(),
        )}`
      : maxFrameCount
        ? `${this._value.frameIndex + 1}/${maxFrameCount}`
        : "0/0";
  }

  setImageElement(element, url) {
    element.hidden = !url;
    if (!url) {
      element.removeAttribute("src");
      return;
    }
    if (element.getAttribute("src") !== url) {
      element.src = url;
    }
  }

  setVideoElement(element, video) {
    const url = video?.sourceUrl || "";
    element.hidden = !url;
    if (!url) {
      element.pause?.();
      element.removeAttribute("src");
      element.load?.();
      return;
    }
    if (element.getAttribute("src") !== url) {
      element.src = url;
      element.load?.();
    }
  }

  renderSelector() {
    this.selector.replaceChildren();

    if (!this._value.videos.length) {
      const empty = document.createElement("span");
      empty.className = "xf-video-compare-node2__item-name";
      empty.textContent = "No videos";
      this.selector.appendChild(empty);
      return;
    }

    for (const video of this._value.videos) {
      const item = document.createElement("div");
      item.className = "xf-video-compare-node2__item";
      if (this.isHidden(video.id)) {
        item.classList.add("is-hidden");
      }
      if (this._value.leftId === video.id || this._value.rightId === video.id) {
        item.classList.add("is-selected");
      }

      const left = this.makeSelectorButton("L", this._value.leftId === video.id, () => this.setLeft(video), this.isHidden(video.id));
      const right = this.makeSelectorButton("R", this._value.rightId === video.id, () => this.setRight(video), this.isHidden(video.id));
      const hidden = this.makeSelectorButton(this.isHidden(video.id) ? "S" : "H", this.isHidden(video.id), () =>
        this.toggleHidden(video),
      );

      const label = document.createElement("span");
      label.className = "xf-video-compare-node2__item-name";
      label.title = isSourceVideo(video) ? `${video.name} (original video)` : `${video.name} (${video.frames.length} frames)`;
      label.textContent = video.name;
      item.append(left, right, hidden, label);
      this.selector.appendChild(item);
    }
  }

  makeSelectorButton(label, active, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    if (active) {
      button.classList.add("is-active");
    }
    button.addEventListener("click", (event) => {
      stopNodeDrag(event);
      this.activate();
      this.element.focus?.();
      action();
    });
    return button;
  }

  getHeight() {
    return this.getReservedHeight() + this.getPreviewHeight();
  }

  syncNodeHeight() {
    const widgetY = Number(this.domWidget?.y);
    if (!this.node?.size || !Number.isFinite(widgetY) || widgetY <= 0) {
      return;
    }

    const desiredHeight = widgetY + this.getHeight() + NODE_BOTTOM_PADDING;
    const currentHeight = Number(this.node.size[1]) || 0;
    if (currentHeight < desiredHeight - 1 || currentHeight > desiredHeight + HEIGHT_TOLERANCE) {
      this.node.size[1] = desiredHeight;
      this.node.setDirtyCanvas?.(true, true);
    }
  }

  requestLayout() {
    this.syncNodeHeight();
    this.node.setDirtyCanvas?.(true, true);
  }

  serializeValue() {
    return {
      videos: this._value.videos.map((video) => {
        const cleanVideo = {
          ...video,
          frames: (video.frames || []).map((frame) => {
          const clean = { ...frame };
          delete clean.preloadImage;
          return clean;
          }),
        };
        delete cleanVideo.isSeeking;
        delete cleanVideo.seekToken;
        delete cleanVideo.preferSnapshot;
        delete cleanVideo.snapshotHoldUntil;
        delete cleanVideo.hasSnapshot;
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
}

function installNode2Widget(node) {
  if (!isNodes2Enabled()) {
    return null;
  }

  if (node[NODE2_WIDGET_NAME]) {
    return node[NODE2_WIDGET_NAME];
  }

  if (typeof node.addDOMWidget !== "function") {
    return null;
  }

  node.serialize_widgets = true;
  node.properties = node.properties || {};

  const element = document.createElement("div");
  const view = new Node2VideoCompareView(node, element);
  const domWidget = node.addDOMWidget(NODE2_WIDGET_NAME, "custom", element, {
    hideOnZoom: false,
    getMinHeight: () => view.getHeight(),
    getHeight: () => view.getHeight(),
    afterResize: () => {
      view.render();
    },
    getValue: () => view.serializeValue(),
    setValue: (value) => {
      view.value = value;
    },
  });

  view.domWidget = domWidget;
  node[NODE2_WIDGET_NAME] = view;
  view.activate();
  return view;
}

function getNodeFromExecutionId(nodeId) {
  const graph = app.graph || app.canvas?.graph;
  const id = Number(nodeId);
  if (!graph || !Number.isFinite(id)) {
    return null;
  }
  return graph.getNodeById?.(id) || null;
}

app.registerExtension({
  name: "xiaofu.MultiVideoCompare.Node2Dom",

  async setup() {
    installGlobalShortcuts();
    api.addEventListener("executed", (event) => {
      if (!isNodes2Enabled()) {
        return;
      }
      const detail = event.detail || {};
      const node = getNodeFromExecutionId(detail.display_node || detail.node);
      if (!isXiaoFuVideoNode(node)) {
        return;
      }
      const view = installNode2Widget(node);
      view?.setVideos(detail.output?.xiaofu_videos || []);
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) {
      return;
    }

    const proto = nodeType.prototype;
    const originalOnNodeCreated = proto.onNodeCreated;
    const originalOnExecuted = proto.onExecuted;
    const originalOnConnectionsChange = proto.onConnectionsChange;

    proto.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      if (isNodes2Enabled()) {
        installNode2Widget(this);
        stabilizeVideoInputs(this);
      }
      return result;
    };

    proto.onExecuted = function (output) {
      const result = originalOnExecuted?.apply(this, arguments);
      if (isNodes2Enabled()) {
        const view = installNode2Widget(this);
        view?.setVideos(output?.xiaofu_videos || []);
      }
      return result;
    };

    proto.onConnectionsChange = function () {
      const result = originalOnConnectionsChange?.apply(this, arguments);
      if (isNodes2Enabled()) {
        setTimeout(() => {
          installNode2Widget(this);
          stabilizeVideoInputs(this);
        }, 32);
      }
      return result;
    };
  },
});
