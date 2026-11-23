# Missing Products — "Not listed" census, 23 Nov 2026

Snapshot read once at 2026-11-23T20:56:45.493Z (22:57 SAST), 40.5 MB: /stock and /stock_targets for the 9 locations, /products, /refill_requests, config/refillEngine, network, held lines, hidden map, the two division index nodes, seats and engine open markers per location. Run through the real screen code (`notListedCensus.harness.test.jsx`).

The rule: a product with units at Central and **zero units at every shop and every hub of a division** (a row at 0 counts as zero). Value = Central units × stock price (cost); retail in brackets.

## Marathon: 401 products — 224 on the list, 177 not listed

| Reason | Group | Products | Units at Central | Value (cost) | Retail |
|---|---|---:|---:|---:|---:|
| **On the list** |  | 224 | 1340 | R493 430 | R506 960 |
| Marked Concrete | chosen | 77 | 1063 | R357 600 | R361 320 |
| Requested — waiting at Central | rule | 62 | 872 | R471 780 | R526 010 |
| All promised to open requests | rule | 26 | 65 | R23 160 | R23 650 |
| No product record | data | 9 | 190 | R0 | R0 |
| No policy | rule | 1 | 7 | R4 200 | R4 200 |
| Central's size is not on the product | data | 1 | 4 | R1 000 | R1 000 |
| Empty rows at a shop, no request | rule | 1 | 1 | R430 | R450 |

## Concrete: 659 products — 567 on the list, 92 not listed

| Reason | Group | Products | Units at Central | Value (cost) | Retail |
|---|---|---:|---:|---:|---:|
| **On the list** |  | 567 | 5128 | R1 724 385 | R1 850 609 |
| All promised to open requests | rule | 49 | 213 | R96 512 | R104 407 |
| No product record | data | 19 | 347 | R0 | R0 |
| Requested — waiting at Central | rule | 15 | 2216 | R123 950 | R133 100 |
| Central's size is not on the product | data | 4 | 24 | R8 950 | R9 450 |
| Shop paused, empty rows | rule | 2 | 26 | R7 600 | R7 600 |
| No policy | rule | 1 | 28 | R12 600 | R14 000 |
| At both Pine and Concrete | rule | 1 | 2 | R500 | R500 |
| Central has none of the sizes it needs | rule | 1 | 1 | R1 099 | R1 149 |

## Marathon — every product not listed

