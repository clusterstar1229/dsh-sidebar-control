"""Build the 10-second README demo GIF from captured desktop frames.

Usage:
  python build-demo-gif.py <frames-dir> <out.gif> [width] [fps]

The capture is a real recording of the Harness window while the agent drove the
Bing search box: type + submit, read, snapshot refs, screenshot. The script finds
the changed span, plays it at real speed, and freezes the final frame so the GIF
lasts exactly 10 seconds.
"""

import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FRAME_MS = 120          # record-demo.ps1 default interval
TARGET_SECONDS = 10.0
CAPTION = "Sidebar Control 0.2.1  ·  agent drives the built-in Browser panel"


def main() -> None:
    frames_dir = sys.argv[1]
    out_path = sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 800
    fps = int(sys.argv[4]) if len(sys.argv) > 4 else 10
    colors = int(sys.argv[5]) if len(sys.argv) > 5 else 96
    animation_seconds = float(sys.argv[6]) if len(sys.argv) > 6 else 8.0
    crop_left = int(sys.argv[7]) if len(sys.argv) > 7 else 0

    paths = sorted(glob.glob(os.path.join(frames_dir, "f*.png")))
    if not paths:
        raise SystemExit("no frames found")

    images = []
    for path in paths:
        with Image.open(path) as image:
            images.append(image.convert("RGB"))

    # Find the span that actually changes on screen (ignore static lead-in/out).
    previous = None
    changes = []
    for index, image in enumerate(images):
        small = image.resize((160, 86)).convert("L")
        if previous is not None:
            diff = 0
            for a, b in zip(previous.getdata(), small.getdata()):
                if abs(a - b) > 12:
                    diff += 1
            changes.append(diff)
        previous = small
    first = next((i for i, value in enumerate(changes) if value > 400), 0)
    last = max((i for i, value in enumerate(changes) if value > 400), default=len(images) - 2)
    # A little lead-in and a longer hold on the end frame.
    start = max(0, first - 2)
    end = min(len(images) - 1, last + 2)
    print(f"frames={len(images)} change_span={first}..{last} keep={start}..{end}")

    kept = images[start:end + 1]
    moved_seconds = (len(kept) - 1) * FRAME_MS / 1000.0
    if moved_seconds > TARGET_SECONDS:
        # time-lapse: keep evenly spaced samples
        count = int(TARGET_SECONDS * 1000 / FRAME_MS)
        step = (len(kept) - 1) / max(1, count - 1)
        kept = [kept[round(i * step)] for i in range(count)]

    height = round(kept[0].height * width / kept[0].width)
    caption_height = 26
    font_path = "C:/Windows/Fonts/arial.ttf"
    font = ImageFont.truetype(font_path, 13) if os.path.exists(font_path) else ImageFont.load_default()

    rendered = []
    for image in kept:
        if crop_left > 0:
            image = image.crop((crop_left, 0, image.width, image.height))
        frame = image.resize((width, height), Image.LANCZOS)
        canvas = Image.new("RGB", (width, height + caption_height), (17, 17, 17))
        canvas.paste(frame, (0, 0))
        draw = ImageDraw.Draw(canvas)
        draw.text((8, height + 6), CAPTION, fill=(236, 236, 236), font=font)
        rendered.append(canvas)

    unique = []
    weights = []
    previous_bytes = None
    for frame in rendered:
        data = frame.tobytes()
        if data == previous_bytes:
            weights[-1] += 1
            continue
        unique.append(frame)
        weights.append(1)
        previous_bytes = data
    total_weight = sum(weights)
    durations = [max(40, int(animation_seconds * 1000 * weight / total_weight)) for weight in weights]
    hold = int(TARGET_SECONDS * 1000) - sum(durations)
    if hold > 0:
        durations[-1] += hold
        print(f"hold_last_ms={hold}")
    elif hold < 0:
        # too long: shorten the last frame, never below 40 ms
        durations[-1] = max(40, durations[-1] + hold)

    palette_frames = [frame.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for frame in unique]
    print(f"unique_frames={len(unique)} total_weight={total_weight}")
    palette_frames[0].save(
        out_path,
        save_all=True,
        append_images=palette_frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
        comment="Sidebar Control 0.2.1 demo",
    )
    total = sum(durations) / 1000.0
    print(f"gif={out_path} size={os.path.getsize(out_path)} bytes frames={len(palette_frames)} duration={total:.2f}s")


if __name__ == "__main__":
    main()
