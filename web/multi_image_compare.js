import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_ID = "XiaoFuMultiImageCompare";
const WIDGET_NAME = "xiaofu_multi_image_compare";
const SLOT_PREFIX = "image_";
const MIN_INPUTS = 2;
const DEFAULT_NODE_WIDTH = 640;
const DEFAULT_NODE_HEIGHT = 760;
const RUNAWAY_NODE_HEIGHT = 1800;
const MIN_PREVIEW_HEIGHT = 260;
const MAX_PREVIEW_HEIGHT = 1200;
const TOOLBAR_HEIGHT = 26;
const LABEL_ROW_HEIGHT = 24;
const LABEL_GAP = 6;
const SELECTOR_ROW_HEIGHT = 24;
const WIDGET_PADDING = 10;
const WIDGET_BOTTOM_PADDING = 12;
const EDGE_SNAP_PX = 10;

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
    this.requestDraw(true);
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
          this.requestDraw(true);
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
    this.node.xiaofuCompareImages = [left || right, right || left].filter(Boolean);
    this.node.imgs = [];
    this.node.imageIndex = 0;
  }

  updatePointer(pos) {
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
    this.pointerOverPreview = inside;
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
    const area = this.findHitArea(pos);
    if (area) {
      area.action();
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

  getImageAspect(image) {
    const width = Number(image?.img?.naturalWidth || image?.width || 0);
    const height = Number(image?.img?.naturalHeight || image?.height || 0);
    if (width > 0 && height > 0) {
      return width / height;
    }
    return null;
  }

  getCompareAspect() {
    const aspects = [this.getImageAspect(this.leftImage), this.getImageAspect(this.rightImage)].filter(
      (aspect) => Number.isFinite(aspect) && aspect > 0,
    );
    if (!aspects.length) {
      return 4 / 3;
    }
    return aspects.reduce((total, aspect) => total + aspect, 0) / aspects.length;
  }

  getPreviewHeight(width) {
    const availableWidth = Math.max(1, (width || DEFAULT_NODE_WIDTH) - WIDGET_PADDING * 2);
    const aspect = this.getCompareAspect();
    return clamp(availableWidth / aspect, MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT);
  }

  getEstimatedSelectorItemWidth(image) {
    const labelWidth = Math.min(110, (image?.name?.length || 8) * 7 + 14);
    return 22 + 22 + 22 + labelWidth + 10;
  }

  estimateSelectorHeight(width, rowHeight = SELECTOR_ROW_HEIGHT) {
    if (!this._value.images.length) {
      return rowHeight;
    }

    const availableWidth = Math.max(1, (width || DEFAULT_NODE_WIDTH) - WIDGET_PADDING * 2);
    let x = 0;
    let rows = 1;
    for (const image of this._value.images) {
      const itemWidth = this.getEstimatedSelectorItemWidth(image);
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

  draw(ctx, node, width, y, height) {
    this.y = y;
    this.last_y = y;
    this.hitAreas = [];

    const widgetHeight = this.getDesiredWidgetHeight(width);
    this.syncNodeHeight(width, y);
    const rowHeight = SELECTOR_ROW_HEIGHT;
    const padding = WIDGET_PADDING;
    const selectorHeight = this.computeSelectorHeight(ctx, width - padding * 2, rowHeight);
    const toolbarHeight = TOOLBAR_HEIGHT;
    const previewY = y + toolbarHeight + 6;
    const previewHeight = Math.min(
      widgetHeight - toolbarHeight - selectorHeight - LABEL_GAP - LABEL_ROW_HEIGHT - padding - 14,
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

    this.drawToolbar(ctx, width, y, toolbarHeight);
    this.drawPreview(ctx, previewBounds, compareBounds);
    const labelY = previewY + previewHeight + LABEL_GAP;
    this.drawPreviewLabels(ctx, compareBounds, labelY, this.leftImage, this.rightImage);
    this.drawSelector(ctx, width, labelY + LABEL_ROW_HEIGHT + 8, rowHeight);
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

    const left = this.leftImage;
    const right = this.rightImage;
    const split = imageBounds.x + imageBounds.w * this._value.splitX;

    if (left?.img?.naturalWidth && left?.img?.naturalHeight) {
      this.drawContainedImage(ctx, left.img, imageBounds);
    }

    if (right?.img?.naturalWidth && right?.img?.naturalHeight && right.id !== left?.id) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(split, imageBounds.y, imageBounds.x + imageBounds.w - split, imageBounds.h);
      ctx.clip();
      this.drawContainedImage(ctx, right.img, imageBounds);
      ctx.restore();
    }

    if (!left && !right) {
      ctx.fillStyle = "rgba(230,230,230,0.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "13px Arial";
      ctx.fillText("No images", imageBounds.x + imageBounds.w / 2, imageBounds.y + imageBounds.h / 2);
    }

    this.drawSplitLine(ctx, split, imageBounds);
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

  drawPreviewLabels(ctx, bounds, y, left, right) {
    ctx.save();
    ctx.font = "12px Arial";
    ctx.textBaseline = "middle";
    const labelY = y + LABEL_ROW_HEIGHT / 2;
    this.drawOutsideLabel(ctx, `L: ${left?.name || "-"}`, bounds.x, labelY, "left");
    this.drawOutsideLabel(
      ctx,
      `R: ${right?.name || "-"}`,
      bounds.x + bounds.w,
      labelY,
      "right",
    );
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
  if (node[WIDGET_NAME]) {
    return node[WIDGET_NAME];
  }

  node.serialize_widgets = true;
  node.properties = node.properties || {};
  node.imageIndex = 0;
  node.imgs = [];

  const widget = new MultiImageCompareWidget(node);
  node[WIDGET_NAME] = widget;

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
      const pointerPos = findPoint([pos, event]);
      if (pointerPos) {
        this[WIDGET_NAME]?.updatePointer(pointerPos);
      }
      return result;
    };

    proto.onMouseDown = function (event, pos) {
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
