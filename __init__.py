import re

from nodes import PreviewImage


NODE_ID = "XiaoFuMultiImageCompare"
NODE_DISPLAY_NAME = "XiaoFu Multi Image Compare"


class DynamicImageInputs(dict):
    """Accept dynamically added image_XX inputs from the frontend."""

    def __getitem__(self, key):
        if self._is_image_key(key):
            return ("IMAGE",)
        raise KeyError(key)

    def __contains__(self, key):
        return self._is_image_key(key)

    @staticmethod
    def _is_image_key(key):
        return isinstance(key, str) and re.match(r"^image_\d+$", key) is not None


def image_slot_sort_key(item):
    key = item[0]
    match = re.match(r"^image_(\d+)$", key)
    if match:
        return (0, int(match.group(1)))
    return (1, key)


def image_tensor_size(image_tensor):
    shape = getattr(image_tensor, "shape", None)
    if shape is None:
        return None, None

    if len(shape) >= 4:
        return int(shape[2]), int(shape[1])
    if len(shape) >= 3:
        return int(shape[1]), int(shape[0])
    return None, None


class XiaoFuMultiImageCompare(PreviewImage):
    DESCRIPTION = "Preview and compare multiple images with selectable left/right slots."
    CATEGORY = "XiaoFu/Image"
    FUNCTION = "compare_images"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    SEARCH_ALIASES = ["compare image", "multi image compare", "image preview"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": DynamicImageInputs(),
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def compare_images(
        self,
        filename_prefix="xiaofu.compare.",
        prompt=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        images = []
        image_inputs = sorted(
            ((key, value) for key, value in kwargs.items() if key in DynamicImageInputs()),
            key=image_slot_sort_key,
        )

        for slot_name, image_tensor in image_inputs:
            if image_tensor is None:
                continue
            try:
                if len(image_tensor) == 0:
                    continue
            except TypeError:
                pass

            image_width, image_height = image_tensor_size(image_tensor)
            saved = self.save_images(
                image_tensor,
                filename_prefix,
                prompt,
                extra_pnginfo,
            )["ui"]["images"]

            for batch_index, image_data in enumerate(saved):
                item = dict(image_data)
                item["source_slot"] = slot_name
                item["batch_index"] = batch_index
                item["id"] = f"{slot_name}:{batch_index}"
                if image_width and image_height:
                    item["width"] = image_width
                    item["height"] = image_height
                item["name"] = (
                    slot_name
                    if len(saved) == 1
                    else f"{slot_name}_{str(batch_index + 1).zfill(2)}"
                )
                images.append(item)

        return {"ui": {"xiaofu_images": images}}


NODE_CLASS_MAPPINGS = {
    NODE_ID: XiaoFuMultiImageCompare,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}

WEB_DIRECTORY = "./web"

print(f"[XiaoFu Image Compare] Loaded: {NODE_DISPLAY_NAME}")

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
