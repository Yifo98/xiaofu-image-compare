import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "XiaoFuMultiImageCompare";
const WIDGET_NAME = "xiaofu_multi_image_compare";
const SLOT_PREFIX = "image_";
const MIN_INPUTS = 2;
const DEFAULT_NODE_WIDTH = 420;
const DEFAULT_NODE_HEIGHT = 380;
const DEFAULT_WIDGET_HEIGHT = 300;
const WIDGET_TOP_ESTIMATE = 120;

function slotName(index) {
  return `${SLOT_PREFIX}${String(index + 1).padStart(2, "0")}`;
}

function isImageInput(input) {
  return input?.name?.startsWith(SLOT_PREFIX);
}

function imageDataToUrl(data) {
  if (data.url) {
    return data.url;
  }
  return api.apiURL(
    `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${
      data.subfolder || ""
    }${app.getPreviewFormatParam()}${app.getRandParam()}`,
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function normalizeHiddenIds(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  return [];
}

class MultiImageCompareWidget {
  constructor(node) {
    this.name = WIDGET_NAME;
    this.type = "custom";
    this.options = {};
    this.y = 0;
    this.last_y = 0;
    this.node = node;
    this.hitAreas = [];
    this.previewBounds = null;
    this.pointerOverPreview = false;
    this._value = {
      images: [],
      leftId: null,
      rightId: null,
      hiddenIds: [],
      splitX: 0.5,
    };
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
    this.ensureLoadedImages();
    this.updateNodeImages();
  }

  setImages(serverImages) {
    const previous = this._value;
    const previousHidden = new Set(previous.hiddenIds || []);
    const images = (serverImages || []).map((image, index) => this.prepareImageRecord(image, index));
    const ids = new Set(images.map((image) => image.id));
    const hiddenIds = [...previousHidden].filter((id) => ids.has(id));

    this._value = {
      images,
      leftId: ids.has(previous.leftId) ? previous.leftId : null,
      rightId: ids.has(previous.rightId) ? previous.rightId : null,
      hiddenIds,
      splitX: Number.isFinite(previous.splitX) ? previous.splitX : 0.5,
    };

    this.ensureSelection();
    this.ensureLoadedImages();
    this.updateNodeImages();
    this.requestDraw();
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

  ensureLoadedImages() {
    for (const image of this._value.images) {
      if (!image.img && image.url) {
        const htmlImage = new Image();
        htmlImage.onload = () => {
          this.updateNodeImages();
          this.requestDraw();
        };
        htmlImage.src = image.url;
        image.img = htmlImage;
      }
    }
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

  setLeft(image) {
    if (this.isHidden(image.id)) {
      return;
    }
    this._value.leftId = image.id;
    if (this._value.rightId === image.id) {
      this._value.rightId = this.getVisibleImages().find((item) => item.id !== image.id)?.id || image.id;
    }
    this.updateNodeImages();
    this.requestDraw();
  }

  setRight(image) {
    if (this.isHidden(image.id)) {
      return;
    }
    this._value.rightId = image.id;
    if (this._value.leftId === image.id) {
      this._value.leftId = this.getVisibleImages().find((item) => item.id !== image.id)?.id || image.id;
    }
    this.updateNodeImages();
    this.requestDraw();
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
    this.updateNodeImages();
    this.requestDraw();
  }

  isHidden(id) {
    return (this._value.hiddenIds || []).includes(id);
  }

  updateNodeImages() {
    const left = this.leftImage?.img || null;
    const right = this.rightImage?.img || null;
    this.node.imgs = [left || right, right || left].filter(Boolean);
    this.node.imageIndex = this.node.imageIndex || 0;
  }

  updatePointer(pos) {
    const normalized = this.normalizePos(pos, this.previewBounds);
    if (!normalized || !this.previewBounds) {
      return;
    }
    const bounds = this.previewBounds;
    const inside =
      normalized[0] >= bounds.x &&
      normalized[0] <= bounds.x + bounds.w &&
      normalized[1] >= bounds.y &&
      normalized[1] <= bounds.y + bounds.h;
    this.pointerOverPreview = inside;
    if (inside) {
      this._value.splitX = clamp((normalized[0] - bounds.x) / bounds.w, 0, 1);
      this.node.imageIndex = this._value.splitX > 0.5 ? 1 : 0;
      this.requestDraw();
    }
  }

  normalizePos(pos, bounds) {
    if (!pos) {
      return null;
    }
    const candidates = [
      [pos[0], pos[1]],
      [pos[0], pos[1] + this.last_y],
    ];

    if (!bounds) {
      return candidates[0];
    }

    return (
      candidates.find(
        (candidate) =>
          candidate[0] >= bounds.x &&
          candidate[0] <= bounds.x + bounds.w &&
          candidate[1] >= bounds.y &&
          candidate[1] <= bounds.y + bounds.h,
      ) || candidates[0]
    );
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
    const area = this.findHitArea(pos);
    if (area) {
      area.action();
      return true;
    }
    this.updatePointer(pos);
    return false;
  }

  requestDraw() {
    this.node.setDirtyCanvas?.(true, false);
  }

  serializeValue() {
    return {
      images: this._value.images.map((image) => {
        const clean = { ...image };
        delete clean.img;
        return clean;
      }),
      leftId: this._value.leftId,
      rightId: this._value.rightId,
      hiddenIds: this._value.hiddenIds || [],
      splitX: this._value.splitX,
    };
  }

  getDesiredWidgetHeight() {
    const nodeHeight = this.node?.size?.[1] || DEFAULT_NODE_HEIGHT;
    return Math.max(DEFAULT_WIDGET_HEIGHT, nodeHeight - WIDGET_TOP_ESTIMATE);
  }

  computeSize(width) {
    return [width, this.getDesiredWidgetHeight()];
  }

  draw(ctx, node, width, y, height) {
    this.y = y;
    this.last_y = y;
    this.hitAreas = [];

    const widgetHeight = Math.max(height || 0, this.getDesiredWidgetHeight());
    const rowHeight = 24;
    const padding = 10;
    const selectorHeight = this.computeSelectorHeight(ctx, width - padding * 2, rowHeight);
    const toolbarHeight = 26;
    const previewY = y + toolbarHeight + 6;
    const previewHeight = Math.max(120, widgetHeight - toolbarHeight - selectorHeight - padding);
    const previewBounds = {
      x: padding,
      y: previewY,
      w: width - padding * 2,
      h: previewHeight,
    };
    this.previewBounds = previewBounds;

    this.drawToolbar(ctx, width, y, toolbarHeight);
    this.drawPreview(ctx, previewBounds);
    this.drawSelector(ctx, width, previewY + previewHeight + 8, rowHeight);
  }

  computeSelectorHeight(ctx, availableWidth, rowHeight) {
    if (!this._value.images.length) {
      return rowHeight;
    }

    ctx.save();
    ctx.font = "12px Arial";
    let x = 0;
    let rows = 1;
    for (const image of this._value.images) {
      const itemWidth = this.getSelectorItemWidth(ctx, image);
      if (x > 0 && x + itemWidth > availableWidth) {
        rows += 1;
        x = 0;
      }
      x += itemWidth + 6;
    }
    ctx.restore();
    return rows * rowHeight;
  }

  drawToolbar(ctx, width, y, height) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#d6d6d6";
    ctx.fillText("Multi Image Compare", 10, y + height / 2);

    this.drawButton(ctx, width - 98, y + 3, 42, height - 6, "Add", () => addImageInput(this.node));
    this.drawButton(ctx, width - 50, y + 3, 40, height - 6, "Clean", () =>
      removeEmptyImageInputs(this.node),
    );
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
      this.hitAreas.push({ x, y, w: width, h: height, action });
    }
  }

  drawPreview(ctx, bounds) {
    ctx.save();
    ctx.fillStyle = "#151515";
    ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

    const left = this.leftImage;
    const right = this.rightImage;
    const split = bounds.x + bounds.w * this._value.splitX;

    if (left?.img?.naturalWidth && left?.img?.naturalHeight) {
      this.drawContainedImage(ctx, left.img, bounds);
    }

    if (right?.img?.naturalWidth && right?.img?.naturalHeight && right.id !== left?.id) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(split, bounds.y, bounds.x + bounds.w - split, bounds.h);
      ctx.clip();
      this.drawContainedImage(ctx, right.img, bounds);
      ctx.restore();
    }

    if (!left && !right) {
      ctx.fillStyle = "rgba(230,230,230,0.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "13px Arial";
      ctx.fillText("No images", bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
    }

    this.drawSplitLine(ctx, split, bounds);
    this.drawPreviewLabels(ctx, bounds, left, right);
    ctx.restore();
  }

  drawContainedImage(ctx, image, bounds) {
    const imageAspect = image.naturalWidth / image.naturalHeight;
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

    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  }

  drawSplitLine(ctx, split, bounds) {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.beginPath();
    ctx.moveTo(split + 1, bounds.y);
    ctx.lineTo(split + 1, bounds.y + bounds.h);
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(split, bounds.y);
    ctx.lineTo(split, bounds.y + bounds.h);
    ctx.stroke();
    ctx.restore();
  }

  drawPreviewLabels(ctx, bounds, left, right) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "bottom";
    this.drawOverlayLabel(ctx, `L: ${left?.name || "-"}`, bounds.x + 8, bounds.y + bounds.h - 8, "left");
    this.drawOverlayLabel(
      ctx,
      `R: ${right?.name || "-"}`,
      bounds.x + bounds.w - 8,
      bounds.y + bounds.h - 8,
      "right",
    );
    ctx.restore();
  }

  drawOverlayLabel(ctx, text, x, y, align) {
    const maxWidth = Math.max(80, this.previewBounds.w * 0.42);
    const fitted = fitText(ctx, text, maxWidth);
    const textWidth = ctx.measureText(fitted).width;
    const boxWidth = textWidth + 12;
    const boxX = align === "right" ? x - boxWidth : x;

    ctx.fillStyle = "rgba(0,0,0,0.58)";
    ctx.fillRect(boxX, y - 18, boxWidth, 20);
    ctx.fillStyle = "#f7f7f7";
    ctx.textAlign = align;
    ctx.fillText(fitted, x, y - 3);
  }

  getSelectorItemWidth(ctx, image) {
    const labelWidth = Math.min(110, ctx.measureText(image.name).width + 14);
    return 22 + 22 + 22 + labelWidth + 10;
  }

  drawSelector(ctx, width, y, rowHeight) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";

    if (!this._value.images.length) {
      ctx.fillStyle = "rgba(210,210,210,0.55)";
      ctx.fillText("Run the node to show images", 10, y + rowHeight / 2);
      ctx.restore();
      return;
    }

    let x = 10;
    const maxX = width - 10;
    for (const image of this._value.images) {
      const itemWidth = this.getSelectorItemWidth(ctx, image);
      if (x > 10 && x + itemWidth > maxX) {
        x = 10;
        y += rowHeight;
      }
      this.drawSelectorItem(ctx, image, x, y + 2, itemWidth, rowHeight - 4);
      x += itemWidth + 6;
    }

    ctx.restore();
  }

  drawSelectorItem(ctx, image, x, y, width, height) {
    const hidden = this.isHidden(image.id);
    const isLeft = this._value.leftId === image.id;
    const isRight = this._value.rightId === image.id;

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
    this.drawSmallToggle(ctx, cursor, y + 3, "L", isLeft, () => this.setLeft(image), hidden);
    cursor += 22;
    this.drawSmallToggle(ctx, cursor, y + 3, "R", isRight, () => this.setRight(image), hidden);
    cursor += 22;
    this.drawSmallToggle(ctx, cursor, y + 3, hidden ? "S" : "H", hidden, () => this.toggleHidden(image));
    cursor += 24;

    ctx.fillStyle = hidden ? "rgba(220,220,220,0.35)" : "#eeeeee";
    ctx.textAlign = "left";
    const label = fitText(ctx, image.name, Math.max(30, width - (cursor - x) - 8));
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
      this.hitAreas.push({ x, y, w: size, h: size, action });
    }
  }

  mouse(event, pos) {
    if (event.type === "pointerdown") {
      return this.handlePointerDown(pos);
    }

    if (event.type === "pointermove") {
      this.updatePointer(pos);
      return true;
    }

    return false;
  }
}