| Product | pid | Category | Central | Value | Reason |
|---|---|---|---:|---:|---|
| Yomo stylish t shirt 4176 | p1791710717195 | t-shirts | 6 | R1 800 | All promised to open requests |
| Oscarhomme black 5932 | p1793278275595 | hoodies | 6 | R2 400 | All promised to open requests |
| Lacoste beanie black | p1793364992675 | caps-beanies | 6 | R900 | All promised to open requests |
| Velrsonze cream white 9909 | p1793277928519 | hoodies | 5 | R2 000 | All promised to open requests |
| Oskar homme 5903 brown | p1793885942153 | hoodies | 4 | R1 600 | All promised to open requests |
| Pant brown 1158 SHOUZHAN | p1787999484206 | pants | 3 | R1 200 | All promised to open requests |
| BF borfend C130# | p1791805645609 | hoodies | 3 | R1 200 | All promised to open requests |
| jean pants L9086# | p1793104592551 | pants | 3 | R1 200 | All promised to open requests |
| Pants jean L9192# | p1793105377199 | pants | 3 | R1 200 | All promised to open requests |
| Pant M19693 Mf studio grey | p1794395249190 | pants | 3 | R1 140 | All promised to open requests |
| Denim pant green 1802 | p1787832576692 | pants | 2 | R800 | All promised to open requests |
| GaLLERY DEPT  T SHIRT  cover-18 | p1789216086077 | t-shirts | 2 | R500 | All promised to open requests |
| Mf studio t shirt  grey m19367# | p1791108678030 | t-shirts | 2 | R600 | All promised to open requests |
| Shambeen t shirt  blue 9129# | p1791811786704 | t-shirts | 2 | R600 | All promised to open requests |
| Purple brand Jean colorway:202319# | p1793029023451 | pants | 2 | R1 300 | All promised to open requests |
| Jean pants L9226# | p1793110838790 | pants | 2 | R800 | All promised to open requests |
| Jean pants L9193A# | p1793112270428 | pants | 2 | R800 | All promised to open requests |
| Long m15200 grey | p1785499073233 | t-shirts | 1 | R300 | All promised to open requests |
| Giavceye denim jean | p1789139604907 | pants | 1 | R420 | All promised to open requests |
| Jie jiu pants 5355 | p1790852257554 | pants | 1 | R400 | All promised to open requests |
| M9517 Jean | p1790865482474 | pants | 1 | R400 | All promised to open requests |
| Jean white short 5539# | p1790935192398 | shorts | 1 | R250 | All promised to open requests |
| Jean short  T05# | p1790935445208 | shorts | 1 | R250 | All promised to open requests |
| Sweater long sleeve zy610# | p1790948024609 | hoodies | 1 | R400 | All promised to open requests |
| Boss t shirt white :w658# | p1793018714295 | t-shirts | 1 | R300 | All promised to open requests |
| Shemilo cream white 1573 | p1793277790998 | hoodies | 1 | R400 | All promised to open requests |
| Liaoxun D1010 Jeans Dark Wash | p1782221237068 | pants | 1 | R430 | Empty rows at a shop, no request |
| Sweater hoodie Grey PAGANISM-ETE E8608# | p1787473621070 | hoodies | 26 | R11 700 | Marked Concrete |
| Shambeent  cream t shirt  26135# | p1788175908037 | t-shirts | 20 | R6 000 | Marked Concrete |
| Shambeen black t shirt #26135 | p1788176657746 | t-shirts | 20 | R6 000 | Marked Concrete |
| T-shirt 26151 SHAMBEEN cream white | p1788267755358 | t-shirts | 20 | R6 000 | Marked Concrete |
| T-shirt black 26125 PLANE | p1788359520872 | t-shirts | 20 | R6 000 | Marked Concrete |
| T-shirt green F7331# EXTREME CAUSE | p1788515065565 | t-shirts | 20 | R6 000 | Marked Concrete |
| Shambeen t shirt   white & chocolate 26149# | p1791192667464 | t-shirts | 20 | R6 000 | Marked Concrete |
| Shambeen Sweater   brown 9555# | p1791379939950 | hoodies | 20 | R8 000 | Marked Concrete |
| Shambeen sweat  black 9555# | p1791380290066 | hoodies | 20 | R8 000 | Marked Concrete |
| Shambeen green t shirt 26149# | p1791193552564 | t-shirts | 19 | R5 700 | Marked Concrete |
| T-shirt F7331# red EXTREME CAUSE | p1788514787763 | t-shirts | 18 | R5 400 | Marked Concrete |
| Shambeen t shirt 26149# | p1791193965923 | t-shirts | 18 | R5 400 | Marked Concrete |
| T shirt F651# | p1791636305574 | t-shirts | 17 | R5 100 | Marked Concrete |
| T shirt F 651# | p1791636568365 | t-shirts | 17 | R5 100 | Marked Concrete |
| Pant green 1158 SHOUZHAN | p1788001158718 | pants | 16 | R6 400 | Marked Concrete |
| T-shirt PATTABON 620 WHITE | p1788600194219 | t-shirts | 16 | R4 800 | Marked Concrete |
| T-shirt CVT -27 ENFANTS RICHES DEPRIMES | p1788602130660 | t-shirts | 16 | R4 000 | Marked Concrete |
| T-shirt PATTABON 3356 WHITE | p1788603945731 | t-shirts | 16 | R4 800 | Marked Concrete |
| Yomo stylish golf t shirt 4303# | p1788782518756 | golf-t-shirts | 16 | R4 800 | Marked Concrete |
| Mr .199i inc & blue short sliver is | p1789657047236 | t-shirts | 16 | R4 800 | Marked Concrete |
| Golf t-shirt 26202 cream shambeen | p1788514050117 | golf-t-shirts | 15 | R4 500 | Marked Concrete |
| T-shirt PATTABON 620 BLACK | p1788600302730 | t-shirts | 15 | R4 500 | Marked Concrete |
| Shambeen  grey 9543# | p1791197133837 | hoodies | 15 | R6 000 | Marked Concrete |
| Shambeen cream 9539# | p1791197305446 | hoodies | 15 | R6 000 | Marked Concrete |
| Shambeen black  9539 | p1791197612308 | hoodies | 15 | R6 000 | Marked Concrete |
| Shambeen black  9543# | p1791299294431 | hoodies | 15 | R6 000 | Marked Concrete |
| T- shirt grey 9927# | p1791893308528 | t-shirts | 15 | R4 500 | Marked Concrete |
| Golf t-shirt white BC 2036# | p1787481065973 | golf-t-shirts | 14 | R4 200 | Marked Concrete |
| T shirt Grey F7135# EXTREME CAUSE | p1788262139562 | t-shirts | 14 | R4 200 | Marked Concrete |
| EXTREME CAUSE F7086# TSHIRT MAROON | p1788267027865 | t-shirts | 14 | R4 200 | Marked Concrete |
| GOLF T-SHIRT 26202 BLACK  SHAMBEEN | p1788608063061 | golf-t-shirts | 14 | R4 200 | Marked Concrete |
| T-shirt 026 YL-BOILING CREAM | p1788608258818 | t-shirts | 14 | R4 200 | Marked Concrete |
| Denim jean short T9068# | p1790942826274 | shorts | 14 | R4 200 | Marked Concrete |
| Sweater hoodie black plane e8665# | p1787322313345 | hoodies | 13 | R5 850 | Marked Concrete |
| Shambeen long sleeve 9536# | p1788770848750 | t-shirts | 13 | R3 900 | Marked Concrete |
| Shambeen black  t shirt 9167# | p1791106143865 | t-shirts | 13 | R3 900 | Marked Concrete |
| Shambeen sweat shirt 'black 'long sleeve 9606 | p1791202001195 | hoodies | 13 | R5 200 | Marked Concrete |
| Yomo stylish cream white 21017 | p1793280903466 | hoodies | 13 | R5 200 | Marked Concrete |
| Sweater hoodie brown plane 9551#1 | p1787323581968 | hoodies | 12 | R5 400 | Marked Concrete |
| T-shirt black GLFS T1013 | p1787388957279 | t-shirts | 12 | R3 600 | Marked Concrete |
| Golf t-shirt white BC 9090# | p1787476051207 | golf-t-shirts | 12 | R4 200 | Marked Concrete |
| Golf t-shirt cream white BC PLANE | p1787477429476 | golf-t-shirts | 12 | R3 600 | Marked Concrete |
| Golf t-shirt white BC | p1787482201226 | golf-t-shirts | 12 | R3 600 | Marked Concrete |
| Pant green k8 SHOUZHAN | p1787999971263 | pants | 12 | R4 800 | Marked Concrete |
| Pant brown 1133 SHOUZHAN | p1788001312759 | pants | 12 | R4 800 | Marked Concrete |
| Sweatshirt ZY657# cream white ZEYISHENSHI | p1788263393464 | hoodies | 12 | R4 800 | Marked Concrete |
| Sweatshirt black ZY655#zeyishenshi | p1788266779392 | hoodies | 12 | R4 800 | Marked Concrete |
| T-shirt F7169# EXTREME CAUSE BLACK | p1788602374804 | t-shirts | 12 | R3 600 | Marked Concrete |
| T-shirt 507 YL-BOILING CREAM WHITE | p1788605999507 | t-shirts | 12 | R3 600 | Marked Concrete |
| CRV-13 IRVINGTON ROI REBIS BLACK | p1788607567909 | t-shirts | 12 | R3 000 | Marked Concrete |
| Sweatshirt 2606 yomo stylish brown | p1794061091182 | hoodies | 12 | R4 800 | Marked Concrete |
| Sweater hoodie cream white PAGANISM-ETE E8608# | p1787473448041 | hoodies | 11 | R4 950 | Marked Concrete |
| Golf t-shirt white end black BC PLANE | p1787478113827 | golf-t-shirts | 11 | R3 300 | Marked Concrete |
| Golf t-shirt white grey BC | p1787480750958 | golf-t-shirts | 11 | R3 300 | Marked Concrete |
| Golf t-shirt cream white BC 2037# | p1787481975597 | golf-t-shirts | 11 | R3 300 | Marked Concrete |
| Pant brown 1172 SHOUZHAN | p1787998824721 | pants | 11 | R4 400 | Marked Concrete |
| Pant brown k8 SHOUZHAN | p1787998985707 | pants | 11 | R4 400 | Marked Concrete |
| T-shirt F7086# EXTREME CAUSE | p1788266550411 | t-shirts | 11 | R3 300 | Marked Concrete |
| T-shirt PATTABON 3356 BLACK | p1788604090392 | t-shirts | 11 | R3 300 | Marked Concrete |
| T-shirt 66019 YL-BOILING BLACK | p1788605030014 | t-shirts | 11 | R3 300 | Marked Concrete |
| T-shirt 2863 M.FOUR BLACK | p1788606801150 | t-shirts | 11 | R3 300 | Marked Concrete |
| T-SHIRT 026 YL-BOILING BLACK | p1788608411393 | t-shirts | 11 | R3 300 | Marked Concrete |
| Yomo  stylish 4310 | p1788775934831 | t-shirts | 11 | R3 300 | Marked Concrete |
| Mesh knitted short white M19696# | p1788864491571 | shorts | 11 | R3 300 | Marked Concrete |
| Mesh knitted short sleeve m19350 | p1788865318408 | t-shirts | 11 | R3 300 | Marked Concrete |
| Mesh knitted shirt black m19696# | p1788866377934 | shorts | 11 | R3 300 | Marked Concrete |
| Mesh knitted short sleeve black m19350# | p1788866843251 | t-shirts | 11 | R3 300 | Marked Concrete |
| Yomo stylish golf  shirt  navy blue 3451# | p1791382883062 | golf-t-shirts | 11 | R3 300 | Marked Concrete |
| T-shirt black F7080# | p1791891946546 | t-shirts | 11 | R3 300 | Marked Concrete |
| T-shirt white & black 9166 | p1791899859182 | t-shirts | 11 | R3 300 | Marked Concrete |
| Velrsonze brown 9920 | p1793270013437 | hoodies | 11 | R4 400 | Marked Concrete |
| Velrsonze brown 9919 | p1793273863241 | hoodies | 11 | R4 400 | Marked Concrete |
| Velrsonze black 9919 | p1793274309936 | hoodies | 11 | R4 400 | Marked Concrete |
| Sweater hoodie right Grey plane E8665# | p1787321599152 | hoodies | 10 | R4 500 | Marked Concrete |
| Sweater hoodie white plane 9551#1 | p1787322753835 | hoodies | 10 | R4 500 | Marked Concrete |
| Sweater hoodie black end Grey PAGANISM-ETE E8719# | p1787474708458 | hoodies | 10 | R4 500 | Marked Concrete |
| Golf t-shirt black end white BC 9089# | p1787477038184 | golf-t-shirts | 10 | R3 000 | Marked Concrete |
| Suit jacket black FF1070 RVX | p1787931171527 | suits | 7 | R4 200 | No policy |
| p1781428112499 | p1781428112499 | — | 81 | R0 | No product record |
| p1790253981910 | p1790253981910 | — | 50 | R0 | No product record |
| p1791288459752 | p1791288459752 | — | 17 | R0 | No product record |
| p1787484091247 | p1787484091247 | — | 11 | R0 | No product record |
| p1787484381601 | p1787484381601 | — | 10 | R0 | No product record |
| p1787925551485 | p1787925551485 | — | 10 | R0 | No product record |
| p1791628860039 | p1791628860039 | — | 8 | R0 | No product record |
| p1777979644761 | p1777979644761 | — | 2 | R0 | No product record |
| p1785936389183 | p1785936389183 | — | 1 | R0 | No product record |
| Nike Air Force 1 Black | p1780740402191 | sneakers | 98 | R53 900 | Requested — waiting at Central |
| Adidas tracksuit full black | p1782998928611 | tracksuits | 54 | R37 800 | Requested — waiting at Central |
| Nike SB dunk low grey small | p1795103464793 | kids-shoes | 30 | R7 500 | Requested — waiting at Central |
| Nike SB dunk small black white | p1795103158565 | kids-shoes | 28 | R7 000 | Requested — waiting at Central |
| Jordan 4 small black and red | p1795101959244 | kids-shoes | 26 | R6 500 | Requested — waiting at Central |
| Airforce Nike Supreme cream white | p1784724999068 | sneakers | 25 | R16 250 | Requested — waiting at Central |
| Nike supreme trucksuits black and grey9760-A | p1795245684093 | tracksuits | 24 | R15 600 | Requested — waiting at Central |
| Nike airforce 1 dark blue | p1789139697049 | sneakers | 23 | R14 950 | Requested — waiting at Central |
| Adidas tracksuit yellow 2613# | p1793610220447 | ladies-tracksuits | 23 | R21 850 | Requested — waiting at Central |
| Emporio Armani tracksuit EA7 dark greyS-99091 | p1795183098077 | tracksuits | 22 | R15 400 | Requested — waiting at Central |
| Emporio Armani tracksuit EA7 dark blue S-99091# | p1795185243416 | tracksuits | 22 | R15 400 | Requested — waiting at Central |
| Timberland Black and grey | p1795081369672 | sneakers | 19 | R13 300 | Requested — waiting at Central |
| Nike supreme tracksuit black 9760# | p1795187653415 | tracksuits | 19 | R13 300 | Requested — waiting at Central |
| Adidas Real Madrid tracksuit white and grey | p1784818422367 | tracksuits | 15 | R9 000 | Requested — waiting at Central |
| adidas Arsenal FC 25/26 Tiro  tracksuit two-tone blue | p1784818738721 | tracksuits | 15 | R9 000 | Requested — waiting at Central |
| Adidas Real Madrid Tiro black tracksuit | p1784818933061 | tracksuits | 15 | R9 000 | Requested — waiting at Central |
| Arsenal F.C tracksuit gray | p1784819553910 | tracksuits | 15 | R9 000 | Requested — waiting at Central |
| Adidas real Madrid dark gray | p1784819669529 | tracksuits | 15 | R9 000 | Requested — waiting at Central |
| Nike FC Barcelona Away Men's  black & purple | p1784819901479 | tracksuits | 15 | R9 000 | Requested — waiting at Central |
| Under armour black meroni | p1795081119939 | sneakers | 15 | R10 500 | Requested — waiting at Central |
| Timberland black | p1795090197630 | sneakers | 15 | R10 500 | Requested — waiting at Central |
| Timberland | p1795091316459 | sneakers | 15 | R10 500 | Requested — waiting at Central |
| Lacoste bucket hat navy blue | p1795097146213 | caps-beanies | 15 | R2 250 | Requested — waiting at Central |
| Nike cap white | p1795100731218 | caps-beanies | 15 | R2 250 | Requested — waiting at Central |
| Adidas Argentina tracksuit Tiro Travel Windbreaker in Crew Blue featur | p1784817725258 | tracksuits | 13 | R7 800 | Requested — waiting at Central |
| Adidas Real Madrid Tiro 25 Competition tracksuit | p1784818135986 | tracksuits | 13 | R7 800 | Requested — waiting at Central |
| Nike Paris Saint-Germain Windrunner tracksuit black | p1784819111934 | tracksuits | 13 | R7 800 | Requested — waiting at Central |
| Puma Portugal FPF tracksuit navy blue | p1784819289133 | tracksuits | 13 | R7 800 | Requested — waiting at Central |
| Diesel paperbag (big size) | p1791885927781 | bags | 13 | R520 | Requested — waiting at Central |
| Armani exchange white t shirts 494# | p1793013085510 | t-shirts | 13 | R3 900 | Requested — waiting at Central |
| Lacoste full black | p1795085907213 | sneakers | 11 | R10 450 | Requested — waiting at Central |
| Diesel t shirt white 10# | p1793016643790 | t-shirts | 10 | R3 000 | Requested — waiting at Central |
| Diesel Jean dark grey :Y8168# | p1793029770274 | pants | 10 | R6 500 | Requested — waiting at Central |
| Diesel jean blie 8169# | p1793091919992 | pants | 10 | R6 500 | Requested — waiting at Central |
| Hugo boss t shirt black w678# | p1793632326537 | t-shirts | 10 | R3 000 | Requested — waiting at Central |
| Hugo boss t shirt white w678# | p1793632453382 | t-shirts | 10 | R3 000 | Requested — waiting at Central |
| Replay t shirt black w638# | p1793632690994 | t-shirts | 10 | R3 000 | Requested — waiting at Central |
| Replay t shirt cream white w638# | p1793632929862 | t-shirts | 10 | R3 000 | Requested — waiting at Central |
| John Richmond jean black JR04# | p1793697574726 | pants | 10 | R6 500 | Requested — waiting at Central |
| Lacoste navy and white | p1795085363154 | sneakers | 10 | R9 500 | Requested — waiting at Central |
| Diesel black | p1795088116786 | sneakers | 10 | R9 500 | Requested — waiting at Central |
| T-shirt F7123# EXTREME CAUSE BLACK | p1788606430886 | t-shirts | 9 | R2 700 | Requested — waiting at Central |
| Diesel Jean grey :Y8171# | p1793029284138 | pants | 9 | R5 850 | Requested — waiting at Central |
| Diesel core t shirt black w555# | p1793626934092 | t-shirts | 9 | R2 700 | Requested — waiting at Central |
| Replay t shirt white w638# | p1793632803162 | t-shirts | 9 | R2 700 | Requested — waiting at Central |
| John Richmond jean blue JR01# | p1793696847961 | pants | 9 | R5 850 | Requested — waiting at Central |
| True religion jean TS25-4# | p1793703944306 | pants | 9 | R5 850 | Requested — waiting at Central |
| Armani exchange black t shirts 494# | p1793014785389 | t-shirts | 8 | R2 400 | Requested — waiting at Central |
| Diesel core t shirt cream white w555# | p1793627104999 | t-shirts | 8 | R2 400 | Requested — waiting at Central |
| Nike t shirt black 2478# | p1793018258925 | t-shirts | 7 | R2 100 | Requested — waiting at Central |
| Diesel Jean light green:Y8170# | p1793029514229 | pants | 6 | R3 900 | Requested — waiting at Central |
| Prada slidebag | p1782898926912 | bags | 4 | R1 600 | Requested — waiting at Central |
| Yishanshou black | p1785058901987 | t-shirts | 3 | R900 | Requested — waiting at Central |
| Lacoste beanie grey | p1785230051203 | caps-beanies | 3 | R450 | Requested — waiting at Central |
| Lacoste beanie green | p1785237283671 | caps-beanies | 3 | R450 | Requested — waiting at Central |
| Giavceye Jean jacket Black0061-1 | p1782299654802 | jackets | 2 | R1 160 | Requested — waiting at Central |
| Jeans brown bs-07114 | p1784724165846 | pants | 2 | R800 | Requested — waiting at Central |
| Jeans brown bs-898 | p1784726806741 | pants | 1 | R400 | Requested — waiting at Central |
| Yishanshou grey | p1785058880528 | t-shirts | 1 | R300 | Requested — waiting at Central |
| Bs-8022 green | p1785248876788 | pants | 1 | R400 | Requested — waiting at Central |
| Denim pant brown 110 | p1787829561587 | pants | 1 | R250 | Requested — waiting at Central |
| Diesel t shirt black 10# | p1793015961884 | t-shirts | 1 | R300 | Requested — waiting at Central |
| SAINT MICHAEL CHO CVT -37 GREY | p1788523243497 | t-shirts | 4 | R1 000 | Central's size is not on the product |

