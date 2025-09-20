#!/usr/bin/env python3
"""Detect and outline a sheet of paper in an image using OpenCV.

Run from the repository root, for example:

    python paper_detection/detect_paper.py path/to/input.jpg --output outlined.png --display
    python paper_detection/detect_paper.py --testing-mode --display
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

try:
    import cv2  # type: ignore
    import numpy as np
except ImportError as exc:  # pragma: no cover - import guard
    print("This script requires OpenCV. Install it with `pip install opencv-python`.", file=sys.stderr)
    raise


@dataclass
class DetectionResult:
    corners: np.ndarray
    mask: np.ndarray
    debug_images: Dict[str, np.ndarray]


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

    return DetectionResult(corners=ordered, mask=mask, debug_images=debug_images)


def draw_outline(image: np.ndarray, corners: np.ndarray) -> np.ndarray:
    overlay = image.copy()
    poly_points = corners.reshape(-1, 1, 2).astype(np.int32)
    cv2.polylines(overlay, [poly_points], isClosed=True, color=(60, 255, 150), thickness=5, lineType=cv2.LINE_AA)

    for (x, y) in corners.astype(int):
        cv2.circle(overlay, (x, y), radius=8, color=(50, 220, 130), thickness=-1, lineType=cv2.LINE_AA)
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


def resolve_input_path(args: argparse.Namespace) -> Path:
    input_path = args.input

    if args.testing_mode:
        if input_path and input_path.exists():
            return input_path
        chosen = prompt_for_input_file(input_path.parent if input_path else Path.cwd())
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


def main() -> None:
    args = parse_arguments()
    input_path = resolve_input_path(args)

    image = cv2.imread(str(input_path))
    if image is None:
        print(f"OpenCV could not read the image at {input_path}", file=sys.stderr)
        sys.exit(1)

    detection = detect_paper(image, max_dimension=args.max_dimension, min_area_ratio=args.min_area_ratio)
    if detection is None:
        print("No paper-like region was detected. Try adjusting lighting or the min-area-ratio.", file=sys.stderr)
        sys.exit(2)

    outlined = draw_outline(image, detection.corners)

    output_path = args.output
    if output_path is None:
        output_path = input_path.with_name(f"{input_path.stem}_outlined.png")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    if cv2.imwrite(str(output_path), outlined):
        print(f"Outlined image written to {output_path}")
    else:
        print(f"Failed to write outlined image to {output_path}", file=sys.stderr)
        sys.exit(3)

    if args.debug:
        save_debug_outputs(output_path, detection.debug_images)
        print(f"Debug masks saved to {output_path.parent / (output_path.stem + '_debug')}")

    if args.display:
        window_name = "Paper Detection"
        cv2.imshow(window_name, outlined)
        cv2.waitKey(0)
        cv2.destroyWindow(window_name)


if __name__ == "__main__":
    main()
