#!/usr/bin/env python3
"""MiniMax Music Player — Minimal single-line playback bar."""

import curses
import json
import locale
import os
import socket
import subprocess
import sys
import time

import tempfile

SOCKET_PATH = os.path.join(tempfile.gettempdir(), "mpv-minimax-ipc")


class MpvIPC:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(SOCKET_PATH)
        self.sock.settimeout(0.3)
        self._buf = ""
        self._rid = 0

    def _cmd(self, *args):
        self._rid += 1
        rid = self._rid
        try:
            self.sock.sendall(
                (json.dumps({"command": list(args), "request_id": rid}) + "\n").encode()
            )
        except Exception:
            return None
        end = time.time() + 0.4
        while time.time() < end:
            try:
                self._buf += self.sock.recv(8192).decode("utf-8", errors="replace")
            except socket.timeout:
                pass
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                try:
                    r = json.loads(line)
                    if r.get("request_id") == rid:
                        return r.get("data") if r.get("error") == "success" else None
                except (json.JSONDecodeError, KeyError):
                    continue
        return None

    def get(self, prop):
        return self._cmd("get_property", prop)

    def set(self, prop, val):
        return self._cmd("set_property", prop, val)

    def seek(self, secs):
        return self._cmd("seek", secs, "relative")

    def toggle_pause(self):
        p = self.get("pause")
        if p is not None:
            self.set("pause", not p)
            return not p
        return False

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def fmt(s):
    if not s or s < 0:
        return "0:00"
    return f"{int(s) // 60}:{int(s) % 60:02d}"


def main(stdscr, source, song_name):
    locale.setlocale(locale.LC_ALL, "")
    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(300)

    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_GREEN, -1)
    curses.init_pair(2, curses.COLOR_CYAN, -1)
    curses.init_pair(3, curses.COLOR_WHITE, -1)
    curses.init_pair(4, curses.COLOR_MAGENTA, -1)

    GREEN = curses.color_pair(1) | curses.A_BOLD
    CYAN = curses.color_pair(2) | curses.A_BOLD
    DIM = curses.color_pair(3) | curses.A_DIM
    MAG = curses.color_pair(4) | curses.A_BOLD

    # Start mpv
    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)
    proc = subprocess.Popen(
        ["mpv", "--no-video", "--really-quiet",
         f"--input-ipc-server={SOCKET_PATH}", source],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        if os.path.exists(SOCKET_PATH):
            break
        time.sleep(0.1)

    try:
        mpv = MpvIPC()
    except Exception:
        stdscr.addstr(0, 0, "Error: cannot connect to mpv")
        stdscr.refresh()
        time.sleep(2)
        proc.kill()
        return

    try:
        while proc.poll() is None:
            h, w = stdscr.getmaxyx()
            stdscr.erase()

            pos = mpv.get("time-pos") or 0
            dur = mpv.get("duration") or 0
            vol = mpv.get("volume") or 100
            paused = mpv.get("pause") or False

            # Row 0: icon + song name
            icon = "▐▐ " if paused else "▶  "
            name = song_name if len(song_name) < w - 6 else song_name[:w - 9] + "..."
            try:
                stdscr.addstr(0, 1, icon, GREEN)
                stdscr.addstr(0, 4, name, CYAN)
            except curses.error:
                pass

            # Row 1: progress bar
            time_l = fmt(pos)
            time_r = fmt(dur)
            bar_w = w - len(time_l) - len(time_r) - 5
            if bar_w > 4 and dur > 0:
                pct = min(pos / dur, 1.0)
                filled = int(bar_w * pct)
                bar = "━" * filled + "─" * (bar_w - filled)
                try:
                    stdscr.addstr(1, 1, time_l, DIM)
                    stdscr.addstr(1, len(time_l) + 2, bar, MAG)
                    stdscr.addstr(1, len(time_l) + 2 + bar_w + 1, time_r, DIM)
                except curses.error:
                    pass

            # Row 2: controls hint
            ctrl = "[space]pause  [<>]seek  [^v]vol  [q]quit"
            if len(ctrl) < w:
                try:
                    stdscr.addstr(2, 1, ctrl, DIM)
                except curses.error:
                    pass

            stdscr.refresh()

            key = stdscr.getch()
            if key in (ord("q"), ord("Q")):
                break
            elif key == ord(" "):
                mpv.toggle_pause()
            elif key == curses.KEY_RIGHT:
                mpv.seek(5)
            elif key == curses.KEY_LEFT:
                mpv.seek(-5)
            elif key == curses.KEY_UP:
                mpv.set("volume", min(150, int(vol) + 5))
            elif key == curses.KEY_DOWN:
                mpv.set("volume", max(0, int(vol) - 5))

    finally:
        mpv.close()
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
        if os.path.exists(SOCKET_PATH):
            os.remove(SOCKET_PATH)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: vinyl_player.py <file_or_url> [song_name]")
        sys.exit(1)

    source = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(source)
    curses.wrapper(main, source, name)
