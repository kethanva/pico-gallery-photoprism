# Archived design: standalone Qt WebEngine kiosk client

> **Archive notice (2026-08-08):** Superseded proposal. The current product
> uses Cage + Cog/WPE WebKit and a minimal first-party display client. This file
> is retained only as design history and is not implementation guidance.

## Objective

Build a standalone kiosk application that reuses the existing PhotoPrism frontend without rewriting it.

The application will run on a Raspberry Pi Zero 2 W using a minimal Linux installation and Qt WebEngine. The application should behave like a dedicated photo appliance with no browser UI.

The backend will be an existing PhotoPrism server running on another machine (for example, a Raspberry Pi 4).

The objective is not to recreate PhotoPrism. The objective is to package and run the existing frontend independently while communicating with a remote backend.

⸻

Critical Requirements

This project must reuse the existing PhotoPrism frontend.

Source:

https://github.com/photoprism/photoprism/tree/develop/frontend

Do not recreate or rewrite:

* Vue components
* Pages
* Router
* Stores
* API services
* Gallery
* Viewer
* Albums
* Search
* Slideshow
* Login
* Settings
* Utilities
* Styling

The existing frontend is the application.

⸻

Overall Architecture

Raspberry Pi Zero 2 W
Minimal Linux
        │
Qt 6
        │
Qt WebEngine
        │
Fullscreen Kiosk Application
        │
Existing PhotoPrism Frontend
        │
HTTPS
        │
PhotoPrism Backend (Pi 4)

There is no backend running on the Pi Zero.

⸻

Responsibilities

The Qt application is responsible for:

* creating the application window
* loading the frontend
* fullscreen mode
* runtime configuration
* error pages
* reconnect handling
* optional splash screen
* optional watchdog
* optional automatic restart

Everything else should be handled by the existing frontend.

⸻

Frontend

Use the frontend exactly as provided by the PhotoPrism repository.

Only modify it where absolutely necessary.

Examples of acceptable changes:

* configurable API base URL
* runtime configuration loader
* CORS fixes if required
* build configuration
* standalone packaging

Avoid unnecessary changes.

⸻

Backend

Assume an existing PhotoPrism server already provides:

* authentication
* database
* thumbnails
* albums
* search
* AI
* indexing
* metadata
* photo storage
* REST API

Never implement backend functionality.

Never duplicate backend logic.

⸻

API Connection

Implement runtime configurable backend URL.

Example:

https://photos.local

Every API request should automatically use this base URL.

Do not hardcode backend addresses.

⸻

Runtime Configuration

Support loading configuration at startup from a JSON file.

Example:

{
  "serverUrl": "https://photos.local",
  "fullscreen": true,
  "ignoreCertificateErrors": false,
  "startupPage": "/library",
  "windowTitle": "Photo Frame"
}

Changing the backend should never require recompiling.

⸻

Qt Application

Create a clean C++ Qt application.

Suggested structure:

src/
main.cpp
MainWindow
ConfigManager
PhotoPrismView
SplashScreen
ErrorPage
NetworkMonitor
Settings
resources/

The application should contain minimal logic.

Most functionality belongs inside the existing frontend.

⸻

Qt WebEngine

Requirements:

* Qt 6
* QWebEngineView
* Fullscreen
* Hardware acceleration where available
* JavaScript enabled
* Local storage enabled
* Cookies enabled
* HTTP cache enabled
* Secure defaults

Disable browser features that are not needed.

No:

* address bar
* tabs
* bookmarks
* downloads UI
* browser menus
* browser history UI
* developer tools in release builds

The application should never look like a web browser.

⸻

Frontend Hosting

Serve the built PhotoPrism frontend locally on the Pi Zero.

The Qt application should load:

http://127.0.0.1:8080

or

file://

depending on which approach is most compatible with the frontend.

API requests should still go to the remote PhotoPrism backend.

⸻

Kiosk Features

Implement:

* fullscreen startup
* automatic reconnect
* loading screen
* network error page
* restart on crash
* configurable idle timeout
* automatic recovery

⸻

Raspberry Pi Optimizations

Optimize for:

* Raspberry Pi Zero 2 W
* ARM
* 512 MB RAM
* low CPU usage
* fast startup
* minimal background services

⸻

Build System

Use:

* CMake
* Qt 6
* Qt WebEngine

The project must compile on Linux.

⸻

Documentation

Provide:

* build instructions
* dependency list
* Raspberry Pi setup
* deployment guide
* configuration guide
* troubleshooting guide

⸻

Agent Instructions

Work in small, reviewable commits.

Before modifying existing frontend code:

1. Determine whether the functionality already exists.
2. Reuse existing code whenever possible.
3. Only modify code when required for standalone operation.
4. Keep patches as small as possible.
5. Document every modification.

Never replace existing PhotoPrism functionality with newly written implementations unless absolutely necessary.

⸻

Success Criteria

The project is successful when:

* the existing PhotoPrism frontend builds successfully outside of the full PhotoPrism project
* the frontend runs inside a Qt WebEngine fullscreen application
* the frontend connects to a remote PhotoPrism backend
* login works
* gallery works
* albums work
* search works
* slideshow works
* photo viewer works
* settings work
* all API communication occurs with the remote backend
* no backend code runs on the Raspberry Pi Zero
* the application behaves like a dedicated appliance rather than a browser

⸻

Non-Goals

Do not:

* rewrite the frontend
* fork the frontend architecture
* recreate Vue components
* implement backend APIs
* implement a database
* implement authentication
* implement AI
* implement indexing
* implement thumbnail generation
* duplicate PhotoPrism logic

The guiding principle is:

Reuse the existing PhotoPrism frontend with minimal modifications, encapsulate it in a Qt WebEngine kiosk application, and connect it to an existing remote PhotoPrism backend while preserving compatibility with future upstream updates.

One additional recommendation: have the agent first produce a design and compatibility report before writing code. It should inspect the frontend/ directory, identify every dependency on the Go backend or same-origin assumptions, and propose the minimal set of changes required. Only after that report is approved should it begin implementing the standalone Qt WebEngine kiosk client. This staged approach typically results in a cleaner, more maintainable solution.
