# Terminal half of the arcpi demo (VHS 0.12). Run it through docs/video/record.sh,
# which records the map beside it and ends this tape by stopping pi after the answer.
Output "video/terminal.mp4"
Require docker
Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 800
Set TypingSpeed 25ms

# record.sh creates video/.done before it stops pi; the next prompt then prints a
# marker. Killed, pi cannot restore the screen, so its last line is not the prompt.
Hide
Type `export PS1='arcpi-demo$ ' PROMPT_COMMAND='[[ -e video/.done ]] && echo "[recording finished]"' && clear`
Enter
Show

# 1. Launch the map container (it inherits the host's ./arcpi login), then pi beside it.
Type "docker compose -f compose.map.yaml up --build -d --wait mappi"
Enter
Wait@5m /arcpi-demo\$\s*$/
Type "docker compose -f compose.map.yaml run --rm --name arcpi-demo arcpi"
Enter
# pi's footer shows the session cost once it is ready for input.
Wait+Screen@2m /\$0\.000/
Sleep 2s

# 2. The question.
Type "Locate the Empire State Building in Manhattan, then locate the World Trade Center. Create a 10-minute drive-time polygon around each one of them, and if the polygons intersect, show the intersection area color-coded with hashed yellow markers. Make sure the map extent shows all added elements."
Sleep 1s
Enter

# 3. record.sh stops pi once the answer is complete; the marker ends the tape.
Wait+Screen@30m /recording finished/
Sleep 1s
