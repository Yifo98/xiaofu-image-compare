import re
import os
import hashlib
import mimetypes
from fnmatch import fnmatch
from pathlib import Path

from nodes import PreviewImage

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


IMAGE_NODE_ID = "XiaoFuMultiImageCompare"
VIDEO_NODE_ID = "XiaoFuMultiVideoCompare"
VIDEO_FOLDER_NODE_ID = "XiaoFuLoadVideoFolder"
XIAOFU_NODE_ICON = "🌟"
XIAOFU_NODE_CATEGORY = f"{XIAOFU_NODE_ICON} XiaoFu"
IMAGE_NODE_DISPLAY_NAME = f"{XIAOFU_NODE_ICON} XiaoFu Multi Image Compare"
VIDEO_NODE_DISPLAY_NAME = f"{XIAOFU_NODE_ICON} XiaoFu Multi Video Compare"
VIDEO_FOLDER_NODE_DISPLAY_NAME = f"{XIAOFU_NODE_ICON} XiaoFu Load Video Folder"
NODE_ID = IMAGE_NODE_ID
NODE_DISPLAY_NAME = IMAGE_NODE_DISPLAY_NAME
VIDEO_FRAME_PREFIX = "frames_"
VIDEO_NATIVE_PREFIX = "clip_"
MIN_VIDEO_FRAME_INPUTS = 0
MIN_VIDEO_NATIVE_INPUTS = 12
DEFAULT_VIDEO_FPS = 12.0
DEFAULT_VIDEO_FRAME_STRIDE = 1
DEFAULT_VIDEO_MAX_FRAMES = 60
DEFAULT_VIDEO_PREVIEW_MAX_SIDE = 640
VIDEO_FOLDER_OUTPUT_COUNT = 12
DEFAULT_VIDEO_PATTERNS = "*.mp4;*.mov;*.mkv;*.webm;*.m4v"
VIDEO_SOURCE_REGISTRY = {}


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


class DynamicVideoInputs(dict):
    """Accept dynamically added frames_XX and clip_XX inputs from the frontend."""

    def __init__(self):
        super().__init__()
        for index in range(MIN_VIDEO_FRAME_INPUTS):
            self[f"{VIDEO_FRAME_PREFIX}{str(index + 1).zfill(2)}"] = ("IMAGE",)
        for index in range(MIN_VIDEO_NATIVE_INPUTS):
            self[f"{VIDEO_NATIVE_PREFIX}{str(index + 1).zfill(2)}"] = ("*",)

    def __getitem__(self, key):
        if self._is_frame_key(key):
            return ("IMAGE",)
        if self._is_native_key(key):
            return ("*",)
        raise KeyError(key)

    def __contains__(self, key):
        return self._is_frame_key(key) or self._is_native_key(key)

    @staticmethod
    def _is_frame_key(key):
        return isinstance(key, str) and re.match(rf"^{VIDEO_FRAME_PREFIX}\d+$", key) is not None

    @staticmethod
    def _is_native_key(key):
        return isinstance(key, str) and re.match(rf"^{VIDEO_NATIVE_PREFIX}\d+$", key) is not None


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


def video_slot_sort_key(item):
    key = item[0]
    for rank, prefix in enumerate((VIDEO_FRAME_PREFIX, VIDEO_NATIVE_PREFIX)):
        match = re.match(rf"^{prefix}(\d+)$", key)
        if match:
            return (0, int(match.group(1)), rank)
    return (1, key, 0)


def tensor_has_data(value):
    if value is None:
        return False

    numel = getattr(value, "numel", None)
    if callable(numel):
        try:
            return numel() > 0
        except TypeError:
            pass

    try:
        return len(value) > 0
    except TypeError:
        return True


def as_frame_batch(value):
    shape = getattr(value, "shape", None)
    if shape is None:
        return value
    if len(shape) == 3 and hasattr(value, "unsqueeze"):
        return value.unsqueeze(0)
    return value


