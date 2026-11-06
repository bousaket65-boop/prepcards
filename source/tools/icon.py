import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
for size in (192, 512):
    s = size / 512
    im = Image.new('RGB', (size, size), '#1F3A5F')
    d = ImageDraw.Draw(im)
    # back card
    d.rounded_rectangle([140*s, 96*s, 400*s, 340*s], radius=18*s, fill='#C9D2DB')
    # front index card with margin line and rules
    d.rounded_rectangle([108*s, 160*s, 404*s, 416*s], radius=18*s, fill='#FFFEFB')
    d.line([108*s, 214*s, 404*s, 214*s], fill='#E7A1A1', width=max(2, int(6*s)))
    for y in (262, 304, 346):
        d.line([136*s, y*s, 376*s, y*s], fill='#D7E3F2', width=max(1, int(4*s)))
    d.rectangle([136*s, 236*s, 300*s, 262*s], fill='#FFD84D')
    im.save(f'{out}/icon-{size}.png')
