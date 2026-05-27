# XiaoFu Image Compare

A lightweight ComfyUI custom node for comparing multiple images in one preview node.

## Features

- Compare two selected images with a vertical slide divider.
- Connect multiple `IMAGE` inputs from ComfyUI's built-in `Load Image` nodes.
- Pick the left and right comparison images with `L` and `R` buttons.
- Hide or show images with the `H` / `S` button.
- Add more `image_XX` input slots with `Add`.
- Remove unused empty image input slots with `Clean`.
- No extra Python dependencies.
- Supports both ComfyUI classic nodes and Nodes 2.0.
- Uses a dedicated DOM widget in Nodes 2.0 so buttons, the slide divider, and rerun image refreshes keep working.

## Installation

Clone or download this repository into your ComfyUI `custom_nodes` directory:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Yifo98/xiaofu-image-compare.git
```

Then restart ComfyUI.

You should see this startup line:

```text
[XiaoFu Image Compare] Loaded: XiaoFu Multi Image Compare
```

## Usage

1. Add one or more ComfyUI built-in `Load Image` nodes.
2. Add `XiaoFu Multi Image Compare` from `XiaoFu/Image`.
3. Connect the `IMAGE` outputs into `image_01`, `image_02`, and more slots.
4. Run the workflow.
5. Use `L` and `R` to choose which two images to compare.
6. Move the mouse over the preview to slide the divider.

## Important Nodes 2.0 migration note

If you used an older version of this plugin in an existing workflow and want to use Nodes 2.0, delete the old `XiaoFu Multi Image Compare` node from the workflow first.

Then pull the latest plugin, restart ComfyUI, add a fresh `XiaoFu Multi Image Compare` node, reconnect the image inputs, and run the workflow once.

Old serialized widget state from the previous classic-only implementation can keep stale preview data or layout state around, especially after switching Nodes 2.0 on.

## Notes

- Classic nodes use a canvas widget.
- Nodes 2.0 uses a separate DOM widget.
- `Add` only adds another image input slot. It does not upload images.
- Image upload is handled by ComfyUI's built-in `Load Image` node.
- The plugin is designed to run inside whatever Python environment ComfyUI already uses, including Conda, venv, or portable builds.
- This node uses ComfyUI's built-in `PreviewImage` behavior to save temporary preview images, so no model files or external services are required.

## Compatibility

Tested locally with:

- ComfyUI `0.22.2`
- ComfyUI frontend `1.42.15`
- Python `3.12`

It should also work in other recent ComfyUI versions that support custom nodes with `NODE_CLASS_MAPPINGS` and frontend extensions through `WEB_DIRECTORY`.

## License

Choose and add a license before publishing if you want other people to reuse, modify, or redistribute the code clearly.
