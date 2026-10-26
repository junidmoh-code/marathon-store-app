# Marathon Club style guide — how the stylist puts an outfit together

**Since 26 Oct 2026 the fits themselves are built by claude-opus-5-5 from
the written rulebook in [`functions/lib/fit-rulebook.md`](../functions/lib/fit-rulebook.md)
(one hero piece, at most 3 colours, matched formality, one statement piece,
proportions, season, 10 named formulas) and scored by a separate critic call.
This file still decides which products the stylist is offered (palette,
menswear only, season, names).**

This file is the stylist's rulebook. Every multi-product post (the lookbook
poster, flat-lays, pairings and outfits) is chosen against it. **Junid edits
this file**; the stylist reads `functions/lib/style-guide.json`, which is
derived from it:

    node scripts/social/build-style-guide.mjs     # rewrite the JSON from this file
    node scripts/social/build-style-guide.mjs --check   # fail if the JSON is stale

A test (`functions/test/style-guide.test.cjs`) fails when the two disagree, so
an edit here that was not rebuilt cannot be deployed by accident. Then deploy
the functions that use it (see the end of this file).

Only the tables marked `<!-- config: … -->` are read by the script. The prose
around them explains them and is free to change. Inside a table, keep the
column order and the words in the `family` / `season` / `pattern` columns to
the vocabulary given; the script refuses anything it does not know and says
which row.

---

## 1. Where the rules come from

The rules are the shared habits of the stylists and brands the shop sells and
studies, reduced to things a computer can check:

- **Neutral base, one accent.** Menswear editorial (MR PORTER's colour guides,
  the "6-3-1" split) builds an outfit on ~60% neutral base, ~30% secondary
  neutral and ~10% accent. Neutrals are low-contrast and go with each other;
  the accent is a cap, a sneaker or one top, never three things competing.
- **Tonal dressing.** Fear of God / Essentials lookbooks are almost entirely
  tonal: taupe, cream, oatmeal, grey, brown and black, with branding tone on
  tone and at most one soft accent. Aimé Leon Dore works the same way on an
  ecru/taupe base with one heritage colour (forest green, navy, burgundy).
- **Earth tones as one family.** Carhartt WIP, ALD and Essentials put khaki,
  olive, brown, tan, stone and cream together freely: they are one family and
  never clash with each other.
- **One loud thing.** Represent, Nike and adidas lookbooks let one piece carry
  the graphic, the big logo or the bright colour; everything around it goes
  quiet. Two loud pieces fight.
- **Volume balance.** Streetwear runs oversized, but the lookbooks balance it:
  a boxy hoodie over straight or tapered trousers, a fitted tee over wide
  cargos. Oversized on top AND bottom only works with a structured cut, so the
  stylist never makes an all-baggy outfit.
- **The white sneaker anchors anything.** Every stylist guide agrees: a plain
  white (or off-white) low-top goes with jeans, chinos, shorts, tracksuits and
  a soft blazer, and it ties a coloured outfit together.
- **One world per outfit.** Sportswear (Nike, adidas, Puma, Under Armour),
  streetwear (Essentials, Represent, Carhartt, G-Star), prep (Lacoste, Polo
  Ralph Lauren, Tommy Hilfiger, Hugo Boss, ALD) and smart-casual live next to
  each other on a rail, but an outfit draws from one world, or from two that
  border each other (sport luxe = sport + street; prep casual = prep +
  smart-casual).
- **Formality stays close.** A suit trouser and a running short are three
  steps apart. The pieces of one look stay within two steps on a 1–5 scale.
- **Durban weather.** Summer is long, hot and humid (October to March); winter
  is mild (June to August, 20–24 °C days); April, May and September sit
  between. Summer favours tees, shorts, light colours and caps; a puffer or a
  beanie in January reads as wrong, and so does a cardigan over a sweater vest
  in October.
- **Menswear only.** Every post is styled on a man. A women's piece (by its
  tag, or by its name: "women's", "ladies", bike shorts, leggings, crop tops,
  dresses, skirts) is removed before anything is scored, and so is a piece
  whose gender the tagger has not read yet. This is in code, not a table.

## 2. The palette

Every product is tagged with a **dominant** and a **secondary** colour from
this list (the vision tagger is shown it and must answer from it). `family`
decides how colours combine:

- `dark` and `light` neutrals go with everything;
- `earth` is the khaki/olive/brown/tan family and goes with neutrals and with
  itself;
- `denim` is a neutral too (it is the blue of jeans, not a colour statement);
- `accent` is a colour statement. An outfit gets at most ONE accent hue.

`loud: yes` marks the colours that shout on their own (a bright red hoodie is
the loud piece of its outfit even with no print on it).

