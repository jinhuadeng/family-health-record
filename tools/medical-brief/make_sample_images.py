import math, random
from PIL import Image, ImageDraw
random.seed(1)
for n, shift in (('cgm_day1.png', 0), ('cgm_day2.png', -0.8)):
    W, H = 600, 1000; im = Image.new('RGB', (W, H), 'white'); dr = ImageDraw.Draw(im)
    dr.text((30, 30), f'SAMPLE - fake data - {n}', fill='black')
    dr.rectangle((40, 300, 560, 700), outline='#ccc')
    y = lambda g: 700 - (g - 2) / 18 * 400
    dr.rectangle((41, y(10), 559, y(3.9)), fill='#eef8ee')
    pts = []
    for i in range(289):
        t = i / 12
        g = 6.5 + shift + 3.5 * math.exp(-((t - 8.5) / 1.2) ** 2) + 3 * math.exp(-((t - 13) / 1.3) ** 2) + 5 * math.exp(-((t - 19) / 1.5) ** 2) + random.uniform(-.2, .2)
        pts.append((40 + 520 * i / 288, y(g)))
    dr.line(pts, fill='#2e7d32', width=3)
    im.save(n)
