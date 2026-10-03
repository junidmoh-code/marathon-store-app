**Marathon Labels (iMac) — one-time install:** in Terminal run `curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/mac/install.sh | bash`, then sign in once in the Chrome window it opens (its own profile).
From then on that window opens at every login and prints labels with no dialog: straight over USB when it can, otherwise to the macOS default printer.
The installer makes an XP-350B print queue the default with 40 × 30 mm labels. If it says no queue was found: System Settings ▸ Printers & Scanners ▸ add the XP-350B (once only) ▸ Default printer = XP-350B.
Paper size by hand: print anything ▸ Paper Size ▸ Manage Custom Sizes ▸ 40 × 30 mm, margins 0 ▸ then `lpoptions -p <queue> -o media=Custom.40x30mm` (`lpstat -e` names the queue).
Undo: `launchctl bootout gui/$(id -u)/club.marathon.labels; rm ~/Library/LaunchAgents/club.marathon.labels.plist`.
