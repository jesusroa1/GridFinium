#!/usr/bin/env python3
"""Detect and outline a sheet of paper in an image using OpenCV.

Run from the repository root, for example:

    python paper_detection/detect_paper.py path/to/input.jpg --output outlined.png --display
    python paper_detection/detect_paper.py --testing-mode --display
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Sequence, Tuple

try:
    import cv2  # type: ignore
    import numpy as np
except ImportError as exc:  # pragma: no cover - import guard
    print("This script requires OpenCV. Install it with `pip install opencv-python`.", file=sys.stderr)
    raise


@dataclass(frozen=True)
class ObjectBoundingBox:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class DetectedObject:
    contour: np.ndarray
    bounding_box: ObjectBoundingBox


@dataclass
class DetectionResult:
    corners: np.ndarray
    mask: np.ndarray
    debug_images: Dict[str, np.ndarray]
    other_objects: Tuple[DetectedObject, ...] = field(default_factory=tuple)


class ProcessingError(RuntimeError):
    """Exception raised when processing an image fails."""

    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Outline a sheet of paper in a photograph using OpenCV.")
    parser.add_argument(
        "input",
        type=Path,
        nargs="?",
        help="Path to the input image (any format supported by OpenCV). Optional when --testing-mode is used.",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Destination path for the outlined image. Defaults to <input_basename>_outlined.png",
    )
    parser.add_argument(
        "--display",
        action="store_true",
        help="Display the outlined result in an OpenCV window (press any key to close).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Write intermediate masks next to the output for troubleshooting thresholding steps.",
    )
    parser.add_argument(
        "--min-area-ratio",
        type=float,
        default=0.04,
        help="Minimum contour area (relative to image area) to consider as paper. Default: 0.04",
    )
    parser.add_argument(
        "--max-dimension",
        type=int,
        default=1200,
        help="Maximum edge length used during processing (original image is not resized in the output).",
    )
    parser.add_argument(
        "-t",
        "--testing-mode",
        action="store_true",
        help="Open a Windows file picker to select the input image interactively.",
    )
    args = parser.parse_args()

    if not args.testing_mode and args.input is None:
        parser.error("the following arguments are required: input (or use --testing-mode)")

    return args


def resize_for_processing(image: np.ndarray, max_dimension: int) -> Tuple[np.ndarray, float]:
    height, width = image.shape[:2]
    longest_edge = max(height, width)
    if longest_edge <= max_dimension:
        return image.copy(), 1.0

    scale = max_dimension / float(longest_edge)
    new_width = int(round(width * scale))
    new_height = int(round(height * scale))
    resized = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_AREA)
    return resized, scale


def build_white_mask(image: np.ndarray) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    lower_white = np.array([0, 0, 150], dtype=np.uint8)
    upper_white = np.array([179, 80, 255], dtype=np.uint8)
    chroma_mask = cv2.inRange(hsv, lower_white, upper_white)

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lightness_channel = lab[:, :, 0]
    blurred_lightness = cv2.GaussianBlur(lightness_channel, (5, 5), 0)
    _, lightness_mask = cv2.threshold(
        blurred_lightness, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    combined = cv2.bitwise_and(chroma_mask, lightness_mask)
    kernel_close = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel_close, iterations=2)
    kernel_refine = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    refined = cv2.erode(closed, kernel_refine, iterations=1)
    refined = cv2.dilate(refined, kernel_refine, iterations=1)

    debug_images = {
        "01_chroma_mask": chroma_mask,
        "02_lightness_mask": lightness_mask,
        "03_combined_mask": combined,
        "04_refined_mask": refined,
    }

    return refined, debug_images


def find_paper_contour(mask: np.ndarray, min_area_ratio: float) -> Optional[np.ndarray]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    mask_area = float(mask.shape[0] * mask.shape[1])
    best_box = None
    best_area = 0.0

    for contour in contours:
        contour_area = cv2.contourArea(contour)
        if contour_area < mask_area * min_area_ratio:
            continue

        rotated_rect = cv2.minAreaRect(contour)
        box = cv2.boxPoints(rotated_rect)
        box_area = cv2.contourArea(box)
        if box_area > best_area:
            best_area = box_area
            best_box = box

    return best_box


def order_box_points(points: np.ndarray) -> np.ndarray:
    pts = np.array(points, dtype=np.float32)
    if pts.shape != (4, 2):
        raise ValueError("Expected four 2D points to order.")

    sums = pts.sum(axis=1)
    diffs = np.diff(pts, axis=1)

    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = pts[np.argmin(sums)]  # top-left
    ordered[2] = pts[np.argmax(sums)]  # bottom-right
    ordered[1] = pts[np.argmin(diffs)]  # top-right
    ordered[3] = pts[np.argmax(diffs)]  # bottom-left
    return ordered



def find_additional_objects(image: np.ndarray, paper_corners: np.ndarray) -> Tuple[DetectedObject, ...]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    paper_mask = np.zeros_like(gray)
    cv2.fillPoly(paper_mask, [paper_corners.astype(np.int32)], 255)
    paper_area = float(cv2.countNonZero(paper_mask))
    if paper_area == 0:
        return tuple()

    # stay a bit inside the detected paper so we do not grab border bleed
    shrink_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
    inner_mask = cv2.erode(paper_mask, shrink_kernel, iterations=1)
    if not np.any(inner_mask):
        inner_mask = paper_mask

    distance_map = cv2.distanceTransform((inner_mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    border_margin = max(10.0, 0.01 * max(inner_mask.shape[0], inner_mask.shape[1]))

    # estimate average paper colour to highlight foreground objects
    paper_pixels = image[inner_mask == 255]
    paper_reference = np.median(paper_pixels.reshape(-1, 3), axis=0).astype(np.float32)

    diff = np.linalg.norm(image.astype(np.float32) - paper_reference, axis=2)
    color_mask = np.zeros_like(gray)
    color_mask[diff > 18.0] = 255
    color_mask = cv2.bitwise_and(color_mask, color_mask, mask=inner_mask)

    # capture sharp transitions as a fallback (helps darker items)
    edges = cv2.Canny(blurred, 20, 80)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=1)
    edges_on_paper = cv2.bitwise_and(edges, edges, mask=inner_mask)

    combined = cv2.bitwise_or(color_mask, edges_on_paper)
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)), iterations=2)
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1)

    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = max(900, int(paper_area * 0.004))
    max_area = paper_area * 0.9

    candidates: List[DetectedObject] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area or area > max_area:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        overlap_patch = paper_mask[y : y + h, x : x + w]
        if overlap_patch.size == 0:
            continue

        if float(cv2.countNonZero(overlap_patch)) / float(w * h) < 0.6:
            continue

        filled = np.zeros_like(inner_mask, dtype=np.uint8)
        cv2.drawContours(filled, [contour], -1, 255, thickness=cv2.FILLED)
        contour_distances = distance_map[filled == 255]
        if contour_distances.size == 0 or float(contour_distances.min()) < border_margin:
            continue

        hull = cv2.convexHull(contour)
        candidates.append(DetectedObject(contour=hull, bounding_box=ObjectBoundingBox(x=x, y=y, width=w, height=h)))

    candidates.sort(key=lambda obj: obj.bounding_box.width * obj.bounding_box.height, reverse=True)

    filtered: List[DetectedObject] = []

    def boxes_overlap(lhs: ObjectBoundingBox, rhs: ObjectBoundingBox) -> bool:
        x_overlap = max(0, min(lhs.x + lhs.width, rhs.x + rhs.width) - max(lhs.x, rhs.x))
        y_overlap = max(0, min(lhs.y + lhs.height, rhs.y + rhs.height) - max(lhs.y, rhs.y))
        if x_overlap == 0 or y_overlap == 0:
            return False
        overlap_area = x_overlap * y_overlap
        return overlap_area >= 0.6 * min(lhs.width * lhs.height, rhs.width * rhs.height)

    for candidate in candidates:
        if any(boxes_overlap(candidate.bounding_box, existing.bounding_box) for existing in filtered):
            continue
        filtered.append(candidate)

    return tuple(filtered)





def detect_paper(image: np.ndarray, max_dimension: int, min_area_ratio: float) -> Optional[DetectionResult]:
    working, scale = resize_for_processing(image, max_dimension)
    mask, debug_images = build_white_mask(working)

    contour_box = find_paper_contour(mask, min_area_ratio)
    if contour_box is None:
        return None

    if scale <= 0:
        scale = 1.0
    contour_box = contour_box.astype(np.float32) / scale
    ordered = order_box_points(contour_box)

    other_objects = find_additional_objects(image, ordered)

    return DetectionResult(
        corners=ordered,
        mask=mask,
        debug_images=debug_images,
        other_objects=other_objects,
    )



def draw_outline(
    image: np.ndarray,
    corners: np.ndarray,
    other_objects: Optional[Sequence[ObjectBoundingBox]] = None,
    mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    overlay = image.copy()
    draw_precise_contour(overlay, mask)

    outline_color = (60, 255, 150)
    point_color = (50, 220, 130)
    extra_color = (255, 0, 0)

    poly_points = corners.reshape(-1, 1, 2).astype(np.int32)
    cv2.polylines(overlay, [poly_points], isClosed=True, color=outline_color, thickness=5, lineType=cv2.LINE_AA)

    for (x, y) in corners.astype(int):
        cv2.circle(overlay, (x, y), radius=8, color=point_color, thickness=-1, lineType=cv2.LINE_AA)

    def annotate_edge(pt1: np.ndarray, pt2: np.ndarray, label: str) -> None:
        midpoint = (pt1 + pt2) / 2.0
        direction = pt2 - pt1
        length = np.linalg.norm(direction)
        if length == 0:
            return

        normal = np.array([-direction[1], direction[0]], dtype=np.float32)
        normal_length = np.linalg.norm(normal)
        if normal_length == 0:
            return
        normal /= normal_length

        center = corners.mean(axis=0)
        if np.dot(normal, midpoint - center) < 0:
            normal *= -1

        offset_distance = max(20, int(round(max(image.shape[:2]) * 0.03)))
        text_position = midpoint + normal * offset_distance

        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = max(image.shape[:2]) / 1000.0
        font_scale = max(font_scale, 0.6)
        thickness = 2

        text_pos = (int(round(text_position[0])), int(round(text_position[1])))
        cv2.putText(overlay, label, text_pos, font, font_scale, (0, 0, 0), thickness * 2, cv2.LINE_AA)
        cv2.putText(overlay, label, text_pos, font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)

    edges = [
        (corners[0], corners[1]),  # top
        (corners[1], corners[2]),  # right
        (corners[2], corners[3]),  # bottom
        (corners[3], corners[0]),  # left
    ]

    edge_lengths = [float(np.linalg.norm(b - a)) for a, b in edges]

    horizontal_mean = (edge_lengths[0] + edge_lengths[2]) / 2.0
    vertical_mean = (edge_lengths[1] + edge_lengths[3]) / 2.0

    long_indices: Tuple[int, int]
    short_indices: Tuple[int, int]
    if horizontal_mean >= vertical_mean:
        long_indices = (0, 2)
        short_indices = (1, 3)
    else:
        long_indices = (1, 3)
        short_indices = (0, 2)

    for idx in long_indices:
        annotate_edge(edges[idx][0], edges[idx][1], "11 in")
    for idx in short_indices:
        annotate_edge(edges[idx][0], edges[idx][1], "8.5 in")

    if other_objects:
        height, width = overlay.shape[:2]
        font = cv2.FONT_HERSHEY_SIMPLEX
        for obj in other_objects:
            cv2.drawContours(overlay, [obj.contour], -1, extra_color, thickness=3, lineType=cv2.LINE_AA)

            box = obj.bounding_box
            label = f"{box.width}x{box.height}px"
            text_size, baseline = cv2.getTextSize(label, font, 0.65, 2)
            text_width, text_height = text_size
            text_x = max(5, min(box.x, width - text_width - 5))
            text_y = box.y - 10
            minimum_y = text_height + 5
            if text_y < minimum_y:
                text_y = box.y + box.height + text_height + 5
            text_y = min(text_y, height - baseline - 5)
            text_y = max(minimum_y, text_y)

            cv2.putText(overlay, label, (text_x, text_y), font, 0.65, extra_color, 2, cv2.LINE_AA)

    return overlay


def save_debug_outputs(output_path: Path, debug_images: Dict[str, np.ndarray]) -> None:
    debug_dir = output_path.parent / f"{output_path.stem}_debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    for label, image in debug_images.items():
        cv2.imwrite(str(debug_dir / f"{label}.png"), image)


def prompt_for_input_file(initial_dir: Optional[Path] = None) -> Optional[Path]:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        print("Testing mode requires tkinter to be available on this system.", file=sys.stderr)
        return None

    root = tk.Tk()
    root.withdraw()
    options = {
        "title": "Select a paper image",
        "filetypes": [
            ("Image files", "*.png;*.jpg;*.jpeg;*.bmp;*.tif;*.tiff"),
            ("All files", "*.*"),
        ],
    }
    if initial_dir is not None:
        options["initialdir"] = str(initial_dir)

    selected = filedialog.askopenfilename(**options)
    root.destroy()

    if not selected:
        return None

    return Path(selected)


def get_downloads_dir() -> Path:
    """Return the expected Downloads directory path (may not exist)."""
    return Path.home() / "Downloads"


def resolve_input_path(args: argparse.Namespace) -> Path:
    input_path = args.input

    if args.testing_mode:
        if input_path and input_path.exists():
            return input_path

        downloads_dir = get_downloads_dir()
        if input_path and input_path.parent.exists():
            initial_dir = input_path.parent
        elif downloads_dir.exists():
            initial_dir = downloads_dir
        else:
            initial_dir = Path.cwd()

        chosen = prompt_for_input_file(initial_dir)
        if chosen is None:
            print("No file selected; exiting testing mode.", file=sys.stderr)
            sys.exit(1)
        return chosen

    if input_path is None:
        print("Input image not provided.", file=sys.stderr)
        sys.exit(1)

    if not input_path.exists():
        print(f"Input image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    return input_path

def ensure_downloads_timestamp(output_path: Path) -> Path:
    """Append a timestamp when saving to the user's Downloads directory."""
    downloads_dir = get_downloads_dir()
    try:
        downloads_resolved = downloads_dir.resolve(strict=False)
        output_resolved = output_path.resolve(strict=False)
    except OSError:
        return output_path

    if output_resolved == downloads_resolved or downloads_resolved in output_resolved.parents:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        return output_path.with_name(f"{output_path.stem}_{timestamp}{output_path.suffix}")

    return output_path