function installWidget(node) {
  if (node[WIDGET_NAME]) {
    return node[WIDGET_NAME];
  }

  node.serialize_widgets = true;
  node.properties = node.properties || {};
  node.imageIndex = node.imageIndex || 0;
  node.imgs = node.imgs || [];

  const widget = new MultiImageCompareWidget(node);
  node[WIDGET_NAME] = widget;

  if (typeof node.addCustomWidget === "function") {
    node.addCustomWidget(widget);
  } else {
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }

  if (!node.size || node.size[0] < DEFAULT_NODE_WIDTH || node.size[1] < DEFAULT_NODE_HEIGHT) {
    node.size = [
      Math.max(node.size?.[0] || 0, DEFAULT_NODE_WIDTH),
      Math.max(node.size?.[1] || 0, DEFAULT_NODE_HEIGHT),
    ];
  }

  return widget;
}

app.registerExtension({
  name: "xiaofu.MultiImageCompare",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_ID) {
      return;
    }

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
      installWidget(this);
      stabilizeImageInputs(this);
      return result;
    };

    proto.onExecuted = function (output) {
      const widget = installWidget(this);
      widget.setImages(output?.xiaofu_images || output?.images || []);
      return undefined;
    };

    proto.onConnectionsChange = function () {
      const result = originalOnConnectionsChange?.apply(this, arguments);
      setTimeout(() => stabilizeImageInputs(this), 32);
      return result;
    };

    proto.onMouseMove = function (event, pos) {
      const result = originalOnMouseMove?.apply(this, arguments);
      if (pos) {
        this[WIDGET_NAME]?.updatePointer(pos);
      }
      return result;
    };

    proto.onMouseDown = function (event, pos) {
      if (pos) {
        const handled = this[WIDGET_NAME]?.handlePointerDown(pos);
        if (handled) {
          return true;
        }
      }
      return originalOnMouseDown?.apply(this, arguments);
    };

    proto.onMouseLeave = function () {
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
      return withoutNativePreviewImages(this, originalOnDrawBackground, arguments);
    };

    proto.onDrawForeground = function () {
      return withoutNativePreviewImages(this, originalOnDrawForeground, arguments);
    };

    proto.onSerialize = function (serialized) {
      const result = originalOnSerialize?.apply(this, arguments);
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
      options.push(
        null,
        {
          content: "Add Image Input",
          callback: () => addImageInput(this),
        },
        {
          content: "Remove Empty Image Inputs",
          callback: () => removeEmptyImageInputs(this),
        },
      );
    };
  },
});
