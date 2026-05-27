import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "XiaoFuMultiImageCompare";
const CLASSIC_WIDGET_NAME = "xiaofu_multi_image_compare";
const NODE2_WIDGET_NAME = "xiaofu_multi_image_compare_node2";
const SLOT_PREFIX = "image_";
const MIN_INPUTS = 2;
const STYLE_ID = "xiaofu-image-compare-node2-style";
const MIN_PREVIEW_HEIGHT = 280;
const MAX_PREVIEW_HEIGHT = 1200;
const NODE_BOTTOM_PADDING = 18;
const HEIGHT_TOLERANCE = 80;
const EDGE_SNAP_PX = 10;
const TOOLBAR_HEIGHT = 28;
const LABEL_ROW_HEIGHT = 22;
const SELECTOR_ROW_HEIGHT = 30;
const SECTION_GAP = 8;
const WIDGET_VERTICAL_PADDING = 16;

function slotName(index) {
  return `${SLOT_PREFIX}${String(index + 1).padStart(2, "0")}`;
}

function isNodes2Enabled() {
  return (
    app.extensionManager?.setting?.get?.("Comfy.VueNodes.Enabled") === true ||
    globalThis.LiteGraph?.vueNodesMode === true
  );
}

function isXiaoFuNode(node) {
  return node?.constructor?.comfyClass === NODE_ID || node?.comfyClass === NODE_ID || node?.type === NODE_ID;
}

function isImageInput(input) {
  return input?.name?.startsWith(SLOT_PREFIX);
}

function getImageInputs(node) {
  return (node.inputs || [])
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => isImageInput(input));
}

function renameImageInputs(node) {
  for (const [index, item] of getImageInputs(node).entries()) {
    item.input.name = slotName(index);
    item.input.label = slotName(index);
    item.input.type = "IMAGE";
  }
}

function addImageInput(node) {
  const count = getImageInputs(node).length;
  node.addInput(slotName(count), "IMAGE");
  renameImageInputs(node);
  node.setDirtyCanvas?.(true, true);
}

function stabilizeImageInputs(node) {
  if (!node.inputs) {
    return;
  }

  let imageInputs = getImageInputs(node);
  while (imageInputs.length < MIN_INPUTS) {
    addImageInput(node);
    imageInputs = getImageInputs(node);
  }

  let highestLinked = -1;
  for (const [position, item] of imageInputs.entries()) {
    if (item.input.link != null) {
      highestLinked = position;
    }
  }

  const desiredCount = Math.max(MIN_INPUTS, highestLinked + 2);
  while (imageInputs.length > desiredCount) {
    const last = imageInputs[imageInputs.length - 1];
    if (!last || last.input.link != null) {
      break;
    }
    node.removeInput(last.index);
    imageInputs = getImageInputs(node);
  }

  while (imageInputs.length < desiredCount) {
    addImageInput(node);
    imageInputs = getImageInputs(node);
  }

  renameImageInputs(node);
  node.setDirtyCanvas?.(true, true);
}