def extract_video_frames(value):
    if value is None:
        return None

    direct = as_frame_batch(value)
    if getattr(direct, "shape", None) is not None and tensor_has_data(direct):
        return direct

    get_components = getattr(value, "get_components", None)
    if callable(get_components):
        try:
            components = get_components()
            images = getattr(components, "images", None)
            if tensor_has_data(images):
                return as_frame_batch(images)
        except Exception:
            pass

    if isinstance(value, dict):
        for key in ("frames", "images", "video"):
            candidate = value.get(key)
            frames = extract_video_frames(candidate)
            if frames is not None:
                return frames
        for candidate in value.values():
            frames = extract_video_frames(candidate)
            if frames is not None:
                return frames
        return None

    for attr in ("frames", "images", "video"):
        frames = extract_video_frames(getattr(value, attr, None))
        if frames is not None:
            return frames

    return None


def video_frame_count(frames):
    shape = getattr(frames, "shape", None)
    if shape is None:
        return 0
    if len(shape) >= 4:
        return int(shape[0])
    if len(shape) >= 3:
        return 1
    return 0


def video_frame_size(frames):
    shape = getattr(frames, "shape", None)
    if shape is None:
        return None, None
    if len(shape) >= 4:
        return int(shape[2]), int(shape[1])
    if len(shape) >= 3:
        return int(shape[1]), int(shape[0])
    return None, None


def sample_video_frames(frames, frame_stride, max_frames):
    frames = as_frame_batch(frames)
    total_frames = video_frame_count(frames)
    if total_frames <= 1:
        return frames

    stride = max(1, int(frame_stride or 1))
    limit = max(1, int(max_frames or total_frames))
    return frames[::stride][:limit]


def resize_video_preview_frames(frames, max_side=DEFAULT_VIDEO_PREVIEW_MAX_SIDE):
    width, height = video_frame_size(frames)
    if not width or not height or max(width, height) <= max_side:
        return frames

    try:
        import torch.nn.functional as torch_functional
    except Exception:
        return frames

    scale = max_side / max(width, height)
    target_height = max(1, int(round(height * scale)))
    target_width = max(1, int(round(width * scale)))

    try:
        channels_first = frames.movedim(-1, 1)
        resized = torch_functional.interpolate(
            channels_first,
            size=(target_height, target_width),
            mode="bilinear",
            align_corners=False,
        )
        return resized.movedim(1, -1)
    except Exception:
        return frames


def extract_video_fps(value, fallback):
    for source in (value, getattr(value, "metadata", None)):
        if not isinstance(source, dict):
            continue
        for key in ("fps", "frame_rate", "framerate"):
            try:
                fps = float(source.get(key) or 0)
            except (TypeError, ValueError):
                fps = 0
            if fps > 0:
                return fps
    return float(fallback or 12)


def extract_video_display_name(value, fallback):
    for source in (value, getattr(value, "metadata", None)):
        if isinstance(source, dict):
            for key in ("filename", "name", "path"):
                name = source.get(key)
                if name:
                    return Path(str(name)).name

    for attr in ("filename", "name", "path"):
        name = getattr(value, attr, None)
        if name:
            return Path(str(name)).name

    return fallback


def extract_video_reference(value):
    if value is None:
        return None

    if isinstance(value, dict):
        url = value.get("video_url") or value.get("source_url")
        path = value.get("path")
        video_id = value.get("video_id")
        if url or path or video_id:
            return {
                "video_url": url,
                "path": path,
                "video_id": video_id,
                "filename": value.get("filename") or value.get("name") or (Path(str(path)).name if path else None),
                "fps": value.get("fps"),
                "duration": value.get("duration"),
                "width": value.get("width"),
                "height": value.get("height"),
                "total_frames": value.get("total_frames"),
                "size_mb": value.get("size_mb"),
                "source_slot": value.get("source_slot"),
            }

    metadata = getattr(value, "metadata", None)
    if isinstance(metadata, dict):
        return extract_video_reference(metadata)

    return None


