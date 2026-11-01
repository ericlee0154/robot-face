#!/usr/bin/env python3
"""Robot face server.

Serves the face web page from ./web and relays face commands to every
connected screen over WebSocket. Python standard library only.

Commands (JSON) can arrive two ways:
  * HTTP:      POST /api/face   {"emotion": "happy"}
  * WebSocket: send the same JSON on /ws (used by the /control page)

Fields (all optional, at least one required):
  emotion  one of EMOTIONS
  style    one of STYLES ("ascii" or "classic")
  look     [x, y] in -1..1 (x right, y down), or null to go back to idle wandering
  blink    true to blink once
  color    "#rrggbb" eye color
"""

import argparse
import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import re
import socket
import struct
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent / "web"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
EMOTIONS = (
    "neutral", "happy", "sad", "angry", "surprised", "sleepy", "love",
    "wink", "dizzy", "excited", "confused", "cry", "dead", "money",
)
STYLES = ("ascii", "classic")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_BODY = 64 * 1024
HEARTBEAT_SECONDS = 15  # screens reconnect if they hear nothing for ~45 s

ROUTES = {"/": "index.html", "/control": "control.html"}

log = logging.getLogger("robotface")

# Persistent face state; sent to each screen when it connects.
state = {"emotion": "neutral", "style": "ascii", "look": None, "color": "#3cf0ff"}
clients: set[asyncio.StreamWriter] = set()


# --------------------------------------------------------------------------- commands

def apply_command(cmd: object) -> dict:
    """Validate a command, update the stored state, and return the message to broadcast."""
    if not isinstance(cmd, dict):
        raise ValueError("command must be a JSON object")
    out = {}
    if "emotion" in cmd:
        emotion = str(cmd["emotion"])
        if emotion not in EMOTIONS:
            raise ValueError(f"unknown emotion {emotion!r}; choose from {', '.join(EMOTIONS)}")
        state["emotion"] = out["emotion"] = emotion
    if "style" in cmd:
        style = str(cmd["style"])
        if style not in STYLES:
            raise ValueError(f"unknown style {style!r}; choose from {', '.join(STYLES)}")
        state["style"] = out["style"] = style
    if "look" in cmd:
        look = cmd["look"]
        if look is not None:
            try:
                x, y = (max(-1.0, min(1.0, float(v))) for v in look)
            except (TypeError, ValueError):
                raise ValueError("look must be [x, y] numbers in -1..1, or null") from None
            look = [x, y]
        state["look"] = out["look"] = look
    if "color" in cmd:
        color = str(cmd["color"])
        if not COLOR_RE.match(color):
            raise ValueError("color must look like #3cf0ff")
        state["color"] = out["color"] = color
    if cmd.get("blink"):
        out["blink"] = True
    if not out:
        raise ValueError("no recognised fields; use emotion, style, look, blink or color")
    return out


async def broadcast(msg: dict) -> None:
    frame = ws_frame(json.dumps(msg).encode())
    for writer in list(clients):
        try:
            writer.write(frame)
            await asyncio.wait_for(writer.drain(), timeout=1.0)
        except Exception:
            clients.discard(writer)
            writer.close()


async def heartbeat() -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        if clients:
            await broadcast({"ping": True})


# --------------------------------------------------------------------------- websocket

def ws_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    n = len(payload)
    if n < 126:
        header = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 1 << 16:
        header = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return header + payload


async def ws_read(reader: asyncio.StreamReader) -> tuple[bool, int, bytes]:
    b1, b2 = await reader.readexactly(2)
    fin, opcode = bool(b1 & 0x80), b1 & 0x0F
    masked, n = b2 & 0x80, b2 & 0x7F
    if n == 126:
        (n,) = struct.unpack("!H", await reader.readexactly(2))
    elif n == 127:
        (n,) = struct.unpack("!Q", await reader.readexactly(8))
    if n > MAX_BODY:
        raise ConnectionError("websocket frame too large")
    mask = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(n)
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


