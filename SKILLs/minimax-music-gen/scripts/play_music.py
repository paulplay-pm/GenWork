#!/usr/bin/env python3
"""
Cross-platform audio playback for generated music.

Supports two modes:
  1. File playback   — plays a local file with system player (macOS) or mpv
  2. Stream playback — streams from URL via system player

Usage:
  python3 play_music.py <filepath.mp3>              # play and monitor
  python3 play_music.py --url <audio_url>            # stream from URL
  python3 play_music.py --url <audio_url> --save out.mp3  # stream + save
  python3 play_music.py <filepath.mp3> --background  # background playback

Exit behavior (macOS with Music.app monitoring):
  Prints a JSON status line to stdout when playback ends:
    {"status": "finished"}  — song played to completion
    {"status": "paused"}    — user paused the song
    {"status": "stopped"}   — player stopped or closed
    {"status": "launched"}  — background mode, no monitoring
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path


LANG = "zh"


def find_player():
    """Find the best available audio player.

    On macOS, uses 'open' (launches Music.app with GUI controls).
    Other platforms: mpv > ffplay > afplay.
    """
    import platform
    if platform.system() == "Darwin":
        return {
            "name": "open",
            "cmd": ["open"],
            "description": "macOS Music.app (system default)",
        }

    players = [
        {"name": "mpv", "cmd": ["mpv", "--no-video"],
         "description": "mpv (terminal player)"},
        {"name": "ffplay", "cmd": ["ffplay", "-nodisp", "-autoexit"],
         "description": "ffplay (FFmpeg player)"},
        {"name": "afplay", "cmd": ["afplay"],
         "description": "afplay (macOS built-in)"},
    ]
    for player in players:
        if shutil.which(player["name"]):
            return player
    return None


# ---------------------------------------------------------------------------
# macOS Music.app monitoring via osascript
# ---------------------------------------------------------------------------

def _osascript(script: str) -> str:
    """Run an AppleScript and return stdout, or empty string on error."""
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def _music_app_state() -> dict:
    """Query Music.app for player state, position, and duration.

    Returns {"state": "playing"|"paused"|"stopped"|"not_running",
             "position": float, "duration": float}
    """
    # Check if Music.app process exists
    running = _osascript(
        'tell application "System Events" to (name of processes) contains "Music"'
    )
    if running != "true":
        return {"state": "not_running", "position": 0.0, "duration": 0.0}

    # Get player state
    state_str = _osascript('tell application "Music" to player state as string')
    if not state_str:
        return {"state": "stopped", "position": 0.0, "duration": 0.0}

    # Map state string
    if "playing" in state_str.lower():
        state = "playing"
    elif "pause" in state_str.lower():
        state = "paused"
    else:
        state = "stopped"

    # Get position and duration
    pos_dur = _osascript(
        'tell application "Music" to '
        '(player position as string) & "|||" & (duration of current track as string)'
    )
    position = 0.0
    duration = 0.0
    if "|||" in pos_dur:
        parts = pos_dur.split("|||")
        try:
            position = float(parts[0].replace(",", "."))
            duration = float(parts[1].replace(",", "."))
        except ValueError:
            pass

    return {"state": state, "position": position, "duration": duration}


def monitor_music_app(duration_hint: float = 0) -> str:
    """Monitor Music.app until playback ends.

    Returns:
      "finished" — song played to completion (position reached near end)
      "paused"   — user paused the song mid-playback
      "stopped"  — Music.app stopped or was closed
    """
    # Wait for Music.app to start playing
    time.sleep(1)

    was_playing = False
    last_position = -1.0
    stall_count = 0
    startup_grace = 15  # seconds to wait for playback to begin

    while True:
        info = _music_app_state()
        state = info["state"]
        pos = info["position"]
        dur = info["duration"] or duration_hint

        if state == "playing":
            was_playing = True
            stall_count = 0
            last_position = pos

            # Check if near the end (within 3 seconds)
            if dur > 0 and pos >= dur - 3:
                time.sleep(3)
                # Confirm it actually finished
                info2 = _music_app_state()
                if info2["state"] != "playing":
                    return "finished"

        elif state == "paused":
            if was_playing:
                # User paused, or song finished (Music.app pauses at end)
                if dur > 0 and pos >= dur - 3:
                    return "finished"
                if pos < 1.0 and last_position > 5.0:
                    # Position reset to 0 = song ended
                    return "finished"
                return "paused"
            else:
                # Still in startup phase — Music.app might not have started yet
                stall_count += 1
                if stall_count > startup_grace:
                    return "stopped"

        elif state in ("stopped", "not_running"):
            if was_playing:
                return "stopped"
            stall_count += 1
            if stall_count > startup_grace:
                return "stopped"

        time.sleep(1.5)


def play_with_open(filepath, background=False):
    """Play with macOS 'open' — launches system default player with GUI."""
    subprocess.Popen(["open", str(filepath)])
    # Give Music.app time to load the file
    time.sleep(1.5)
    # Ensure playback starts (Music.app may open paused if it was paused before)
    _osascript('tell application "Music" to play')
    return 0


def play_with_mpv(filepath, background=False):
    """Play with mpv — the best experience."""
    cmd = [
        "mpv",
        "--no-video",
        "--term-osd-bar",
        "--msg-level=all=error,statusline=status",
        str(filepath),
    ]
    if background:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0
    return subprocess.call(cmd)


def play_with_ffplay(filepath, background=False):
    """Play with ffplay."""
    cmd = ["ffplay", "-nodisp", "-autoexit", str(filepath)]
    if background:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0
    return subprocess.call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def play_with_afplay(filepath, background=False):
    """Play with afplay (macOS)."""
    cmd = ["afplay", str(filepath)]
    if background:
        subprocess.Popen(cmd)
        return 0
    return subprocess.call(cmd)


def play_with_fallback(filepath):
    """Try sox/play as a last resort."""
    if shutil.which("play"):
        return subprocess.call(["play", str(filepath)])
    return -1


def get_duration_ffprobe(filepath):
    """Get audio duration using ffprobe if available."""
    if not shutil.which("ffprobe"):
        return None
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(filepath)],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        pass
    return None


def stream_from_url(url, save_path=None):
    """Stream audio from URL using macOS system player.

    Opens the URL with `open` so the system player handles playback.
    Optionally saves the file to save_path in the background.
    """
    print("▶️  Opening player...")

    # Start background download if save_path given
    if save_path:
        save_path = Path(save_path).expanduser()
        save_path.parent.mkdir(parents=True, exist_ok=True)

        def download():
            try:
                urllib.request.urlretrieve(url, str(save_path))
                print(f"💾 Saved to: {save_path}")
            except Exception as e:
                print(f"❌ Download failed: {e}", file=sys.stderr)

        t = threading.Thread(target=download, daemon=True)
        t.start()

    # Open with system player
    subprocess.Popen(["open", url])

    return 0


def main():
    parser = argparse.ArgumentParser(description="Play generated music")
    parser.add_argument("filepath", nargs="?", default=None, help="Path to audio file")
    parser.add_argument("--url", default=None, help="Stream audio from URL via mpv")
    parser.add_argument("--save", default=None, help="Save streamed audio to this path")
    parser.add_argument("--background", action="store_true", help="Play in background")
    parser.add_argument("--lang", default="zh", choices=["zh", "en"], help="UI language")
    args = parser.parse_args()

    global LANG
    LANG = args.lang

    # Stream mode
    if args.url:
        return stream_from_url(args.url, args.save)

    # File mode
    if not args.filepath:
        parser.error("Please provide a file path or --url")

    filepath = Path(args.filepath).expanduser()

    if not filepath.exists():
        print(f"❌ File not found: {filepath}")
        sys.exit(1)

    if not filepath.suffix.lower() in (".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"):
        print(f"⚠️  Unsupported format: {filepath.suffix}")

    # File info
    size_kb = filepath.stat().st_size // 1024
    duration = get_duration_ffprobe(filepath)
    duration_str = f"{int(duration // 60)}:{int(duration % 60):02d}" if duration else "unknown"

    print(f"🎵 {filepath.name}")
    print(f"   Size: {size_kb} KB | Duration: {duration_str}")

    # Find player
    player = find_player()
    if not player:
        print("❌ No audio player found.")
        print("   Install one of: mpv, ffplay, afplay")
        print("   macOS:  brew install mpv")
        print("   Ubuntu: sudo apt install mpv")
        print("   Arch:   sudo pacman -S mpv")
        print(f"\nFile saved at: {filepath}")
        sys.exit(1)

    print(f"▶️  Using: {player['description']}")
    print()

    # Play
    if player["name"] == "open":
        play_with_open(filepath)
        if args.background:
            status = "launched"
        else:
            # Monitor Music.app until playback ends
            status = monitor_music_app(duration or 0)
    elif player["name"] == "mpv":
        rc = play_with_mpv(filepath, args.background)
        status = "launched" if args.background else ("finished" if rc == 0 else "stopped")
    elif player["name"] == "ffplay":
        rc = play_with_ffplay(filepath, args.background)
        status = "launched" if args.background else ("finished" if rc == 0 else "stopped")
    elif player["name"] == "afplay":
        rc = play_with_afplay(filepath, args.background)
        status = "launched" if args.background else ("finished" if rc == 0 else "stopped")
    else:
        rc = play_with_fallback(filepath)
        status = "finished" if rc == 0 else "stopped"

    # Output status as JSON for callers to parse
    status_json = json.dumps({"status": status})

    if status == "launched":
        print("▶️  Playing in background...")
    elif status == "finished":
        print("✅ Playback finished.")
    elif status == "paused":
        print("⏸️  Paused by user.")
    else:
        print("⏹️  Playback stopped.")

    print(status_json)
    return 0 if status in ("finished", "launched") else 1


if __name__ == "__main__":
    main()