## Concrete — every product not listed

| Product | pid | Category | Central | Value | Reason |
|---|---|---|---:|---:|---|
| Adidas Real Madrid tracksuit white and grey | p1784818422367 | tracksuits | 15 | R9 000 | All promised to open requests |
| adidas Arsenal FC 25/26 Tiro  tracksuit two-tone blue | p1784818738721 | tracksuits | 15 | R9 000 | All promised to open requests |
| Adidas Real Madrid Tiro black tracksuit | p1784818933061 | tracksuits | 15 | R9 000 | All promised to open requests |
| Arsenal F.C tracksuit gray | p1784819553910 | tracksuits | 15 | R9 000 | All promised to open requests |
| Adidas real Madrid dark gray | p1784819669529 | tracksuits | 15 | R9 000 | All promised to open requests |
| Nike FC Barcelona Away Men's  black & purple | p1784819901479 | tracksuits | 15 | R9 000 | All promised to open requests |
| Adidas Real Madrid Tiro 25 Competition tracksuit | p1784818135986 | tracksuits | 13 | R7 800 | All promised to open requests |
| Diesel paperbag (big size) | p1791885927781 | bags | 13 | R520 | All promised to open requests |
| Diesel t shirt white 10# | p1793016643790 | t-shirts | 10 | R3 000 | All promised to open requests |
| Karl lagerfeld beanie cream white | p1782554704817 | caps-beanies | 6 | R900 | All promised to open requests |
| Karl beanie white | p1785241509331 | caps-beanies | 6 | R900 | All promised to open requests |
| Nike cap black | p1795100591281 | caps-beanies | 5 | R750 | All promised to open requests |
| Nike beanie brown | p1785239949527 | caps-beanies | 4 | R600 | All promised to open requests |
| T-shirt white DIESEL w617# | p1787739309151 | t-shirts | 4 | R1 200 | All promised to open requests |
| Diesel beanie grey | p1782565933309 | caps-beanies | 3 | R450 | All promised to open requests |
| Essential bag brown #9131 | p1784019200362 | bags | 3 | R1 500 | All promised to open requests |
| On cloud bag pink | p1784451954749 | bags | 3 | R1 200 | All promised to open requests |
| On cloud orange bag | p1784452114150 | bags | 3 | R1 050 | All promised to open requests |
| Yishanshou black | p1785058901987 | t-shirts | 3 | R900 | All promised to open requests |
| Daniel wellington watch gold end black 2 | p1786027298892 | watches | 3 | R1 797 | All promised to open requests |
| Jordan bag white FJ6784-377#S | p1787147102084 | bags | 3 | R1 350 | All promised to open requests |
| Nike t shirt black w683# | p1792839992757 | t-shirts | 3 | R900 | All promised to open requests |
| Essential bag grey #9161 | p1782895528042 | bags | 2 | R1 000 | All promised to open requests |
| Essential bag black #1 | p1782899686922 | bags | 2 | R1 000 | All promised to open requests |
| Essential bag brown #9162 | p1782904328063 | bags | 2 | R1 000 | All promised to open requests |
| Essentials bag black: #9155 | p1784018453369 | bags | 2 | R1 000 | All promised to open requests |
| Essentials bag black #9131 | p1784019551933 | bags | 2 | R1 000 | All promised to open requests |
| Essentials bag brown #9138 | p1784020005874 | bags | 2 | R1 000 | All promised to open requests |
| Alo bag Grey | p1784456092976 | bags | 2 | R800 | All promised to open requests |
| Daniel Wellington watch black & silver | p1785569953659 | watches | 2 | R1 198 | All promised to open requests |
| Daniel wellington silver with green | p1785575130374 | watches | 2 | R1 298 | All promised to open requests |
| T-shirt cream white DIESEL w617# | p1787739429011 | t-shirts | 2 | R600 | All promised to open requests |
| Ray-ban sunglasses green g-15 lens #6 | p1788009257844 | sunglasses | 2 | R900 | All promised to open requests |
| Essentials bag brew #9139 | p1784027874850 | bags | 1 | R500 | All promised to open requests |
| Nike ELITE bag black | p1784029603521 | bags | 1 | R500 | All promised to open requests |
| Jacket brown #1513 | p1784215385683 | hoodies | 1 | R400 | All promised to open requests |
| Essentially bag black 1978# | p1784459521046 | bags | 1 | R400 | All promised to open requests |
| Yishanshou grey | p1785058880528 | t-shirts | 1 | R300 | All promised to open requests |
| Bs-8022 green | p1785248876788 | pants | 1 | R400 | All promised to open requests |
| Sport under Armour tracksuits green 81344 | p1786800705938 | tracksuits | 1 | R650 | All promised to open requests |
| Golf t-shirt navy dark blue with yellow sy0135 | p1787136265175 | golf-t-shirts | 1 | R350 | All promised to open requests |
| T-shirt black DIESEL w617# | p1787739199477 | t-shirts | 1 | R300 | All promised to open requests |
| Suit jacket cream white J47 NAKAMAJLANG | p1787930788596 | suits | 1 | R999 | All promised to open requests |
| Golf t shirt white 4308# | p1788774323461 | golf-t-shirts | 1 | R300 | All promised to open requests |
| 130 | p1789217261265 | t-shirts | 1 | R300 | All promised to open requests |
| Jie jiu pants 5355 | p1790852257554 | pants | 1 | R400 | All promised to open requests |
| G star raw cargo jeans FD3554# | p1792139640897 | pants | 1 | R650 | All promised to open requests |
| Nike T shirt white w683# | p1792839552811 | t-shirts | 1 | R300 | All promised to open requests |
| Timberland beanie teal blue | p1793369004416 | caps-beanies | 1 | R150 | All promised to open requests |
| GaLLERY DEPT  T SHIRT  cover-18 | p1789216086077 | t-shirts | 2 | R500 | At both Pine and Concrete |
| Ray-ban sunglasses black g-15 lens #1 | p1788005561901 | sunglasses | 28 | R12 600 | No policy |
| p1781428112499 | p1781428112499 | — | 81 | R0 | No product record |
| p1778241852919 | p1778241852919 | — | 52 | R0 | No product record |
| p1790253981910 | p1790253981910 | — | 50 | R0 | No product record |
| p1782003441156 | p1782003441156 | — | 35 | R0 | No product record |
| p1784457711948 | p1784457711948 | — | 21 | R0 | No product record |
| p1791288459752 | p1791288459752 | — | 17 | R0 | No product record |
| p1779174775683 | p1779174775683 | — | 15 | R0 | No product record |
| p1784642971106 | p1784642971106 | — | 11 | R0 | No product record |
| p1787484091247 | p1787484091247 | — | 11 | R0 | No product record |
| p1787484381601 | p1787484381601 | — | 10 | R0 | No product record |
| p1787925551485 | p1787925551485 | — | 10 | R0 | No product record |
| p1788269774581 | p1788269774581 | — | 10 | R0 | No product record |
| p1784718316655 | p1784718316655 | — | 8 | R0 | No product record |
| p1791628860039 | p1791628860039 | — | 8 | R0 | No product record |
| p1786609354490 | p1786609354490 | — | 3 | R0 | No product record |
| p1777979644761 | p1777979644761 | — | 2 | R0 | No product record |
| p1783251345522 | p1783251345522 | — | 1 | R0 | No product record |
| p1784536687135 | p1784536687135 | — | 1 | R0 | No product record |
| p1785936389183 | p1785936389183 | — | 1 | R0 | No product record |
| DOLCE & GABBANA BLACK END WHITE | p1785323517678 | Sneakers | 1 | R1 099 | Central has none of the sizes it needs |
| D&G king 100ML | p1784882828664 | perfumes | 22 | R6 600 | Shop paused, empty rows |
| SAINT MICHAEL CHO CVT -37 GREY | p1788523243497 | t-shirts | 4 | R1 000 | Shop paused, empty rows |
| Karl lagerfeld paperbag (medium size) | p1791882788043 | bags | 906 | R36 240 | Requested — waiting at Central |
| Boss paperbag  ( small size) | p1791889951053 | bags | 409 | R16 360 | Requested — waiting at Central |
| Timberland paperbag | p1782727110237 | packaging | 363 | R14 520 | Requested — waiting at Central |
| Armani exchange paper bag (big size) | p1791885011582 | bags | 347 | R13 880 | Requested — waiting at Central |
| Lacoste short black L304# | p1795351409391 | shorts | 43 | R8 600 | Requested — waiting at Central |
| Lacoste short white L304# | p1795351784069 | shorts | 43 | R8 600 | Requested — waiting at Central |
| Lacoste short durk blue L304# | p1795352347585 | shorts | 43 | R8 600 | Requested — waiting at Central |
| Boss short black  B308# | p1795257750885 | shorts | 42 | R10 500 | Requested — waiting at Central |
| Lacoste beanie white  1 | p1789820444934 | caps-beanies | 10 | R1 500 | Requested — waiting at Central |
| Adore | p1782762651772 | perfumes | 5 | R1 000 | Requested — waiting at Central |
| On Cloudtilt White Pink Black | p1777973244588 | sneakers | 1 | R450 | Requested — waiting at Central |
| Bottega Veneta Loafer Brown | p1778239201857 | sneakers | 1 | R1 000 | Requested — waiting at Central |
| Dolce & Gabbana White Blue Denim | p1778241326974 | sneakers | 1 | R1 100 | Requested — waiting at Central |
| Birkenstock Arizona Black | p1778842869220 | slides | 1 | R400 | Requested — waiting at Central |
| Emporio Armani sneaker black | p1791214433711 | sneakers | 1 | R1 200 | Requested — waiting at Central |
| T-shirt F7169# EXTREME CAUSE BLACK | p1788602374804 | t-shirts | 12 | R3 600 | Central's size is not on the product |
| G star raw cargo jean FG3552# | p1792139078640 | pants | 5 | R3 250 | Central's size is not on the product |
| Extreme cause f7325 block | p1785056574559 | t-shirts | 4 | R1 200 | Central's size is not on the product |
| YL Bolling BS-511 | p1782377193836 | t-shirts | 3 | R900 | Central's size is not on the product |