async def serve_ws(reader, writer, headers: dict, peer: str) -> None:
    key = headers.get("sec-websocket-key")
    if not key:
        await respond(writer, "400 Bad Request", b"missing Sec-WebSocket-Key")
        return
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    writer.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n".encode()
    )
    hello = {**state, "emotions": list(EMOTIONS), "styles": list(STYLES)}
    writer.write(ws_frame(json.dumps(hello).encode()))
    await writer.drain()
    clients.add(writer)
    log.info("screen connected: %s (%d total)", peer, len(clients))

    buf = b""
    try:
        while True:
            fin, opcode, payload = await ws_read(reader)
            if opcode == 0x8:  # close
                writer.write(ws_frame(b"", 0x8))
                break
            if opcode == 0x9:  # ping
                writer.write(ws_frame(payload, 0xA))
                continue
            if opcode not in (0x0, 0x1):
                continue
            buf += payload
            if not fin:
                continue
            text, buf = buf.decode("utf-8", "replace"), b""
            try:
                msg = apply_command(json.loads(text))
            except (ValueError, json.JSONDecodeError) as e:
                writer.write(ws_frame(json.dumps({"error": str(e)}).encode()))
                continue
            await broadcast(msg)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        clients.discard(writer)
        log.info("screen disconnected: %s (%d total)", peer, len(clients))


# --------------------------------------------------------------------------- http

async def respond(writer, status: str, body: bytes, ctype: str = "text/plain; charset=utf-8") -> None:
    writer.write(
        f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
        "Cache-Control: no-cache\r\nConnection: close\r\n\r\n".encode() + body
    )
    await writer.drain()


async def respond_json(writer, status: str, obj: object) -> None:
    await respond(writer, status, json.dumps(obj).encode(), "application/json")


async def serve_api(reader, writer, method: str, headers: dict) -> None:
    if method == "GET":
        await respond_json(writer, "200 OK", state)
        return
    if method != "POST":
        await respond_json(writer, "405 Method Not Allowed", {"error": "use GET or POST"})
        return
    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        length = -1
    if not 0 < length <= MAX_BODY:
        await respond_json(writer, "400 Bad Request", {"error": "missing or oversized JSON body"})
        return
    body = await reader.readexactly(length)
    try:
        msg = apply_command(json.loads(body))
    except (ValueError, json.JSONDecodeError) as e:
        await respond_json(writer, "400 Bad Request", {"error": str(e)})
        return
    await broadcast(msg)
    await respond_json(writer, "200 OK", state)


async def serve_static(writer, path: str) -> None:
    name = ROUTES.get(path, path.lstrip("/"))
    file = (WEB_DIR / name).resolve()
    if not file.is_relative_to(WEB_DIR) or not file.is_file():
        await respond(writer, "404 Not Found", b"not found")
        return
    ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    await respond(writer, "200 OK", file.read_bytes(), ctype)


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = "%s:%s" % writer.get_extra_info("peername")[:2]
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        path = target.split("?", 1)[0]

        if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
            await serve_ws(reader, writer, headers, peer)
        elif path == "/api/face":
            await serve_api(reader, writer, method, headers)
        elif method in ("GET", "HEAD"):
            await serve_static(writer, path)
        else:
            await respond(writer, "405 Method Not Allowed", b"method not allowed")
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError,
            ConnectionError, ValueError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def lan_ip() -> str | None:
    """Best guess at this machine's LAN address (no packets are actually sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="0.0.0.0", help="address to bind (default: all interfaces)")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    server = await asyncio.start_server(handle, args.host, args.port)
    asyncio.create_task(heartbeat())

    log.info("face:     http://localhost:%d/   (phone over USB, after start_usb.sh)", args.port)
    ip = lan_ip()
    if ip:
        log.info("face:     http://%s:%d/   (phone over WiFi)", ip, args.port)
    log.info("control:  http://localhost:%d/control", args.port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