def parse_video_patterns(patterns):
    return [item.strip() for item in str(patterns or DEFAULT_VIDEO_PATTERNS).split(";") if item.strip()]


def split_video_source_paths(source_paths):
    if isinstance(source_paths, (list, tuple)):
        raw_items = source_paths
    else:
        raw_items = str(source_paths or "").splitlines()

    sources = []
    for item in raw_items:
        value = str(item).strip().strip('"').strip("'")
        if value:
            sources.append(value)
    return sources


def path_matches_video_patterns(path, patterns):
    return any(fnmatch(path.name.lower(), pattern.lower()) for pattern in patterns)


def list_video_files(source_paths, file_patterns, max_files):
    patterns = parse_video_patterns(file_patterns)
    sources = split_video_source_paths(source_paths)
    if not sources:
        raise ValueError("Choose one or more video files, or choose a folder first.")

    files = []
    seen = set()
    missing = []

    def add_file(path):
        resolved = path.expanduser()
        key = str(resolved.resolve()) if resolved.exists() else str(resolved)
        if key not in seen and path_matches_video_patterns(resolved, patterns):
            seen.add(key)
            files.append(resolved)

    for source in sources:
        path = Path(source).expanduser()
        if not path.exists():
            missing.append(str(path))
            continue

        if path.is_file():
            add_file(path)
        elif path.is_dir():
            for child in sorted(path.iterdir(), key=lambda item: item.name.lower()):
                if child.is_file():
                    add_file(child)
                if len(files) >= max_files:
                    break

        if len(files) >= max_files:
            break

    if not files and missing:
        raise ValueError(f"No matching video files found. Missing paths: {', '.join(missing[:3])}")
    if not files:
        raise ValueError("No matching video files found in the selected source.")

    return files[:max_files]


def connected_video_output_indices(prompt, unique_id, max_outputs):
    if max_outputs <= 0:
        return set()
    fallback = set(range(max_outputs))
    if prompt is None or unique_id is None:
        return fallback

    source_id = str(unique_id)
    connected = set()

    def add_index(value):
        try:
            index = int(value)
        except (TypeError, ValueError):
            return
        if 0 <= index < max_outputs:
            connected.add(index)

    def scan(value):
        if isinstance(value, dict):
            for item in value.values():
                scan(item)
            return

        if isinstance(value, (list, tuple)):
            if len(value) >= 2 and str(value[0]) == source_id:
                add_index(value[1])
                return
            if len(value) >= 6 and str(value[1]) == source_id:
                add_index(value[2])
                return
            for item in value:
                scan(item)

    if isinstance(prompt, dict):
        for node in prompt.get("nodes", []):
            if not isinstance(node, dict) or str(node.get("id")) != source_id:
                continue
            for index, output in enumerate(node.get("outputs") or []):
                links = output.get("links") if isinstance(output, dict) else None
                if links:
                    add_index(index)

    scan(prompt)
    return connected or fallback


def make_progress_bar(total, node_id=None):
    try:
        import comfy.utils
    except Exception:
        return None

    try:
        return comfy.utils.ProgressBar(max(1, int(total or 1)), node_id=node_id)
    except Exception:
        return None


def update_progress(progress_bar, value, total=None):
    if progress_bar is None:
        return
    try:
        progress_bar.update_absolute(value, total)
    except Exception:
        pass


def register_video_source(path):
    path = Path(path).expanduser()
    try:
        resolved = path.resolve()
    except Exception:
        resolved = path

    try:
        stat = resolved.stat()
        signature = f"{resolved}|{stat.st_mtime_ns}|{stat.st_size}"
    except OSError:
        signature = str(resolved)

    video_id = hashlib.sha256(signature.encode("utf-8")).hexdigest()[:24]
    VIDEO_SOURCE_REGISTRY[video_id] = str(resolved)
    return video_id


