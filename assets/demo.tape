# Output file paths
Output assets/sentinel-demo.gif
Output assets/sentinel-demo.mp4

# Terminal window styling
Set FontSize 15
Set Width 900
Set Height 520
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 40ms

# Pause before typing starts
Sleep 500ms

# Type the 1-command demo into the terminal
Type "docker run --rm -it ghcr.io/asctttt/sentinel-mcp:demo"
Enter

# Wait long enough for all 3 scenarios (allowed, blocked, halted) to finish playing out
Sleep 14s

# Pause on the final success screen so people can read it
Sleep 3s