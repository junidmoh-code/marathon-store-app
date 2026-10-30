# Marathon Club fit rulebook

The stylist (claude-opus-5-5) is sent this file word for word every time it
builds an outfit, and the critic scores the outfit against it. **Junid edits
this file.** Redeploy `functions:socialStillAutopilot`,
`functions:socialDailyAutopilot` and `functions:generateSocialPosts` after an
edit. A test
(`functions/test/fit-rules.test.cjs`) fails on a formula table the code
cannot read. The colour palette, menswear-only rule, season rules and name
rules in `docs/style-guide.md` still decide which products are offered to
the stylist at all. This file decides how they are put together.

## 1. One hero piece

Every fit is built around ONE hero piece. It is usually the sneaker. Pick
the hero first, then choose everything else to support it: its colour, its
formality and its world. Nothing else in the fit may compete with it.

## 2. Colour

- **At most 3 colours** in the whole fit, counting each piece's dominant
  colour and any strong second colour. At least **one of them is a neutral**
  (black, charcoal, grey, white, off-white, cream, light grey or navy).
- Shades of one colour count as one colour (black and charcoal are one,
  white and off-white are one). Blue denim counts as a neutral.
- **The theme name must describe the colours in the picture.** "Earth Tone"
  means the fit is mostly brown, tan, camel, khaki, beige, stone or real
  olive. **Sage, mint, seafoam and pale green are NOT earth tones**: they are
  a green accent. A black graphic tee is not an earth tone. If the colours
  do not match a formula's name, it is the wrong formula.
- Trust the product photo over the tag. If the tag says olive and the photo
  shows brown suede, it is brown.

## 3. Formality must match

Every piece belongs to one tier. The hero's tier sets the fit's tier.

- **Luxury / designer** (Christian Louboutin, Amiri, Alexander McQueen,
  Gucci, Balenciaga, Prada, Dior, Louis Vuitton, Saint Laurent, Bottega
  Veneta, Golden Goose, Dolce & Gabbana, Philipp Plein, Givenchy, Valentino,
  Versace): wear them with **clean pieces only**: plain or minimal tees
  (a small logo at most), knits and knit polos, slim dark or black denim,
  tailored trousers or chinos, leather or suede jackets.
- **Street / runner / court sneakers** (Nike, Air Jordan, adidas, New
  Balance, Asics, Puma, On, Vans, Converse, Reebok): wear them with
  **relaxed pieces**: graphic tees, cargos, track pants, joggers, shorts,
  hoodies, relaxed denim.
- **Never mix a loud graphic or band tee with designer or studded shoes.**
  A Sonic Youth tee with spiked Louboutins is the example of what not to do.
- Prep pieces (Lacoste, Polo Ralph Lauren, Tommy Hilfiger, Hugo Boss) sit
  between the two. They go with clean sneakers and with designer shoes, never
  with loud street graphics.

## 4. One statement piece

One statement per fit: the hero. A statement is a loud print or graphic, a
bright colour, studs or spikes, a big logo, or an unusual texture. If the
hero is a statement (studded designer shoes, a bright sneaker), everything
else is quiet. If a graphic tee is the statement, the hero sneaker is the
anchor and the shoe stays clean and simple. Never three loud things.

## 5. Proportions

A relaxed or oversized top goes with slim or straight bottoms. A fitted top
can take wide or relaxed bottoms. Do not put baggy on baggy, unless the
formula is deliberately street (Earth Tone Street, Court Classic) and the
fit still reads as intentional.

## 6. South African season

It is summer in South Africa from October to March, with hot, humid
Durban days. In summer: tees, shorts, light trousers, light colours and caps.
No puffers, heavy hoodies, beanies or knitwear as a main piece in summer.
A light jacket is fine only as an open layer. In winter (June to August)
layers, knits and hoodies come back.

## 7. The caption

- Name each piece by what it is in the photo: its real colour, its real
  fabric and its real brand. **Never call a piece something it is not.**
  "Raw denim" is only for unwashed denim jeans; green cargo jeans are green
  cargos. Do not name a brand that is not in the fit.
- Never write a price, a shop, "in store", "visit us" or a branch. Marathon
  Club is an online store that delivers across South Africa.
- Two or three short lines. South African English. At most two emoji. At
  most eight hashtags, on their own final line. Do not write the link.

## 8. South African style

Dress him the way stylish young South African men actually dress in Durban and
Johannesburg, not like a European catalogue.

- **The sneaker is the centrepiece.** Clean, box-fresh, laces done; white and
  cream sneakers are the default, worn with everything. A sneaker is never
  hidden under a long hem: cropped, cuffed or tapered bottoms sit on top of it.
- **Durban** (hot and humid in summer): light fabrics, shorts and short
  sleeves, cream, white and bright colours, caps and bucket hats. Relaxed,
  beach-to-city.
- **Johannesburg** (warm days, afternoon storms on the Highveld): sharper and
  darker, more layers; an open light jacket, an overshirt or a track top over a
  tee is normal.
