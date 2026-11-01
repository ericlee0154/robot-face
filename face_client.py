#!/usr/bin/env python3
"""Tiny client for the robot face server, for robot code or the command line.

In Python:
    from face_client import Face
    face = Face()                # http://127.0.0.1:8000 by default
    face.emotion("happy")
    face.look(0.5, -0.2)         # x right, y down, each -1..1
    face.blink()
    face.idle()                  # stop aiming, let the eyes wander
    face.color("#ff8800")

From the shell:
    python3 face_client.py happy
    python3 face_client.py --look 0.5 -0.2
    python3 face_client.py --blink
    python3 face_client.py --idle
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

EMOTIONS = ("neutral", "happy", "sad", "angry", "surprised", "sleepy")


class Face:
    def __init__(self, url: str = "http://127.0.0.1:8000", timeout: float = 1.0):
        self.url = url.rstrip("/") + "/api/face"
        self.timeout = timeout

    def send(self, **cmd) -> dict:
        """Send a raw command; returns the server's current face state."""
        req = urllib.request.Request(
            self.url,
            data=json.dumps(cmd).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            raise ValueError(json.load(e).get("error", str(e))) from None

    def emotion(self, name: str) -> dict:
        return self.send(emotion=name)

    def look(self, x: float, y: float) -> dict:
        return self.send(look=[x, y])

    def idle(self) -> dict:
        return self.send(look=None)

    def blink(self) -> dict:
        return self.send(blink=True)

    def color(self, hex_color: str) -> dict:
        return self.send(color=hex_color)

    def state(self) -> dict:
        with urllib.request.urlopen(self.url, timeout=self.timeout) as resp:
            return json.load(resp)


def main() -> None:
    p = argparse.ArgumentParser(description="Send a command to the robot face.")
    p.add_argument("emotion", nargs="?", choices=EMOTIONS)
    p.add_argument("--look", nargs=2, type=float, metavar=("X", "Y"), help="aim the eyes, -1..1 each")
    p.add_argument("--idle", action="store_true", help="let the eyes wander on their own")
    p.add_argument("--blink", action="store_true")
    p.add_argument("--color", help="eye color, e.g. #3cf0ff")
    p.add_argument("--url", default="http://127.0.0.1:8000")
    args = p.parse_args()

    cmd = {}
    if args.emotion:
        cmd["emotion"] = args.emotion
    if args.look:
        cmd["look"] = args.look
    if args.idle:
        cmd["look"] = None
    if args.blink:
        cmd["blink"] = True
    if args.color:
        cmd["color"] = args.color

    face = Face(args.url)
    try:
        result = face.send(**cmd) if cmd else face.state()
    except (ValueError, OSError) as e:
        sys.exit(f"error: {e}")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