def probe_video_file_metadata(path):
    metadata = {
        "fps": DEFAULT_VIDEO_FPS,
        "duration": None,
        "width": None,
        "height": None,
        "total_frames": None,
    }

    try:
        import av
    except Exception:
        return metadata

    try:
        with av.open(str(path)) as container:
            stream = next((item for item in container.streams if item.type == "video"), None)
            if stream is None:
                return metadata

            if stream.average_rate:
                try:
                    metadata["fps"] = float(stream.average_rate)
                except (TypeError, ValueError, ZeroDivisionError):
                    pass

            metadata["total_frames"] = estimate_video_stream_frames(stream, metadata["fps"]) or None

            try:
                metadata["width"] = int(getattr(stream, "width", 0) or stream.codec_context.width or 0) or None
                metadata["height"] = int(getattr(stream, "height", 0) or stream.codec_context.height or 0) or None
            except Exception:
                pass

            try:
                if stream.duration and stream.time_base:
                    metadata["duration"] = float(stream.duration * stream.time_base)
                elif container.duration:
                    metadata["duration"] = float(container.duration / 1000000)
            except (TypeError, ValueError, OverflowError):
                pass
    except Exception:
        return metadata

    return metadata


def video_source_url(video_id):
    return f"/xiaofu-image-compare/video-file/{video_id}"


def build_video_reference(path, source_slot):
    path = Path(path).expanduser()
    metadata = probe_video_file_metadata(path)
    video_id = register_video_source(path)
    size_mb = video_file_size_mb(path)
    return {
        "video_id": video_id,
        "video_url": video_source_url(video_id),
        "path": str(path),
        "filename": path.name,
        "name": path.name,
        "source_slot": source_slot,
        "fps": metadata.get("fps") or DEFAULT_VIDEO_FPS,
        "duration": metadata.get("duration"),
        "width": metadata.get("width"),
        "height": metadata.get("height"),
        "total_frames": metadata.get("total_frames"),
        "size_mb": size_mb,
        "playback_mode": "source",
    }