- **Amapiano and smart-casual** looks: a boxy or oversized tee, a knit polo or
  an open short-sleeve shirt, with wide, straight or pleated trousers or
  relaxed cargos, and clean sneakers. Calm colours (cream, black, white, earth
  tones) with one accent. It reads relaxed but deliberate, never sloppy.
- **Tracksuits** are worn as a matching set (adidas, Nike, Puma), the top
  half-zipped or open over a plain tee, with clean runners or court sneakers.
  In summer the track pants go with a tee and no top.
- **Cargos** go with a fitted or oversized plain or graphic tee and chunky
  runners or Air Force 1s.
- **Polos** (Lacoste, Polo Ralph Lauren, Tommy Hilfiger): buttoned, collar
  flat, with chinos, slim denim or tailored shorts and clean leather or
  designer sneakers. A crisp polo with clean white sneakers is a classic.
- **Designer pieces**: ONE per fit, with clean basics around it. Never logos
  head to toe.

## 9. The model wearing it

Every fit is worn by one of the three house models, and the request says which
one and his skin tone. Choose colours that suit him: contrast and warmth that
flatter his skin, never a colour that matches his skin or washes him out near
the face. The critic scores this as "model".

## 10. The fit formulas

Every fit follows exactly one of these. The theme name on the poster is the
formula's name. For "Colour Pop" the name is the accent colour plus "Pop"
(for example "Red Pop"). **Hero**, **tops** and **bottoms** say which
pieces qualify; **colours** say which colours the fit may use.

<!-- config: formulas -->
| key | name | season | hero | tops | bottoms | colours |
|---|---|---|---|---|---|---|
| clean-luxe | Clean Luxe | any | a designer or luxury sneaker, clean or studded | plain or minimal tee, knit polo, leather or suede jacket | slim dark or black denim, tailored trousers, chinos | black, white, off-white, cream, grey, navy, plus the hero's own colour |
| earth-tone-street | Earth Tone Street | any | a street sneaker in brown, tan, khaki, real olive, cream or off-white | graphic or plain tee, hoodie, overshirt in cream, brown, tan, khaki, black or white | cargos, relaxed chinos, relaxed jeans in khaki, tan, brown, stone, beige or real olive | at least two of brown, tan, camel, khaki, beige, stone, real olive; plus one of cream, white, black |
| monochrome-black | Monochrome Black | any | a black or black-and-white sneaker | black or charcoal tee, hoodie or jacket | black jeans, black cargos, black track pants or shorts | black, charcoal, with white only on the shoe |
| summer-white | Summer White | summer | a white or off-white sneaker | white, off-white or cream tee, polo or linen shirt | white, cream, stone or beige shorts or light trousers | white, off-white, cream, plus one of stone, beige, light grey, light blue |
| grey-scale | Grey Scale | any | a grey, white or black sneaker | grey, charcoal, white or black tee or hoodie | grey, charcoal or black bottoms | grey, charcoal, light grey, plus white or black |
| blue-denim | Blue Denim | any | a white, cream, black or navy sneaker | plain white, black, navy or grey tee, or a denim jacket over one | blue jeans or denim shorts | blue denim, plus white, black, navy or grey |
| court-classic | Court Classic | summer | a retro court or basketball sneaker (Air Jordan, Dunk, Air Force 1, adidas court) | graphic tee, jersey-style tee, plain tee | track pants, relaxed shorts, cargos, relaxed jeans | the sneaker's two colours plus one neutral |
| runner-tech | Runner Tech | any | a technical runner (New Balance, Asics, On, Nike Air Max, Nike running) | performance or plain tee, light track top | track pants, nylon shorts, technical cargos | grey, black, navy, white, plus at most one colour from the runner |
| prep-smart | Prep Smart | any | a clean leather or suede sneaker, or a designer sneaker | polo, knit polo, plain tee, overshirt (Lacoste, Polo Ralph Lauren, Tommy Hilfiger, Hugo Boss) | chinos, tailored shorts, slim dark denim | navy, white, cream, beige, stone, light blue, plus one muted colour (forest green, burgundy) |
| colour-pop | Colour Pop | any | a sneaker in one clear accent colour | a quiet neutral tee, or one piece that repeats the shoe's accent colour | neutral bottoms (black, grey, stone, denim, white) | the one accent colour plus at most two neutrals |
| amapiano-weekend | Amapiano Weekend | any | a clean white, cream or retro sneaker (adidas Samba or Gazelle, New Balance, Air Force 1, Air Max) | boxy or oversized plain tee, knit polo, open short-sleeve shirt | wide, straight or pleated trousers, relaxed cargos | cream, white, black, plus one earth tone or muted accent |
| joburg-tracksuit | Joburg Tracksuit | any | a runner or court sneaker (adidas, Nike, Puma, New Balance) | a track top or tracksuit jacket over a plain tee, or a plain tee alone in summer | the matching or toning track pants | the tracksuit's colour plus white or black |
| durban-smart-casual | Durban Smart Casual | summer | a clean white leather or designer sneaker | polo, knit polo or a light short-sleeve shirt | chinos, tailored shorts or slim light denim | white, cream, stone, beige, light blue, navy, plus one bright summer accent |
