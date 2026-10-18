# Marathon TV — make the queue board start by itself, with the voice on

The order-queue board on the store TV speaks "Order number 12, ready for
collection". Browsers refuse to play sound until someone touches the page, and
they forget that touch every time the page opens again. That is why the voice
needed a tap, and why it went quiet later in the day.

These launchers fix it for good. They open the board **full-screen, with sound
allowed from the start**, so the voice works with **no tap, ever**. They also:

- open the board by themselves when the computer starts;
- reopen it within a few seconds if the browser crashes or is closed;
- restart it once a night at **04:30** (store shut), which is how a new version
  of the app reaches the TV. The board never reloads itself during the day.

## Which one do I install?

Install it on **the computer that is plugged into the TV with an HDMI cable**.

| The computer driving the TV is… | Install this | Folder |
|---|---|---|
| A **Windows** PC or mini PC | `Install-Startup.bat` | `windows/` |
| A **Mac** (Mac mini, MacBook) | `install-mac.sh` | `mac/` |
| A **Raspberry Pi** (or any Debian/Ubuntu PC) | `install-linux.sh` | `linux/` |

**If the TV is a smart TV / Google TV showing the board in its own built-in
browser, none of these can be installed on it** — a TV's browser cannot be
started with the "sound allowed" setting. Plug in a small computer instead: a
Raspberry Pi 5 or any old Windows
mini PC, set it to log in by itself, and install the matching launcher. Until
then, the board still re-arms on its own the first time anyone touches it, and
stays armed all day now that it no longer reloads itself while the store is
open. (Without a launcher it picks up a new app version once, between 03:00 and
05:00; after that the first touch of the morning turns the voice back on.)

## Windows

1. Copy the whole `windows` folder onto the PC, e.g. to `C:\MarathonTV\`.
2. Double-click **`Install-Startup.bat`**. The board opens full-screen.
3. Done. It opens by itself every time the PC starts.

- Section 1 TV: open `MarathonTV-Launch.ps1` in Notepad and set
  `$Section = "1"` near the top.
- To close the board: double-click **`Stop-MarathonTV.bat`** (pressing Alt+F4
  only closes it for 5 seconds — the launcher opens it again on purpose).
- Make sure Windows logs in by itself (no password at start-up), or the board
  waits at the login screen.

## Mac

Open **Terminal** on that Mac and paste:

```
curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/tv/mac/install-mac.sh | bash
```

The board opens full-screen now and at every login, and the Mac is kept from
sleeping while it is up.

- Section 1 TV: put `MARATHON_TV_SECTION=1` before `bash` at the end.
- To remove it: `launchctl bootout gui/$(id -u)/club.marathon.tv`
- Log file: `~/Library/Logs/marathon-tv.log`

## Raspberry Pi

1. Set the Pi to log in to the desktop by itself (Raspberry Pi Configuration →
   System → Auto login).
2. Open **Terminal** and paste:

```
curl -fsSL https://raw.githubusercontent.com/junidmoh-code/marathon-store-app/main/deploy/tv/linux/install-linux.sh | bash
```

- Section 1 TV: put `MARATHON_TV_SECTION=1` before `bash` at the end.
- To remove it: `systemctl --user disable --now marathon-tv`

## How do I know it worked?

- The board fills the screen with no address bar and no "touch to turn on
  voice" note in the corner.
- The address it opens ends in `?kiosk=1#tv`. In that mode the board never
  shows the voice note and speaks on the first ready order with no tap.

## For whoever maintains this

- These launchers were written and checked for syntax but **not yet run on
  real Windows, Pi or TV hardware**. On the first install, watch the board come
  up, then pull the browser's plug (close it) once to see it come back.

- All three run the same browser flags: `--kiosk
  --autoplay-policy=no-user-gesture-required --noerrdialogs
  --disable-session-crashed-bubble --disable-infobars --no-first-run`, with a
  dedicated browser profile so the board never shares a window with anyone's
  normal browsing.
- `marathon-tv.sh` is shared by the Mac and Pi installers.
- The app side: `src/components/tv/tvVoiceKeeper.js` (keeps audio unlocked),
  and `src/update/updateChecker.js` `isTvRoute` (the board is never reloaded
  from the page).