def launch_file(path: Path) -> None:
    """Open a file with the default OS handler."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform.startswith("darwin"):
            subprocess.run(["open", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
    except Exception as exc:
        print(f"Unable to open {path}: {exc}", file=sys.stderr)


def add_timestamp_label(image: np.ndarray, label: Optional[str] = None) -> str:
    """Draw a timestamp label in the top-left corner of the image."""
    if label is None:
        label = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if image.size == 0:
        return label

    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(image.shape[:2]) / 900.0
    font_scale = max(font_scale, 0.5)
    thickness = 2

    text_size, baseline = cv2.getTextSize(label, font, font_scale, thickness)
    text_width, text_height = text_size
    x = 15
    y = 15 + text_height

    padding = 8
    top_left = (x - padding, y - text_height - padding)
    bottom_right = (x + text_width + padding, y + baseline + padding)
    cv2.rectangle(image, top_left, bottom_right, (0, 0, 0), thickness=cv2.FILLED)
    cv2.putText(image, label, (x, y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)
    return label


def draw_precise_contour(overlay: np.ndarray, mask: Optional[np.ndarray]) -> None:
    """Draw a red contour that closely follows the paper edge."""
    if mask is None or mask.size == 0:
        return

    target_width = overlay.shape[1]
    target_height = overlay.shape[0]
    if mask.shape[0] != target_height or mask.shape[1] != target_width:
        resized_mask = cv2.resize(mask, (target_width, target_height), interpolation=cv2.INTER_NEAREST)
    else:
        resized_mask = mask

    if resized_mask.ndim > 2:
        resized_mask = cv2.cvtColor(resized_mask, cv2.COLOR_BGR2GRAY)

    resized_mask = resized_mask.astype(np.uint8)
    _, binary = cv2.threshold(resized_mask, 0, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return

    contour = max(contours, key=cv2.contourArea)
    cv2.drawContours(overlay, [contour], -1, (0, 0, 255), thickness=4, lineType=cv2.LINE_AA)





def process_single_image(
    input_path: Path,
    args: argparse.Namespace,
    *,
    output_path_override: Optional[Path] = None,
    launch_after_save: bool = False,
    display_override: Optional[bool] = None,
    debug_override: Optional[bool] = None,
) -> Path:
    """Run the detection pipeline for a single image and write the result."""
    image = cv2.imread(str(input_path))
    if image is None:
        raise ProcessingError(f"OpenCV could not read the image at {input_path}", exit_code=1)

    detection = detect_paper(image, max_dimension=args.max_dimension, min_area_ratio=args.min_area_ratio)
    if detection is None:
        raise ProcessingError("No paper-like region was detected. Try adjusting lighting or the min-area-ratio.", exit_code=2)

    outlined = draw_outline(image, detection.corners, detection.other_objects, detection.mask)

    if detection.other_objects:
        print("Detected additional objects:")
        for idx, obj in enumerate(detection.other_objects, start=1):
            box = obj.bounding_box
            print(f"  Object {idx}: {box.width}x{box.height}px at ({box.x}, {box.y})")
    else:
        print("No additional non-paper objects were detected.")

    add_timestamp_label(outlined)

    output_path = output_path_override
    if output_path is None:
        if args.output is not None:
            output_path = args.output
        else:
            output_path = input_path.with_name(f"{input_path.stem}_outlined.png")

    output_path = ensure_downloads_timestamp(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if cv2.imwrite(str(output_path), outlined):
        print(f"Outlined image written to {output_path}")
        if launch_after_save and output_path.suffix.lower() == ".png":
            launch_file(output_path)
    else:
        raise ProcessingError(f"Failed to write outlined image to {output_path}", exit_code=3)

    debug_enabled = args.debug if debug_override is None else debug_override
    if debug_enabled:
        save_debug_outputs(output_path, detection.debug_images)
        print(f"Debug masks saved to {output_path.parent / (output_path.stem + '_debug')}")

    display_enabled = args.display if display_override is None else display_override
    if display_enabled:
        window_name = f"Paper Detection - {input_path.name}"
        cv2.imshow(window_name, outlined)
        cv2.waitKey(0)
        cv2.destroyWindow(window_name)

    return output_path


def run_testing_batch(args: argparse.Namespace) -> None:
    """Process every PNG/JPEG in test_inputs and write results to test_outputs."""
    script_dir = Path(__file__).resolve().parent
    input_dir = script_dir / "test_inputs"
    output_dir = script_dir / "test_outputs"

    if not input_dir.exists():
        print(f"Test input directory not found: {input_dir}", file=sys.stderr)
        sys.exit(1)

    valid_suffixes = {".png", ".jpg", ".jpeg"}
    input_files = sorted(
        p for p in input_dir.iterdir() if p.is_file() and p.suffix.lower() in valid_suffixes
    )
    if not input_files:
        print(f"No PNG/JPEG files found in {input_dir}", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    for input_path in input_files:
        print(f"Processing {input_path.name}...")
        output_path = output_dir / f"{input_path.stem}_outlined.png"
        try:
            process_single_image(
                input_path,
                args,
                output_path_override=output_path,
                launch_after_save=False,
                display_override=False,
            )
        except ProcessingError as exc:
            failures += 1
            print(f"  {exc}", file=sys.stderr)

    if failures:
        print(f"Completed with {failures} failure(s).", file=sys.stderr)
        sys.exit(1)

    print(f"Processed {len(input_files)} file(s). Results saved to {output_dir}.")


def main() -> None:
    args = parse_arguments()

    if args.testing_mode and args.input is None:
        run_testing_batch(args)
        return

    input_path = resolve_input_path(args)

    try:
        process_single_image(
            input_path,
            args,
            launch_after_save=args.testing_mode,
        )
    except ProcessingError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(exc.exit_code)


if __name__ == "__main__":
    main()

