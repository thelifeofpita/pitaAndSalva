#!/usr/bin/env python3
"""Build the static plates: the landing hands, the destination keyframes, and
the sliced overlay artwork with its positions."""
import json, os, numpy as np
from PIL import Image

K = '/Users/pita/Desktop/pitalva_3/keyframes'
A = '/Users/pita/Desktop/pitalva_3/assets'
IMG = '/Users/pita/Desktop/pitalva_3/site/img'
UI = f'{IMG}/ui'

# where each piece of overlay artwork sits in the 1920x1080 keyframe, recovered
# by template-matching the asset alpha against keyframes/landing.png
POS = {'&': (924, 44), 'rock': (837, 317), 'paper': (922, 314),
       'scissors': (1022, 312), 'salva': (53, 386), 'pita': (1666, 386)}
CAMP = (61, 518)                      # campaigns.png origin
LINES = {'l1': (290, 372, [(18, 338, 'PICK A SIDE'), (456, 833, 'ADS FROM TRASH'),
                           (939, 1380, 'BACK IN SMOOTHLY'), (1469, 1782, 'NUMPAD JAM')],
                [(379, 407), (873, 897), (1410, 1437)]),
         'l2': (404, 485, [(238, 615, 'ADS FROM TRASH'), (721, 1163, 'BACK IN SMOOTHLY'),
                           (1251, 1564, 'NUMPAD JAM')],
                [(656, 679), (1192, 1220)])}


def main():
    os.makedirs(UI, exist_ok=True)
    cfg = {'assets': {}, 'campaigns': [], 'stars': []}

    # landing plate: the keyframe with the overlay artwork erased, so the labels,
    # icons and campaign names can be live elements sitting exactly where they do
    # in the keyframe. Erase only the asset's own pixels — dilating the erase
    # loses the antialiased fringe the asset puts back.
    plate = np.array(Image.open(f'{K}/landing.png').convert('L'))
    def erase(a, x, y):
        reg = plate[y:y + a.shape[0], x:x + a.shape[1]]
        reg[a > 0] = 0

    for n, (x, y) in POS.items():
        im = Image.open(f'{A}/{n}.png')
        key = 'amp' if n == '&' else n
        im.save(f'{UI}/{key}.png')
        cfg['assets'][key] = dict(src=f'ui/{key}.png', x=x, y=y, w=im.width, h=im.height)
        erase(np.array(im)[..., 3], x, y)

    camp = Image.open(f'{A}/campaigns.png')
    ca = np.array(camp)[..., 3]
    for ln, (r0, r1, words, seps) in LINES.items():
        for i, (c0, c1, label) in enumerate(words):
            box = (c0 - 4, r0 - 4, c1 + 4, r1 + 4)
            sub = camp.crop(box)
            f = f'camp_{ln}_{i}.png'; sub.save(f'{UI}/{f}')
            cfg['campaigns'].append(dict(
                src=f'ui/{f}', x=CAMP[0] + box[0], y=CAMP[1] + box[1],
                w=sub.width, h=sub.height, label=label,
                slug=label.lower().replace(' ', '-')))
            erase(ca[box[1]:box[3], box[0]:box[2]], CAMP[0] + box[0], CAMP[1] + box[1])
        for i, (c0, c1) in enumerate(seps):
            box = (c0 - 4, r0 - 4, c1 + 4, r1 + 4)
            sub = camp.crop(box)
            f = f'star_{ln}_{i}.png'; sub.save(f'{UI}/{f}')
            cfg['stars'].append(dict(src=f'ui/{f}', x=CAMP[0] + box[0],
                                     y=CAMP[1] + box[1], w=sub.width, h=sub.height))
            erase(ca[box[1]:box[3], box[0]:box[2]], CAMP[0] + box[0], CAMP[1] + box[1])

    Image.fromarray(plate).convert('1').save(f'{IMG}/landing_plate.png',
                                             optimize=True, bits=1)
    json.dump(cfg, open(f'{IMG}/ui.json', 'w'), indent=1)

    # destination states: the supplied keyframes, used as-is
    for n, o in [('pita', 'kf_pita'), ('salva', 'kf_salva'), ('&', 'kf_amp')]:
        Image.open(f'{K}/{n}.png').convert('L').crop((0, 0, 1920, 1080)) \
            .convert('1').save(f'{IMG}/{o}.png', optimize=True, bits=1)

    # the & page carries live copy, so its plate must not have the placeholder
    # text baked in — otherwise the real text lands on top of the lorem
    amp = np.array(Image.open(f'{K}/&.png').convert('L').crop((0, 0, 1920, 1080)))
    amp[244:847, 647:1204] = 0
    Image.fromarray(amp).convert('1').save(f'{IMG}/kf_amp_plate.png',
                                           optimize=True, bits=1)

    # how close is the recomposited landing to the original keyframe?
    base = Image.open(f'{IMG}/landing_plate.png').convert('RGBA')
    for d in list(cfg['assets'].values()) + cfg['campaigns'] + cfg['stars']:
        base.alpha_composite(Image.open(f'{IMG}/{d["src"]}').convert('RGBA'),
                             (d['x'], d['y']))
    diff = np.abs(np.array(base.convert('L')).astype(int)
                  - np.array(Image.open(f'{K}/landing.png').convert('L')).astype(int))
    print(f'landing recomposite: {100 * (diff <= 8).mean():.3f}% identical, '
          f'{int((diff > 40).sum())} px differ')


if __name__ == '__main__':
    main()