def run_macos_video_picker(mode):
    import subprocess

    if mode == "folder":
        script = """
tell application "Finder" to activate
delay 0.1
set selectedFolder to choose folder with prompt "Choose video folder"
return POSIX path of selectedFolder
"""
    elif mode == "file":
        script = """
tell application "Finder" to activate
delay 0.1
set selectedFile to choose file with prompt "Choose video file" of type {"mp4", "mov", "mkv", "webm", "m4v"}
return POSIX path of selectedFile
"""
    else:
        script = """
tell application "Finder" to activate
delay 0.1
set selectedFiles to choose file with prompt "Choose video files" of type {"mp4", "mov", "mkv", "webm", "m4v"} with multiple selections allowed
set output to ""
repeat with selectedFile in selectedFiles
  set output to output & POSIX path of selectedFile & linefeed
end repeat
return output
"""

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        message = (error.stderr or error.stdout or "").strip()
        if "User canceled" in message or "用户已取消" in message:
            return []
        raise RuntimeError(message or "The macOS picker could not be opened.") from error

    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def run_windows_video_picker(mode):
    import shutil
    import subprocess

    powershell = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        raise RuntimeError("PowerShell is required to open the Windows file picker.")

    file_filter = "Video files (*.mp4;*.mov;*.mkv;*.webm;*.m4v)|*.mp4;*.mov;*.mkv;*.webm;*.m4v|All files (*.*)|*.*"
    if mode == "folder":
        script = """
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Choose video folder"
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::WriteLine($dialog.SelectedPath)
}
"""
    else:
        multiselect = "$true" if mode == "files" else "$false"
        script = f"""
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Choose video file"
$dialog.Filter = "{file_filter}"
$dialog.Multiselect = {multiselect}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  foreach ($file in $dialog.FileNames) {{
    [Console]::WriteLine($file)
  }}
}}
"""

    result = subprocess.run(
        [powershell, "-NoProfile", "-STA", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def run_native_video_picker(mode):
    import sys

    if sys.platform == "darwin":
        return run_macos_video_picker(mode)
    if os.name == "nt":
        return run_windows_video_picker(mode)
    raise RuntimeError("Native file picking is only implemented for macOS and Windows.")


def local_video_browser_roots():
    roots = [Path.home()]

    if os.name == "nt":
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:\\")
            if drive.exists():
                roots.append(drive)
    else:
        roots.append(Path("/"))

    volumes = Path("/Volumes")
    if volumes.exists():
        roots.extend(sorted((item for item in volumes.iterdir() if item.is_dir()), key=lambda item: item.name.lower()))

    seen = set()
    unique_roots = []
    for root in roots:
        try:
            key = str(root.resolve())
        except Exception:
            key = str(root)
        if key not in seen:
            seen.add(key)
            unique_roots.append({"name": str(root), "path": str(root)})
    return unique_roots


def list_local_video_browser_path(path_value="", file_patterns=DEFAULT_VIDEO_PATTERNS):
    patterns = parse_video_patterns(file_patterns)
    requested = Path(str(path_value or Path.home())).expanduser()
    if requested.is_file():
        requested = requested.parent
    if not requested.exists() or not requested.is_dir():
        requested = Path.home()

    entries = []
    try:
        children = sorted(requested.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    except Exception as error:
        return {
            "path": str(requested),
            "parent": str(requested.parent) if requested.parent != requested else "",
            "roots": local_video_browser_roots(),
            "entries": [],
            "error": str(error),
        }

    for child in children:
        is_dir = child.is_dir()
        is_video = child.is_file() and path_matches_video_patterns(child, patterns)
        if not is_dir and not is_video:
            continue
        entry = {
            "name": child.name,
            "path": str(child),
            "is_dir": is_dir,
            "is_video": is_video,
        }
        if is_video:
            entry["size_mb"] = round(video_file_size_mb(child), 1)
        entries.append(entry)

    return {
        "path": str(requested),
        "parent": str(requested.parent) if requested.parent != requested else "",
        "roots": local_video_browser_roots(),
        "entries": entries,
        "error": "",
    }


def list_video_source_details(source_paths, file_patterns=DEFAULT_VIDEO_PATTERNS):
    files = list_video_files(source_paths, file_patterns, VIDEO_FOLDER_OUTPUT_COUNT)
    details = []
    for index, path in enumerate(files):
        details.append(
            {
                "clip": f"clip_{index + 1:02d}",
                "path": str(path),
                "name": path.name,
                "size_mb": round(video_file_size_mb(path), 1),
            }
        )
    return details


if PromptServer is not None and web is not None:
    @PromptServer.instance.routes.get("/xiaofu-image-compare/video-file/{video_id}")
    async def serve_video_file(request):
        video_id = request.match_info.get("video_id", "")
        path_value = VIDEO_SOURCE_REGISTRY.get(video_id)
        if not path_value:
            return web.Response(status=404, text="Video source is not registered. Run the loader node again.")

        path = Path(path_value)
        if not path.exists() or not path.is_file():
            return web.Response(status=404, text="Video source file is missing.")

        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
        }
        mime_type, _ = mimetypes.guess_type(str(path))
        if mime_type:
            headers["Content-Type"] = mime_type

        return web.FileResponse(path, headers=headers)

    @PromptServer.instance.routes.post("/xiaofu-image-compare/video-sources/pick")
    async def pick_video_sources(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        mode = payload.get("mode", "files")
        if mode not in {"file", "files", "folder"}:
            return web.json_response({"success": False, "error": "Invalid picker mode."}, status=400)

        try:
            paths = run_native_video_picker(mode)
            return web.json_response({"success": True, "paths": paths})
        except Exception as error:
            return web.json_response({"success": False, "error": str(error)}, status=500)

    @PromptServer.instance.routes.post("/xiaofu-image-compare/video-sources/list")
    async def list_video_sources(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        try:
            data = list_local_video_browser_path(
                payload.get("path", ""),
                payload.get("file_patterns", DEFAULT_VIDEO_PATTERNS),
            )
            return web.json_response({"success": True, **data})
        except Exception as error:
            return web.json_response({"success": False, "error": str(error)}, status=500)

    @PromptServer.instance.routes.post("/xiaofu-image-compare/video-sources/info")
    async def video_source_info(request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}

        try:
            details = list_video_source_details(
                payload.get("paths", ""),
                payload.get("file_patterns", DEFAULT_VIDEO_PATTERNS),
            )
            return web.json_response({"success": True, "sources": details})
        except Exception as error:
            return web.json_response({"success": False, "error": str(error), "sources": []}, status=500)


def read_video_file_to_frames(path, max_frames, max_side, frame_stride):
    try:
        import av
        import numpy as np
        import torch
    except Exception as error:
        raise RuntimeError("Reading local video files requires PyAV, NumPy, and Torch in ComfyUI's Python environment.") from error

    path = Path(path)
    frame_limit = max(1, int(max_frames or DEFAULT_VIDEO_MAX_FRAMES))
    stride = max(1, int(frame_stride or 1))
    frames = []
    fps = DEFAULT_VIDEO_FPS
    total_frames = 0

    with av.open(str(path)) as container:
        stream = next((item for item in container.streams if item.type == "video"), None)
        if stream is None:
            raise ValueError(f"No video stream found: {path.name}")

        if stream.average_rate:
            try:
                fps = float(stream.average_rate)
            except (TypeError, ValueError, ZeroDivisionError):
                fps = DEFAULT_VIDEO_FPS

        total_frames = estimate_video_stream_frames(stream, fps)
        target_indices = None
        if total_frames > frame_limit * stride and frame_limit > 1:
            target_indices = sorted({
                round(index * (total_frames - 1) / (frame_limit - 1))
                for index in range(frame_limit)
            })

        if target_indices and total_frames > frame_limit * stride * 4:
            seek_frames = read_video_frames_by_seek(container, stream, target_indices, fps)
            if len(seek_frames) >= min(8, frame_limit):
                frames = seek_frames[:frame_limit]
            else:
                frames = []
                try:
                    container.seek(0, backward=True, any_frame=False, stream=stream)
                except Exception:
                    pass

        if not frames:
            for frame_index, frame in enumerate(container.decode(stream)):
                if target_indices is not None:
                    if frame_index not in target_indices:
                        continue
                elif frame_index % stride != 0:
                    continue

                frames.append(frame.to_ndarray(format="rgb24"))
                if len(frames) >= frame_limit:
                    break

    if not frames:
        raise ValueError(f"No frames could be read from: {path.name}")

    tensor = torch.from_numpy(np.stack(frames)).float() / 255.0
    tensor = resize_video_preview_frames(tensor, max_side=max_side)

    return tensor, fps, total_frames or len(frames)


def video_file_size_mb(path):
    try:
        return Path(path).stat().st_size / (1024 * 1024)
    except OSError:
        return 0


def estimate_video_stream_frames(stream, fps):
    try:
        total = int(stream.frames or 0)
        if total > 0:
            return total
    except (TypeError, ValueError):
        pass

    try:
        if stream.duration and stream.time_base and fps > 0:
            return int(round(float(stream.duration * stream.time_base) * fps))
    except (TypeError, ValueError, OverflowError):
        pass

    return 0


def frame_index_to_timestamp(frame_index, fps, stream):
    try:
        if fps <= 0 or not stream.time_base:
            return None
        return int((frame_index / fps) / float(stream.time_base))
    except (TypeError, ValueError, ZeroDivisionError, OverflowError):
        return None


def read_video_frames_by_seek(container, stream, target_indices, fps):
    frames = []
    if not target_indices or fps <= 0:
        return frames

    for target_index in target_indices:
        timestamp = frame_index_to_timestamp(target_index, fps, stream)
        if timestamp is None:
            return []

        try:
            container.seek(timestamp, backward=True, any_frame=False, stream=stream)
        except Exception:
            return []

        selected_frame = None
        for decoded_count, frame in enumerate(container.decode(stream), start=1):
            selected_frame = frame
            if frame.pts is not None:
                try:
                    current_index = int(round(float(frame.pts * stream.time_base) * fps))
                    if current_index >= target_index:
                        break
                except (TypeError, ValueError, OverflowError):
                    break
            if decoded_count >= 90:
                break

        if selected_frame is not None:
            frames.append(selected_frame.to_ndarray(format="rgb24"))

    return frames


class XiaoFuMultiImageCompare(PreviewImage):
    DESCRIPTION = "Preview and compare multiple images with selectable left/right slots."
    CATEGORY = f"{XIAOFU_NODE_CATEGORY}/Image"
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


class XiaoFuMultiVideoCompare(PreviewImage):
    DESCRIPTION = "Preview and compare multiple video frame batches with a shared timeline."
    CATEGORY = f"{XIAOFU_NODE_CATEGORY}/Video"
    FUNCTION = "compare_videos"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    SEARCH_ALIASES = ["compare video", "multi video compare", "video preview"]

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": DynamicVideoInputs(),
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def compare_videos(
        self,
        fps=DEFAULT_VIDEO_FPS,
        frame_stride=DEFAULT_VIDEO_FRAME_STRIDE,
        max_frames=DEFAULT_VIDEO_MAX_FRAMES,
        filename_prefix="xiaofu.video.compare.",
        prompt=None,
        extra_pnginfo=None,
        **kwargs,
    ):
        videos = []
        video_inputs = sorted(
            ((key, value) for key, value in kwargs.items() if key in DynamicVideoInputs()),
            key=video_slot_sort_key,
        )

        for slot_name, value in video_inputs:
            reference = extract_video_reference(value)
            if reference is not None:
                display_name = reference.get("filename") or reference.get("source_slot") or slot_name
                if display_name != slot_name:
                    display_name = f"{slot_name} - {display_name}"
                videos.append(
                    {
                        "source_slot": slot_name,
                        "id": slot_name,
                        "name": display_name,
                        "fps": reference.get("fps") or fps,
                        "duration": reference.get("duration"),
                        "frame_count": reference.get("total_frames"),
                        "original_frame_count": reference.get("total_frames"),
                        "width": reference.get("width"),
                        "height": reference.get("height"),
                        "video_url": reference.get("video_url"),
                        "video_id": reference.get("video_id"),
                        "path": reference.get("path"),
                        "filename": reference.get("filename"),
                        "size_mb": reference.get("size_mb"),
                        "playback_mode": "source",
                    }
                )
                continue

            frames = extract_video_frames(value)
            if frames is None or not tensor_has_data(frames):
                continue

            original_frame_count = video_frame_count(frames)
            preview_frames = sample_video_frames(frames, frame_stride, max_frames)
            preview_frames = resize_video_preview_frames(preview_frames)
            preview_frame_count = video_frame_count(preview_frames)
            if preview_frame_count <= 0:
                continue

            width, height = video_frame_size(preview_frames)
            saved = self.save_images(
                preview_frames,
                filename_prefix,
                prompt,
                extra_pnginfo,
            )["ui"]["images"]

            effective_fps = max(1.0, extract_video_fps(value, fps) / max(1, int(frame_stride or 1)))
            display_name = extract_video_display_name(value, slot_name)
            if display_name != slot_name:
                display_name = f"{slot_name} - {display_name}"
            item = {
                "source_slot": slot_name,
                "id": slot_name,
                "name": display_name,
                "fps": effective_fps,
                "frame_count": len(saved),
                "original_frame_count": original_frame_count,
                "frame_stride": max(1, int(frame_stride or 1)),
                "truncated": original_frame_count > preview_frame_count * max(1, int(frame_stride or 1)),
                "frames": [dict(frame) for frame in saved],
            }
            if width and height:
                item["width"] = width
                item["height"] = height
            videos.append(item)

        return {"ui": {"xiaofu_videos": videos}}


class XiaoFuLoadVideoFolder:
    DESCRIPTION = "Read up to twelve local video files from selected sources as lightweight video preview clips."
    CATEGORY = f"{XIAOFU_NODE_CATEGORY}/Video"
    FUNCTION = "load_video_folder"
    RETURN_TYPES = ("VIDEO",) * VIDEO_FOLDER_OUTPUT_COUNT
    RETURN_NAMES = tuple(f"clip_{index + 1:02d}" for index in range(VIDEO_FOLDER_OUTPUT_COUNT))
    SEARCH_ALIASES = ["load video folder", "video folder", "local video clips"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": "", "multiline": True}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    def load_video_folder(
        self,
        folder_path,
        file_patterns=DEFAULT_VIDEO_PATTERNS,
        max_frames=DEFAULT_VIDEO_MAX_FRAMES,
        max_side=DEFAULT_VIDEO_PREVIEW_MAX_SIDE,
        frame_stride=1,
        prompt=None,
        unique_id=None,
    ):
        outputs = [None] * VIDEO_FOLDER_OUTPUT_COUNT
        warnings = []

        try:
            files = list_video_files(folder_path, file_patterns, VIDEO_FOLDER_OUTPUT_COUNT)
        except Exception as error:
            warnings.append(str(error))
            return {
                "ui": {"xiaofu_video_folder_warnings": warnings},
                "result": tuple(outputs),
            }

        registered_count = 0
        progress = make_progress_bar(len(files), unique_id)
        update_progress(progress, 0, len(files))

        for index, path in enumerate(files):
            size_mb = video_file_size_mb(path)
            if size_mb >= 500:
                warnings.append(
                    f"{path.name} is {size_mb:.0f} MB; using original local video playback."
                )
            try:
                outputs[index] = build_video_reference(path, f"clip_{index + 1:02d}")
                registered_count += 1
            except Exception as error:
                warnings.append(f"{path.name}: {error}")
                outputs[index] = None
            finally:
                update_progress(progress, index + 1, len(files))

        print(f"[XiaoFu Video Folder] Registered {registered_count} original video source(s).")

        if warnings:
            print("[XiaoFu Video Folder] " + " | ".join(warnings))

        result = tuple(outputs)
        if warnings:
            return {
                "ui": {"xiaofu_video_folder_warnings": warnings},
                "result": result,
            }

        return result


NODE_CLASS_MAPPINGS = {
    IMAGE_NODE_ID: XiaoFuMultiImageCompare,
    VIDEO_NODE_ID: XiaoFuMultiVideoCompare,
    VIDEO_FOLDER_NODE_ID: XiaoFuLoadVideoFolder,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    IMAGE_NODE_ID: IMAGE_NODE_DISPLAY_NAME,
    VIDEO_NODE_ID: VIDEO_NODE_DISPLAY_NAME,
    VIDEO_FOLDER_NODE_ID: VIDEO_FOLDER_NODE_DISPLAY_NAME,
}

WEB_DIRECTORY = "./web"

print(
    "[XiaoFu Image & Video Compare] Loaded: "
    f"{IMAGE_NODE_DISPLAY_NAME}, {VIDEO_NODE_DISPLAY_NAME}, {VIDEO_FOLDER_NODE_DISPLAY_NAME}"
)

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
