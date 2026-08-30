#!/usr/bin/env python3
"""生成插件图标：渐变圆角方块 + 白色「译」字，输出 16/48/128 px。"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 512
GLYPH = "译"
# indigo -> violet 对角渐变，与界面主题一致
C1 = (99, 102, 241)
C2 = (139, 92, 246)

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def pick_font(px):
    for path in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        for index in range(0, 12):
            try:
                font = ImageFont.truetype(path, px, index=index)
            except Exception:
                break
            try:
                family, style = font.getname()
            except Exception:
                family, style = "", ""
            name = f"{family} {style}"
            # 优先 PingFang SC 的 Semibold/Medium
            if "PingFang SC" in name and any(w in name for w in ("Semibold", "Medium")):
                return font, name
        # 该文件没有理想字重时，用 index=0 兜底（能画出 CJK 即可）
        try:
            font = ImageFont.truetype(path, px, index=0)
            if font.getbbox(GLYPH)[2] > 0:
                return font, f"{path} (index 0)"
        except Exception:
            continue
    return None, None


def gradient(size):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    denom = 2 * (size - 1)
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            px[x, y] = (
                round(C1[0] + (C2[0] - C1[0]) * t),
                round(C1[1] + (C2[1] - C1[1]) * t),
                round(C1[2] + (C2[2] - C1[2]) * t),
                255,
            )
    return img


def main():
    font, font_name = pick_font(int(SIZE * 0.62))
    if font is None:
        print("找不到可用的中文字体", file=sys.stderr)
        sys.exit(1)
    print(f"使用字体: {font_name}")

    base = gradient(SIZE)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255
    )
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    left, top, right, bottom = draw.textbbox((0, 0), GLYPH, font=font)
    w, h = right - left, bottom - top
    pos = ((SIZE - w) / 2 - left, (SIZE - h) / 2 - top)
    draw.text(pos, GLYPH, font=font, fill=(255, 255, 255, 255))

    for out in (128, 48, 16):
        icon.resize((out, out), Image.LANCZOS).save(os.path.join(HERE, f"icon{out}.png"))
        print(f"icon{out}.png 已生成")


if __name__ == "__main__":
    main()
