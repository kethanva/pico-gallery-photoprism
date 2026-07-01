# Raspberry Pi Zero Installation Guide

This guide provides end-to-end instructions for installing **PicoGallery V2** from scratch on a Raspberry Pi Zero.

> [!WARNING]
> **Hardware Recommendation:** We strongly recommend the **Raspberry Pi Zero 2 W** running a **64-bit OS**. Modern Node.js versions (≥ 22.13) and the Debian packages required for the kiosk (`cog`, `cage`) require 64-bit support. The original Pi Zero 1 (W) is 32-bit only; if you must use it, it can only act as a "Kiosk-only" client display connecting to a server hosted on a different, more powerful machine.

---

## 1. Flash the Operating System

1. Download and open the [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
2. **Choose OS:** Select `Raspberry Pi OS (Other)` -> **`Raspberry Pi OS Lite (64-bit)`** (no desktop environment is needed).
3. **Choose Storage:** Select your microSD card (16GB minimum recommended).
4. **Advanced Settings (Gear Icon):**
   - **Set hostname:** e.g., `picogallery.local`
   - **Enable SSH:** Use password authentication or provide your public SSH key.
   - **Configure wireless LAN:** Enter your WiFi network SSID and password.
   - **Set locale settings:** Select your correct time zone.
5. Write the image, insert the SD card into your Pi Zero 2 W, and power it on.

---

## 2. Connect and Prepare the System

SSH into your Pi from your terminal:
```bash
ssh pi@picogallery.local
```

Update the system packages and install Git:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl
```

---

## 3. Install PicoGallery V2

You can install PicoGallery V2 either using a pre-built release artifact (recommended, faster, saves RAM/CPU on Pi Zeros) or compile it from source.

### Option A: Pre-built Release Artifact (Recommended)

1. Create the installation directory:
   ```bash
   sudo mkdir -p /opt/picogallery
   sudo chown -R $USER:$USER /opt/picogallery
   cd /opt/picogallery
   ```

2. Download and extract the latest release artifact from GitHub:
   ```bash
   curl -sSLO https://github.com/kethanva/pico-gallery-photoprism/releases/latest/download/picogallery-release.tar.gz
   tar -xzf picogallery-release.tar.gz
   rm picogallery-release.tar.gz
   ```

3. If running the server locally, install Node.js v22 (the pre-built release package includes all dependencies, so `pnpm` is not required):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

4. Now proceed to configuration and running the installer. The installer will automatically detect the pre-built assets and skip the heavy compilation phase.

---

### Option B: From Source (For Developers)

Use this method if you want to run from a live git checkout and compile files locally.

1. Clone the repository:
   ```bash
   sudo mkdir -p /opt/picogallery
   sudo chown -R $USER:$USER /opt/picogallery
   git clone https://github.com/kethanva/pico-gallery-photoprism.git /opt/picogallery
   cd /opt/picogallery
   ```

2. Install Node.js v22 and `pnpm`:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   sudo npm install -g pnpm
   ```

3. Install workspace dependencies and compile:
   ```bash
   pnpm install
   pnpm build
   ```

---

## 5. Configure the Server

Create the configuration directory and file:
```bash
sudo mkdir -p /etc/picogallery
sudo cp config.sample.toml /etc/picogallery/config.toml
```

Edit the configuration file:
```bash
sudo nano /etc/picogallery/config.toml
```

Configure the server settings and PhotoPrism/WebDAV sources:
```toml
[http]
port = 8188
host = "0.0.0.0"

[cache]
dir = "/var/cache/picogallery"

[[sources]]
name     = "photoprism"
enabled  = true
url      = "http://192.168.68.71:2342"
username = "admin"
password = "please-change"
```

---

## 6. Install the Wayland Kiosk

PicoGallery includes an automated installer for Raspberry Pi that provisions the **Cog (WPE WebKit)** browser and **Cage** Wayland compositor. It configures the display environment directly on top of DRM/KMS without an X11 desktop, ensuring maximum performance.

Run the installer based on your setup:

### Option A: Standalone Setup (Server runs on the Pi)
This installs the kiosk and creates a systemd service for the local server.
```bash
sudo ./install.sh --with-server http://localhost:8188
```

### Option B: Display Only (Server runs elsewhere)
Point the kiosk to the IP of the machine hosting the server (e.g. `192.168.1.100`).
```bash
sudo ./install.sh http://192.168.1.100:8188
```

### Display Sleep Schedule
You can optionally configure the display to turn off at night to save power:
```bash
sudo ./install.sh --with-server --blank-off="08:00" --blank-on="23:00" http://localhost:8188
```
*(In this example, the screen turns off at 23:00 and turns back on at 08:00).*

---

## 7. Service Management & Troubleshooting

After installation, the kiosk (and server, if enabled) will start automatically on boot. 

**Useful Commands:**

```bash
# Check kiosk logs for rendering or connection issues
journalctl -u picogallery-kiosk -f

# Check server logs
journalctl -u picogallery-server -f

# Restart the display kiosk
sudo systemctl restart picogallery-kiosk
```

### Changing the Kiosk URL or Timeout
If you need to change the server IP the kiosk connects to, or adjust the boot wait-timeout:
```bash
sudo nano /etc/picogallery/kiosk.env
```
Apply changes by restarting the service:
```bash
sudo systemctl restart picogallery-kiosk
```
