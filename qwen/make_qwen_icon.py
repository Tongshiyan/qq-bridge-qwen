#!/usr/bin/env python3
"""生成 Qwen 风格图标 -> qwen.ico (多尺寸) + qwen-preview.png (256px 预览)"""
import math
import os

from PIL import Image, ImageDraw

OUT = r"C:\Users\Shane\Desktop\qwen"
S = 1024
SS = 4                      # 超采样倍数（先画大图再缩小，边缘更干净）

# Qwen 品牌紫：亮紫 -> 深靛
C_TOP = (124, 92, 255)
C_BOT = (74, 45, 214)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bot):
    g = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(g)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bot, y / (size - 1)))
    return g


big = S * SS

# 1) 背景：圆角方块 + 对角渐变
bg = gradient(big, C_TOP, C_BOT)
bg.putalpha(rounded_mask(big, int(big * 0.22)))

# 2) 螺旋（千问标志性的旋涡），外圈尾巴向右下延伸成 Q 的尾巴
sp = Image.new("RGBA", (big, big), (0, 0, 0, 0))
d = ImageDraw.Draw(sp)
cx = cy = big / 2
r0, r1 = big * 0.055, big * 0.315          # 起始/结束半径
turns = 2.15
steps = 900
pts = []
for i in range(steps + 1):
    t = i / steps
    th = t * turns * 2 * math.pi
    r = r0 + (r1 - r0) * t
    pts.append((cx + r * math.cos(th - math.pi / 2),
                cy + r * math.sin(th - math.pi / 2)))
# 尾巴：从螺旋末端继续向右下方甩出
tail = pts[-1]
for i in range(1, 120):
    k = i / 119
    pts.append((tail[0] + big * 0.155 * k, tail[1] + big * 0.115 * k))

d.line(pts, fill=WHITE, width=1)          # 占位，真正描边用下面的圆点盖
# 用「沿路径盖圆点」代替粗折线：粗折线的 joint 会产生毛刺纹理
r_pt = big * 0.0425
for p in pts:
    d.ellipse([p[0] - r_pt, p[1] - r_pt, p[0] + r_pt, p[1] + r_pt], fill=WHITE)

icon = Image.alpha_composite(bg, sp).resize((S, S), Image.LANCZOS)

ico_path = os.path.join(OUT, "qwen.ico")
icon.save(ico_path, format="ICO",
          sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
icon.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "qwen-preview.png"))
icon.resize((48, 48), Image.LANCZOS).save(os.path.join(OUT, "qwen-preview-48.png"))
print("saved:", ico_path, os.path.getsize(ico_path), "bytes")
