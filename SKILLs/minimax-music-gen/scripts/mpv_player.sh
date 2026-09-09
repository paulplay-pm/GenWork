#!/bin/bash
# MiniMax Music Player — Terminal player with cava visualizer
# Usage: mpv_player.sh <file_or_url> [song_name]

SOURCE="$1"
SONG_NAME="${2:-Unknown}"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

clear

# Header
echo ""
echo -e "${GREEN}  ╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}  ║${RESET}${BOLD}          🎵 MiniMax Music Player 🎵              ${RESET}${GREEN}║${RESET}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${CYAN}♪${RESET} 正在播放: ${BOLD}${SONG_NAME}${RESET}"
echo ""
echo -e "  ${GREEN}━━━━━━━━━━━━━ 控制键 ━━━━━━━━━━━━━${RESET}"
echo -e "  ${YELLOW}⏹  q${RESET}        退出播放"
echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Create temporary cava config
CAVA_CONFIG=$(mktemp)
cat > "$CAVA_CONFIG" << 'CAVAEOF'
[general]
bars = 0
framerate = 60
sensitivity = 120
bar_spacing = 1

[input]
method = portaudio
source = auto

[output]
method = ncurses
channels = stereo

[color]
gradient = 1
gradient_count = 4
gradient_color_1 = '#00ff88'
gradient_color_2 = '#00ccff'
gradient_color_3 = '#aa55ff'
gradient_color_4 = '#ff55aa'

[smoothing]
integral = 77
monstercat = 1
waves = 0
gravity = 80
CAVAEOF

cleanup() {
    rm -f "$CAVA_CONFIG"
    # Kill mpv when cava exits
    if [ -n "$MPV_PID" ]; then
        kill "$MPV_PID" 2>/dev/null
    fi
}
trap cleanup EXIT

# Start mpv in background
mpv --no-video --really-quiet "$SOURCE" &
MPV_PID=$!

# Small delay for audio to start
sleep 0.5

# Run cava visualizer in foreground
if command -v cava &>/dev/null; then
    cava -p "$CAVA_CONFIG"
else
    # Fallback: just wait for mpv
    echo -e "${DIM}  (cava 未安装，仅播放音频)${RESET}"
    wait $MPV_PID
fi
