# Robot Face

A robot face for a Jetson Orin Nano, displayed on an LG G8X: glowing eyes on a black background.

- **Jetson** runs `server.py` (Python standard library only, nothing to install). It serves the web page and pushes face commands over WebSocket.
- **Phone** opens the page in Chrome. All animation (blinking, eye movement, expression changes, idle glances) runs on the phone.

## Files

| File | Purpose |
|---|---|
| `server.py` | Web + WebSocket server, port 8000 by default |
| `face_client.py` | Python client for robot code; also usable from the command line |
| `start_usb.sh` | Connects the phone over USB with `adb reverse` and opens the page |
| `web/index.html`, `web/face.js` | The face (drawn on a canvas) |
| `web/control.html` | Test control panel: `http://<jetson>:8000/control` |

## Quick start

```bash
python3 server.py
```

### Option A: USB (recommended)

1. On the phone: Settings → About phone → Software info → tap "Build number" 7 times to enable Developer options.
2. In Developer options, turn on **USB debugging**. Turning on **Stay awake** (screen stays on while charging) is also recommended.
3. Install adb on the Jetson: `sudo apt install adb`
4. Plug in the USB cable and run:
   ```bash
   ./start_usb.sh
   ```
   The first time, the phone asks to "Allow USB debugging"; tap Allow. The script opens `http://localhost:8000/` in Chrome and reconnects automatically if the phone is unplugged and plugged back in.

### Option B: WiFi

With the phone and Jetson on the same network, open the URL that `server.py` prints at startup on the phone, e.g. `http://192.168.50.54:8000/`.

> Note: Screen Wake Lock and installing the page as a fullscreen app require a secure context (`localhost` or HTTPS). Over a plain-http WiFi address neither works, so use the "Stay awake" developer option instead. This is another reason to prefer USB.

### Fullscreen

- Tap the face to go fullscreen and request a screen wake lock.
- Better: Chrome menu → "Add to Home screen" / "Install app". Opening it from the home-screen icon gives fullscreen landscape with no address bar.
- If that still isn't reliable enough, use a kiosk browser such as Fully Kiosk Browser.

## Controlling it from robot code

```python
from face_client import Face

face = Face()               # defaults to http://127.0.0.1:8000
face.emotion("happy")       # neutral, happy, sad, angry, surprised, sleepy
face.look(0.5, -0.2)        # x right, y down, each -1..1
face.blink()
face.idle()                 # stop aiming; let the eyes wander on their own
face.color("#ff8800")
```

Command line:

```bash
python3 face_client.py happy
python3 face_client.py --look 0.5 -0.2
python3 face_client.py --blink
python3 face_client.py --idle
python3 face_client.py            # print current state
```

Or plain HTTP:

```bash
curl -X POST localhost:8000/api/face -d '{"emotion":"surprised","blink":true}'
```

## Protocol

JSON sent to `POST /api/face` or over the WebSocket at `/ws`. Every field is optional, but at least one is required:

| Field | Meaning |
|---|---|
| `emotion` | `neutral` `happy` `sad` `angry` `surprised` `sleepy` |
| `look` | `[x, y]`, each -1..1; `null` returns to idle wandering |
| `blink` | `true` to blink once |
| `color` | Eye color as `#rrggbb` |

A newly connected screen first receives the full current state, so the expression survives a page reload or reconnect.

## Tuning the look

Expression parameters live in `EMOTIONS` at the top of `web/face.js`:

- `w`, `h`: eye width / height multipliers
- `topIn`, `topOut`: how much the upper lid covers at the inner / outer edge (0–1); different values tilt the lid (angry, sad)
- `bottom`: a curve pushing up from below (happy squint)

To add an expression, add an entry to `EMOTIONS` and add its name to `EMOTIONS` in `server.py`.

## OLED note

The G8X has an OLED screen, so pure-black pixels are fully off and the eyes appear to float. The face constantly drifts, "breathes" and blinks to reduce burn-in, but it's still worth giving the screen a rest now and then if it runs for long periods.

## Start on boot (optional)

`~/.config/systemd/user/robotface.service`:

```ini
[Unit]
Description=Robot face server

[Service]
WorkingDirectory=%h/wkspaces/robotface
ExecStart=/usr/bin/python3 server.py
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now robotface
sudo loginctl enable-linger $USER   # start without logging in
```