<!-- config: palette -->
| colour | family | loud | also called |
|---|---|---|---|
| black | dark | no | jet, onyx |
| charcoal | dark | no | anthracite, dark grey |
| grey | dark | no | heather grey, mid grey, slate |
| navy | dark | no | dark blue, midnight |
| white | light | no | optic white |
| off-white | light | no | ecru, ivory, sail, bone |
| cream | light | no | oatmeal, vanilla |
| light-grey | light | no | pale grey, silver grey, ash |
| beige | earth | no | sand, taupe, nude |
| stone | earth | no | putty, mushroom |
| khaki | earth | no | desert |
| camel | earth | no | tan, wheat |
| brown | earth | no | chocolate, mocha, coffee |
| olive | earth | no | military green, sage |
| denim-light | denim | no | light wash, bleached denim |
| denim-mid | denim | no | mid wash, indigo |
| denim-dark | denim | no | raw denim, rinse |
| forest-green | accent | no | bottle green, dark green |
| burgundy | accent | no | maroon, wine, oxblood |
| light-blue | accent | no | sky blue, baby blue, powder blue |
| red | accent | yes | scarlet, university red |
| orange | accent | yes | rust-orange, safety orange |
| yellow | accent | yes | mustard, gold |
| green | accent | yes | kelly green, lime |
| blue | accent | yes | royal blue, cobalt |
| pink | accent | yes | rose, salmon |
| purple | accent | yes | lilac, violet |
| teal | accent | no | petrol, turquoise |
| multi | accent | yes | multicolour, rainbow |

## 3. Style families

Each product belongs to one family. The vision tagger decides it from the
photograph; the brands below are the stylist's prior, used to read the
product's name when no photo tag exists. `borders` lists the families an
outfit may mix with this one; any other mix is refused. A border works in
both directions, so it only needs writing on one of the two rows.

<!-- config: families -->
| family | borders | brands | categories |
|---|---|---|---|
| streetwear | athleisure, smart-casual | Fear of God, Essentials, Represent, Carhartt, G-Star Raw, Palm Angels, Off-White, Stussy, Supreme, Nocta, Corteiz, Trapstar, Amiri, Purple Brand, Marathon Club | hoodies, jackets, t-shirts, jeans, pants, caps-beanies, bags |
| athleisure | streetwear | Nike, adidas, Air Jordan, Puma, New Balance, Under Armour, Asics, On, Reebok, The North Face | tracksuits, shorts, sneakers, golf-t-shirts, soccer-jerseys, fitted-caps, visors, slides |
| prep | smart-casual | Lacoste, Polo Ralph Lauren, Ralph Lauren, Tommy Hilfiger, Hugo Boss, Calvin Klein, Aimé Leon Dore, Michael Kors, Karl Lagerfeld, Emporio Armani | golf-t-shirts, pants |
| smart-casual | prep, streetwear | Alexander McQueen, Dolce & Gabbana, Saint Laurent, Louis Vuitton, Bottega Veneta, Brunello Cucinelli, Loro Piana, Philipp Plein, Stone Island | designer-shoes, boots, pants |

## 4. The checks and their weights

**Hard rules** refuse an outfit outright. **Scores** rank the ones left; each
is 0–1 and is multiplied by its weight, so the weights are the points out of
100 each part is worth.

<!-- config: rules -->
| rule | value | meaning |
|---|---|---|
| maxAccentHues | 1 | at most this many different accent colours as a DOMINANT colour (hard) |
| maxLoudPieces | 1 | at most this many loud pieces: a print, a logo-heavy piece or a loud colour (hard) |
| maxFormalitySpread | 2 | highest formality minus lowest, on the 1–5 scale (hard) |
| neverAllOversized | 1 | 1 = refuse an outfit whose every garment is oversized (hard) |
| oneFamilyOrBorder | 1 | 1 = refuse two families that do not border each other (hard) |
| weightColour | 28 | colour harmony |
| weightSilhouette | 14 | volume balance between top and bottoms |
| weightFamily | 18 | one style family (a bordering family scores lower) |
| weightFormality | 10 | formality kept close |
| weightSeason | 14 | right for Durban this month |
| weightLook | 10 | how cleanly it matches one of the named looks below |
| weightFresh | 6 | new arrivals, studio photos, sales, not shown lately |
| offSeasonPenalty | 6 | points off for each piece made for the other season (a beanie in a Durban summer) |
| perPieceOverMin | 2 | points for each lookbook piece beyond the three-piece minimum |
| whiteSneakerBonus | 0.12 | added to the colour score when the sneakers are white or off-white |
| echoBonus | 0.08 | added when the one accent appears on exactly two pieces (cap and sneaker) |
| secondAccentPenalty | 0.3 | taken off when a second accent hue appears as a SECONDARY colour |
| noAccentScore | 0.85 | colour score of an all-neutral outfit that is neither monochrome nor earth |
| tieWindow | 6 | the text model may choose only among outfits within this many points of the best |
| shortlist | 5 | how many of the best outfits the text model is shown |
| perSlot | 6 | candidates per slot the enumerator combines, per look |

## 5. Durban seasons

<!-- config: seasons -->
| month | season |
|---|---|
| 1 | summer |
| 2 | summer |
| 3 | summer |
| 4 | shoulder |
| 5 | shoulder |
| 6 | winter |
| 7 | winter |
| 8 | winter |
| 9 | shoulder |
| 10 | summer |
| 11 | summer |
| 12 | summer |

