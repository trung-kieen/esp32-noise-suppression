.PHONY: build upload monitor clean all

# Default target
all: build upload monitor

# Build project
build:
	pio run

# Upload firmware
upload:
	pio run -t upload

# Open serial monitor
monitor:
	pio device monitor -b 115200

# Clean build files
clean:
	pio run -t clean

# Full rebuild
rebuild: clean build

# Build, upload, and monitor
flash: build upload monitor

# List connected devices
devices:
	pio device list

# Update everything
update:
	pio pkg update
	pio platform update

# Check code
check:
	pio check --verbose