function removeEmptyImageInputs(node) {
  let imageInputs = getImageInputs(node);
  for (let i = imageInputs.length - 1; i >= MIN_INPUTS; i--) {
    const item = imageInputs[i];
    if (item?.input.link == null) {
      node.removeInput(item.index);
    }
  }
  stabilizeImageInputs(node);
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

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.xf-compare-node2 {
  box-sizing: border-box;
  width: 100%;
  min-width: 320px;
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
.xf-compare-node2 * {
  box-sizing: border-box;
}
.xf-compare-node2__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
}
.xf-compare-node2__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(242, 242, 242, 0.86);
  font-weight: 600;
}
.xf-compare-node2 button {
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
.xf-compare-node2 button:hover {
  background: rgba(78, 78, 78, 0.98);
}
.xf-compare-node2 button.is-active {
  background: #f5f5f5;
  color: #111;
}
.xf-compare-node2 button:disabled {
  cursor: default;
  opacity: 0.42;
}
.xf-compare-node2__preview {
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
.xf-compare-node2__preview [hidden] {
  display: none !important;
}
.xf-compare-node2__preview img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  pointer-events: none;
}
.xf-compare-node2__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(235, 235, 235, 0.58);
}
.xf-compare-node2__divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(255, 255, 255, 0.82);
  transform: translateX(-0.5px);
  pointer-events: none;
}
.xf-compare-node2__divider::after {
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
.xf-compare-node2__labels {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
}
.xf-compare-node2__label {
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
.xf-compare-node2__selector {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}
.xf-compare-node2__item {
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
.xf-compare-node2__item.is-selected {
  border-color: rgba(255, 255, 255, 0.86);
}
.xf-compare-node2__item.is-hidden {
  opacity: 0.5;
}
.xf-compare-node2__item-name {
  min-width: 38px;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #eeeeee;
}
`;
  document.head.appendChild(style);
}

class Node2CompareView {
  constructor(node, element) {
    this.node = node;
    this.element = element;
    this.domWidget = null;
    this._value = {
      images: [],
      leftId: null,
      rightId: null,
      hiddenIds: [],
      splitX: 0.5,
    };

    this.build();
  }

  get value() {
    return this._value;
  }

  set value(nextValue) {
    const value = nextValue || {};
    const images = Array.isArray(value.images) ? value.images : [];
    this._value = {
      images: images.map((image, index) => this.prepareImageRecord(image, index)),
      leftId: value.leftId || null,
      rightId: value.rightId || null,
      hiddenIds: normalizeHiddenIds(value.hiddenIds),
      splitX: Number.isFinite(value.splitX) ? clamp(value.splitX, 0, 1) : 0.5,
    };
    this.ensureSelection();
    this.render();
  }

  build() {
    ensureStyle();
    this.element.className = "xf-compare-node2";
    this.element.addEventListener("pointerdown", stopNodeDrag);
    this.element.addEventListener("click", stopNodeDrag);
    this.element.addEventListener("dblclick", stopNodeDrag);

    this.toolbar = document.createElement("div");
    this.toolbar.className = "xf-compare-node2__toolbar";

    this.title = document.createElement("div");
    this.title.className = "xf-compare-node2__title";
    this.title.textContent = "Multi Image Compare";

    this.addButton = document.createElement("button");
    this.addButton.type = "button";
    this.addButton.textContent = "Add";
    this.addButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      addImageInput(this.node);
    });

    this.cleanButton = document.createElement("button");
    this.cleanButton.type = "button";
    this.cleanButton.textContent = "Clean";
    this.cleanButton.addEventListener("click", (event) => {
      stopNodeDrag(event);
      removeEmptyImageInputs(this.node);
    });

    this.toolbar.append(this.title, this.addButton, this.cleanButton);

    this.preview = document.createElement("div");
    this.preview.className = "xf-compare-node2__preview";
    this.preview.addEventListener("pointerdown", (event) => {
      stopNodeDrag(event);
      this.updateSplitFromEvent(event);
      this.preview.setPointerCapture?.(event.pointerId);
    });
    this.preview.addEventListener("pointermove", (event) => {
      stopNodeDrag(event);
      this.updateSplitFromEvent(event);
    });

    this.leftImageEl = document.createElement("img");
    this.rightImageEl = document.createElement("img");
    this.divider = document.createElement("div");
    this.divider.className = "xf-compare-node2__divider";
    this.empty = document.createElement("div");
    this.empty.className = "xf-compare-node2__empty";
    this.preview.append(this.leftImageEl, this.rightImageEl, this.divider, this.empty);

    this.labels = document.createElement("div");
    this.labels.className = "xf-compare-node2__labels";
    this.leftLabel = document.createElement("div");
    this.leftLabel.className = "xf-compare-node2__label";
    this.rightLabel = document.createElement("div");
    this.rightLabel.className = "xf-compare-node2__label";
    this.labels.append(this.leftLabel, this.rightLabel);

    this.selector = document.createElement("div");
    this.selector.className = "xf-compare-node2__selector";

    this.element.append(this.toolbar, this.preview, this.labels, this.selector);
  }

  prepareImageRecord(image, index) {
    const id = image.id || `${image.source_slot || image.name || slotName(index)}:${image.batch_index || 0}`;
    return {
      ...image,
      id,
      name: image.name || image.source_slot || slotName(index),
      url: image.url || imageDataToUrl(image),
    };
  }

  setImages(serverImages) {
    const previous = this._value;
    const previousHidden = new Set(previous.hiddenIds || []);
    const images = (serverImages || []).map((image, index) => this.prepareImageRecord(image, index));
    const ids = new Set(images.map((image) => image.id));

    this._value = {
      images,
      leftId: ids.has(previous.leftId) ? previous.leftId : null,
      rightId: ids.has(previous.rightId) ? previous.rightId : null,
      hiddenIds: [...previousHidden].filter((id) => ids.has(id)),
      splitX: Number.isFinite(previous.splitX) ? previous.splitX : 0.5,
    };

    this.ensureSelection();
    this.render();
    this.requestLayout();
  }

  getVisibleImages() {
    const hidden = new Set(this._value.hiddenIds || []);
    return this._value.images.filter((image) => !hidden.has(image.id));
  }

  getImageById(id) {
    return this._value.images.find((image) => image.id === id);
  }

  get leftImage() {
    return this.getImageById(this._value.leftId);
  }

  get rightImage() {
    return this.getImageById(this._value.rightId);
  }

  getPreviewAspectRatio() {
    const image = this.leftImage || this.rightImage;
    const width = Number(image?.width);
    const height = Number(image?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return clamp(width / height, 0.35, 2.75);
    }
    return 1;
  }

  getPreviewHeight() {
    const nodeWidth = Number(this.node?.size?.[0]) || 640;
    const availableWidth = Math.max(320, nodeWidth - 16);
    return clamp(availableWidth / this.getPreviewAspectRatio(), MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT);
  }

  getSelectorRows() {
    return Math.max(1, Math.ceil((this._value.images.length || 1) / 2));
  }

  getReservedHeight() {
    return (
      WIDGET_VERTICAL_PADDING +
      TOOLBAR_HEIGHT +
      LABEL_ROW_HEIGHT +
      this.getSelectorRows() * SELECTOR_ROW_HEIGHT +
      SECTION_GAP * 3
    );
  }

  isHidden(id) {
    return (this._value.hiddenIds || []).includes(id);
  }

  ensureSelection() {
    const visibleImages = this.getVisibleImages();
    if (!visibleImages.length) {
      this._value.leftId = null;
      this._value.rightId = null;
      return;
    }

    if (!visibleImages.some((image) => image.id === this._value.leftId)) {
      this._value.leftId = visibleImages[0].id;
    }

    if (
      !visibleImages.some((image) => image.id === this._value.rightId) ||
      this._value.rightId === this._value.leftId
    ) {
      this._value.rightId =
        visibleImages.find((image) => image.id !== this._value.leftId)?.id || visibleImages[0].id;
    }
  }

  setLeft(image) {
    if (this.isHidden(image.id)) {
      return;
    }
    this._value.leftId = image.id;
    if (this._value.rightId === image.id) {
      this._value.rightId = this.getVisibleImages().find((item) => item.id !== image.id)?.id || image.id;
    }
    this.render();
  }

  setRight(image) {
    if (this.isHidden(image.id)) {
      return;
    }
    this._value.rightId = image.id;
    if (this._value.leftId === image.id) {
      this._value.leftId = this.getVisibleImages().find((item) => item.id !== image.id)?.id || image.id;
    }
    this.render();
  }

  toggleHidden(image) {
    const hidden = new Set(this._value.hiddenIds || []);
    if (hidden.has(image.id)) {
      hidden.delete(image.id);
    } else {
      hidden.add(image.id);
    }
    this._value.hiddenIds = [...hidden];
    this.ensureSelection();
    this.render();
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

  render() {
    this.renderPreview();
    this.renderSelector();
    this.syncNodeHeight();
  }

  renderPreview() {
    const left = this.leftImage;
    const right = this.rightImage;
    const hasImages = !!(left || right);
    const split = `${this._value.splitX * 100}%`;
    const aspectRatio = this.getPreviewAspectRatio();

    this.empty.hidden = hasImages;
    this.empty.style.display = hasImages ? "none" : "flex";
    this.divider.hidden = !hasImages;
    this.divider.style.left = split;
    this.preview.style.aspectRatio = `${aspectRatio}`;
    this.preview.style.height = `${this.getPreviewHeight()}px`;

    this.setImageElement(this.leftImageEl, left?.url || "");

    const showRight = !!right && right.id !== left?.id;
    this.setImageElement(this.rightImageEl, showRight ? right.url : "");
    this.rightImageEl.style.clipPath = `inset(0 0 0 ${split})`;

    this.leftLabel.textContent = `L: ${left?.name || "-"}`;
    this.rightLabel.textContent = `R: ${right?.name || "-"}`;
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

  renderSelector() {
    this.selector.replaceChildren();

    if (!this._value.images.length) {
      const empty = document.createElement("span");
      empty.className = "xf-compare-node2__item-name";
      empty.textContent = "No images";
      this.selector.appendChild(empty);
      return;
    }

    for (const image of this._value.images) {
      const item = document.createElement("div");
      item.className = "xf-compare-node2__item";
      if (this.isHidden(image.id)) {
        item.classList.add("is-hidden");
      }
      if (this._value.leftId === image.id || this._value.rightId === image.id) {
        item.classList.add("is-selected");
      }

      const left = this.makeSelectorButton("L", this._value.leftId === image.id, () => this.setLeft(image), this.isHidden(image.id));
      const right = this.makeSelectorButton("R", this._value.rightId === image.id, () => this.setRight(image), this.isHidden(image.id));
      const hidden = this.makeSelectorButton(this.isHidden(image.id) ? "S" : "H", this.isHidden(image.id), () =>
        this.toggleHidden(image),
      );

      const label = document.createElement("span");
      label.className = "xf-compare-node2__item-name";
      label.title = image.name;
      label.textContent = image.name;
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
      images: this._value.images.map((image) => {
        const clean = { ...image };
        return clean;
      }),
      leftId: this._value.leftId,
      rightId: this._value.rightId,
      hiddenIds: this._value.hiddenIds || [],
      splitX: this._value.splitX,
    };
  }
}

function markClassicWidgetInactive(widget) {
  if (!widget) {
    return;
  }

  widget.__xiaofuNode2Hidden = true;
  widget.hidden = true;
  widget.draw = () => {};
  widget.computeSize = () => [0, 0];
}

function hideClassicWidget(node) {
  let changed = false;

  markClassicWidgetInactive(node?.[CLASSIC_WIDGET_NAME]);

  if (Array.isArray(node?.widgets)) {
    for (let index = node.widgets.length - 1; index >= 0; index--) {
      const widget = node.widgets[index];
      if (widget?.name !== CLASSIC_WIDGET_NAME) {
        continue;
      }

      markClassicWidgetInactive(widget);
      node.__xiaofuNode2ClassicWidget = widget;
      node.widgets.splice(index, 1);
      changed = true;
    }
  }

  if (changed) {
    node.setDirtyCanvas?.(true, true);
  }
}

function scheduleClassicWidgetHide(node) {
  const hide = () => {
    if (!isNodes2Enabled()) {
      return;
    }
    hideClassicWidget(node);
    node[NODE2_WIDGET_NAME]?.requestLayout?.();
  };

  if (typeof queueMicrotask === "function") {
    queueMicrotask(hide);
  } else {
    setTimeout(hide, 0);
  }
}

function installNode2Widget(node) {
  if (!isNodes2Enabled()) {
    return null;
  }

  if (node[NODE2_WIDGET_NAME]) {
    hideClassicWidget(node);
    scheduleClassicWidgetHide(node);
    return node[NODE2_WIDGET_NAME];
  }

  if (typeof node.addDOMWidget !== "function") {
    return null;
  }

  node.serialize_widgets = true;
  node.properties = node.properties || {};

  const element = document.createElement("div");
  const view = new Node2CompareView(node, element);
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
  hideClassicWidget(node);
  scheduleClassicWidgetHide(node);
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
  name: "xiaofu.MultiImageCompare.Node2Dom",

  async setup() {
    api.addEventListener("executed", (event) => {
      if (!isNodes2Enabled()) {
        return;
      }
      const detail = event.detail || {};
      const node = getNodeFromExecutionId(detail.display_node || detail.node);
      if (!isXiaoFuNode(node)) {
        return;
      }
      const view = installNode2Widget(node);
      view?.setImages(detail.output?.xiaofu_images || detail.output?.images || []);
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
        stabilizeImageInputs(this);
        scheduleClassicWidgetHide(this);
      }
      return result;
    };

    proto.onExecuted = function (output) {
      const result = originalOnExecuted?.apply(this, arguments);
      if (isNodes2Enabled()) {
        const view = installNode2Widget(this);
        view?.setImages(output?.xiaofu_images || output?.images || []);
        scheduleClassicWidgetHide(this);
      }
      return result;
    };

    proto.onConnectionsChange = function () {
      const result = originalOnConnectionsChange?.apply(this, arguments);
      if (isNodes2Enabled()) {
        setTimeout(() => {
          installNode2Widget(this);
          stabilizeImageInputs(this);
          scheduleClassicWidgetHide(this);
        }, 32);
      }
      return result;
    };
  },
});
