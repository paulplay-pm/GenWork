#!/usr/bin/env python3
"""
play_playlist.py

Sequential playlist player for macOS using Music.app.
Monitors playback state and auto-advances to the next song.

Behavior:
  - Asks user once before starting: "可以开始播放吗？"
  - On song finished → auto-play next song
  - On user paused  → ask "要播放下一首吗？"
  - On user not listening to anything + already agreed → auto-play next

Usage:
    python3 play_playlist.py ~/Music/minimax-gen/playlists/深夜放松/
    python3 play_playlist.py file1.mp3 file2.mp3 file3.mp3
    python3 play_playlist.py --playlist /tmp/playlist_plan.json
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


LANG = "zh"


# ---------------------------------------------------------------------------
# Music.app interaction via osascript
# ---------------------------------------------------------------------------

def _osascript(script: str) -> str:
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def music_app_state() -> dict:
    """Query Music.app for player state, position, and duration."""
    running = _osascript(
        'tell application "System Events" to (name of processes) contains "Music"'
    )
    if running != "true":
        return {"state": "not_running", "position": 0.0, "duration": 0.0}

    state_str = _osascript('tell application "Music" to player state as string')
    if not state_str:
        return {"state": "stopped", "position": 0.0, "duration": 0.0}

    if "playing" in state_str.lower():
        state = "playing"
    elif "pause" in state_str.lower():
        state = "paused"
    else:
        state = "stopped"

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


def is_idle() -> bool:
    """Check if Music.app is idle (not playing anything)."""
    info = music_app_state()
    return info["state"] in ("paused", "stopped", "not_running")


def play_file(filepath: str):
    """Open a file in Music.app and ensure playback starts."""
    subprocess.Popen(["open", str(filepath)])
    time.sleep(1.5)
    _osascript('tell application "Music" to play')


def monitor_until_done() -> str:
    """Monitor Music.app until current song ends or user pauses.

    Returns: "finished" | "paused" | "stopped"
    """
    time.sleep(1)

    was_playing = False
    last_position = -1.0
    startup_grace = 15

    while True:
        info = music_app_state()
        state = info["state"]
        pos = info["position"]
        dur = info["duration"]

        if state == "playing":
            was_playing = True
            last_position = pos

            if dur > 0 and pos >= dur - 3:
                time.sleep(3)
                info2 = music_app_state()
                if info2["state"] != "playing":
                    return "finished"

        elif state == "paused":
            if was_playing:
                if dur > 0 and pos >= dur - 3:
                    return "finished"
                if pos < 1.0 and last_position > 5.0:
                    return "finished"
                return "paused"
            else:
                startup_grace -= 1
                if startup_grace <= 0:
                    return "stopped"

        elif state in ("stopped", "not_running"):
            if was_playing:
                return "stopped"
            startup_grace -= 1
            if startup_grace <= 0:
                return "stopped"

        time.sleep(1.5)


# ---------------------------------------------------------------------------
# Playlist player
# ---------------------------------------------------------------------------

def get_duration_str(filepath: str) -> str:
    """Get human-readable duration string."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(filepath)],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            d = float(result.stdout.strip())
            return f"{int(d // 60)}:{int(d % 60):02d}"
    except (ValueError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return "?:??"


def play_playlist(files: list, auto: bool = False):
    """Play a list of files sequentially with smart state tracking."""
    total = len(files)
    print(f"🎵 Playlist: {total} songs")
    for i, f in enumerate(files, 1):
        name = Path(f).stem
        dur = get_duration_str(f)
        print(f"  {i}. {name} ({dur})")

    # Ask user once before starting (skip in auto mode)
    if not auto:
        print("▶️  Start playback? [Y/n] ", end="", flush=True)
        answer = input().strip().lower()
        if answer not in ("y", "yes", "", "是", "好", "ok"):
            print("❌ Playback cancelled.")
            print(json.dumps({"action": "cancelled", "played": 0, "total": total}))
            return

    auto_advance = True  # User agreed to play, auto-advance by default

    for i, filepath in enumerate(files):
        song_num = i + 1
        name = Path(filepath).stem
        dur = get_duration_str(filepath)

        print(f"\n🎵 [{song_num}/{total}] {name} ({dur})")

        # Play the file
        play_file(filepath)
        print("▶️  Now playing...")

        # Monitor until done
        status = monitor_until_done()

        if status == "finished":
            print("✅ Song finished.")
            # Auto-advance to next (user didn't intervene)
            auto_advance = True

        elif status == "paused":
            print("⏸️  Song paused.")
            if song_num < total:
                if not auto:
                    print("▶️  Play next? [Y/n] ", end="", flush=True)
                    answer = input().strip().lower()
                    if answer not in ("y", "yes", "", "是", "好", "ok"):
                        print(f"🎵 Playlist ended. Played {song_num}/{total}.")
                        print(json.dumps({
                            "action": "stopped_by_user",
                            "played": song_num,
                            "total": total,
                            "stopped_at": song_num,
                        }))
                        return
                auto_advance = True

        elif status == "stopped":
            print("⏹️  Player stopped.")
            if song_num < total:
                if not auto:
                    print("▶️  Continue to next? [Y/n] ", end="", flush=True)
                    answer = input().strip().lower()
                    if answer not in ("y", "yes", "", "是", "好", "ok"):
                        print(f"🎵 Playlist ended. Played {song_num}/{total}.")
                        print(json.dumps({
                            "action": "stopped_by_user",
                            "played": song_num,
                            "total": total,
                            "stopped_at": song_num,
                        }))
                        return
                auto_advance = True

    # All songs played
    print(f"🎉 Playlist complete! {total} songs played.")
    print(json.dumps({"action": "completed", "played": total, "total": total}))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Sequential playlist player")
    parser.add_argument("files", nargs="*", help="MP3 files or playlist directory")
    parser.add_argument("--playlist", default=None,
                        help="Path to playlist_plan.json")
    parser.add_argument("--lang", default="zh", choices=["zh", "en"],
                        help="UI language")
    parser.add_argument("--auto", action="store_true",
                        help="Non-interactive mode: auto-confirm all prompts")
    args = parser.parse_args()

    global LANG
    LANG = args.lang

    files = []

    if args.playlist:
        # Read from playlist plan JSON
        with open(args.playlist, "r") as f:
            plan = json.load(f)
        playlist_name = plan.get("playlist_name", "playlist")
        base_dir = os.path.expanduser(
            f"~/Music/minimax-gen/playlists/{playlist_name}"
        )
        for song in plan.get("songs", []):
            fp = os.path.join(base_dir, song["filename"])
            if os.path.exists(fp):
                files.append(fp)
            else:
                print(f"⚠️  File missing, skipping: {fp}", file=sys.stderr)

    elif args.files:
        for f in args.files:
            p = Path(f).expanduser()
            if p.is_dir():
                # Directory: play all mp3s sorted by name
                files.extend(
                    sorted(str(x) for x in p.glob("*.mp3"))
                )
            elif p.exists():
                files.append(str(p))
            else:
                print(f"⚠️  File missing, skipping: {f}", file=sys.stderr)

    if not files:
        print("❌ No playable files found.")
        sys.exit(1)

    play_playlist(files, auto=args.auto)


if __name__ == "__main__":
    main()