What each season allows. `outer layer penalty` is the points taken off for
every outer layer (the jacket row: jackets, hoodies, cardigans) and
`knitwear penalty` for every knitted garment (a sweater, a cardigan, a sweater
vest); a piece that is both pays the larger one, once. They are big on
purpose: in a Durban summer a jacket only appears when nothing else can be
dressed. `headwear` lists the hats that may be worn at all; anything else
(a beanie in summer) is removed before scoring. Kinds: cap, beanie, bucket,
visor.

<!-- config: seasonRules -->
| season | outer layer penalty | knitwear penalty | headwear |
|---|---|---|---|
| summer | 20 | 20 | cap |
| shoulder | 0 | 4 | cap, beanie, bucket |
| winter | 0 | 0 | cap, beanie, bucket, visor |

Each product is tagged as a `summer`, `winter` or `all` piece. How well a piece
fits the month (the season score is the average over the outfit):

<!-- config: seasonFit -->
| piece | summer | winter | shoulder |
|---|---|---|---|
| summer | 1 | 0.5 | 0.8 |
| winter | 0.3 | 1 | 0.8 |
| all | 0.9 | 0.9 | 1 |

## 6. The named looks

Every chosen outfit is named after the look it matches best, and that name
heads the lookbook panel (the old "THE EVERYDAY LEGACY COLLECTION" header is
the fallback when nothing matches). Columns:

- `palette`: the colours the look is made of. An outfit matches the look as
  far as its pieces' dominant colours are in this list.
- `families`: the style families the look belongs to.
- `core` / `extras`: the slot template. Core slots must all be filled
  (`tee|jacket` means either); extras are the optional pieces the look may
  add, and on the lookbook a look wears ONLY the extras listed here. Every
  look's core is a top, bottoms and sneakers (three rows); the outer layer
  (jacket), headwear (hat) and bag are optional, so a lookbook has 3 to 6
  rows. Headwear: at most a third of the looks list `hat`, never a summer
  look, and the lookbook wears a hat in at most one poster in three (the
  build refuses a guide that breaks the first two). Slots: hat, jacket, tee,
  bottoms, bag, sneakers, fragrance.
- `requires`: extra conditions, from this vocabulary only —
  `mono` (every dominant colour is in one neutral family, dark or light,
  with black/white allowed as anchors), `earth>=N` (at least N pieces with an
  earth dominant colour), `denim` (the bottoms are denim), `shorts` (the
  bottoms are shorts), `summer` / `winter` (only in that season),
  `accent=1` (exactly one accent hue), `noaccent` (no accent hue at all).
- `header`: the panel header, `|` breaks the line.

<!-- config: looks -->
| key | name | header | families | palette | core | extras | requires |
|---|---|---|---|---|---|---|---|
| clean-monochrome | Clean Monochrome | CLEAN\|MONOCHROME | streetwear, athleisure, smart-casual | black, charcoal, grey, white, off-white, cream, light-grey | tee, bottoms, sneakers | hat, jacket, bag | mono, noaccent |
| earth-tone-street | Earth Tone Street | EARTH TONE\|STREET | streetwear, smart-casual | beige, stone, khaki, camel, brown, olive, cream, off-white, black, white | tee, bottoms, sneakers | jacket, bag | earth>=2 |
| sport-luxe | Sport Luxe | SPORT\|LUXE | athleisure, streetwear | black, charcoal, grey, white, off-white, light-grey, navy, red, blue, green, orange, yellow, teal, purple, pink | tee, bottoms, sneakers | hat, jacket, bag | accent=1 |
| prep-casual | Prep Casual | PREP\|CASUAL | prep, smart-casual | navy, white, off-white, cream, beige, stone, light-blue, forest-green, burgundy, denim-light, denim-mid, denim-dark, khaki | tee, bottoms, sneakers | jacket, bag | |
| raw-denim | Raw Denim | RAW\|DENIM | streetwear, smart-casual, prep | denim-light, denim-mid, denim-dark, black, white, off-white, grey, charcoal, navy, olive | tee, bottoms, sneakers | jacket, bag | denim |
| coastal-summer | Coastal Summer | COASTAL\|SUMMER | athleisure, prep, streetwear | white, off-white, cream, beige, stone, light-grey, light-blue, navy, khaki, teal | tee, bottoms, sneakers | bag | shorts, summer |

## 7. Formality, 1 to 5

Tagged per product by the vision call. For reference:

1. gym and pitch: running shorts, jerseys, slides
2. sport-casual: tracksuits, hoodies, caps, chunky sneakers
3. casual: tees, jeans, cargos, clean sneakers, backpacks
4. smart-casual: polos, chinos, overshirts, leather sneakers
5. dressed: tailored trousers, knitwear, loafers, designer shoes

## 8. After editing this file

    node scripts/social/build-style-guide.mjs
    cd functions && npm test -- test/style-guide.test.cjs
    firebase deploy --only functions:socialStillAutopilot,functions:socialDailyAutopilot,functions:generateSocialPosts --project marathon-club
