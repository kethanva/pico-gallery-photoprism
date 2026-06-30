# PicoGallery V2 — Pi Zero 2 W Optimized Client Features Backlog

This backlog outlines the **top 20 lightweight, memory-optimized, and CPU-efficient features** designed specifically for running the PicoGallery browser client on resource-constrained hardware like the **Raspberry Pi Zero 2 W** (512MB RAM, shared GPU, underclocked quad-core CPU). 

Rather than proposing resource-heavy widgets, these features focus on **reducing RAM overhead, preventing Out-Of-Memory (OOM) browser crashes, minimizing CPU wakeups, and offloading processing to the GPU compostior.**

---

## 1. Memory (RAM) Optimization & OOM Prevention

### 1. Active DOM Detachment (Texture Garbage Collection)
* **Description:** Explicitly detach the inactive image layer from the DOM tree once a transition completes, rather than just setting `src = ''`.
* **Implementation:** Use `stage.removeChild()` on the inactive image container. This forces Chromium to completely destroy the GPU texture mapping and run the V8 garbage collector immediately.
* **Why it matters for Pi Zero 2 W:** With only 512MB RAM, keeping hidden image elements or empty `<img>` tags in the DOM can cause GPU memory leaks, leading to Chromium kiosk page crashes.
* **Complexity:** Low

### 2. Native HTTP Image Cache Fallback
* **Description:** Leverage the browser's native HTTP cache for offline/resilient playback rather than building JS-based storage engines like `IndexedDB` or a Service Worker cache.
* **Implementation:** The server returns `Cache-Control: public, max-age=31536000, immutable` for images. The client relies on standard browser file requests, allowing Chromium's native C++ cache layer to handle disk/RAM retrieval with zero JS overhead.
* **Why it matters for Pi Zero 2 W:** Storing image buffers in JavaScript memory (`Blob`, `ArrayBuffer`, or `IndexedDB`) inflates the V8 heap and easily triggers OOM crashes.
* **Complexity:** Low

### 3. Screen-Resolution Matching Query
* **Description:** Automatically detect the physical hardware resolution in the client and request the exact size from the server.
* **Implementation:** Query `window.screen.width` and `window.screen.height` in JavaScript and append them as query parameters `?w=1920&h=1080` to the photo URL.
* **Why it matters for Pi Zero 2 W:** Prevents the client from downloading oversized images (e.g., 4K or original resolution) and having to scale them down in browser memory, which spikes RAM and CPU usage.
* **Complexity:** Low

---

## 2. CPU Cycle Reduction & Power Savings

### 4. GPU-Composited Ken Burns Effect (CSS 3D Transforms)
* **Description:** Replace JavaScript-based Ken Burns rendering loops (`requestAnimationFrame` checking every 16ms) with an optimized, hardware-accelerated CSS animation.
* **Implementation:** Use CSS keyframes with `transform: translate3d(...) scale(...)`. By using `translate3d` instead of `translate`, we force the browser to composite the layer on the GPU.
* **Why it matters for Pi Zero 2 W:** Reduces CPU utilization from ~20% during transitions down to < 2%, keeping the device cool and avoiding thermal throttling.
* **Complexity:** Low

### 5. Debounced Clock UI Updates
* **Description:** Restrict clock updates to exactly once per minute rather than using standard 1-second interval timers.
* **Implementation:** Compute the milliseconds remaining until the next minute boundary and set a single timeout, then schedule an update interval of `60_000` ms.
* **Why it matters for Pi Zero 2 W:** Eliminates 59 unnecessary CPU wakeups and DOM layouts per minute, allowing the CPU to enter low-power sleep states when showing a static slide.
* **Complexity:** Low

### 6. Clock Element Wake/Sleep State
* **Description:** Automatically disable and clear clock update intervals when the display is scheduled "off" or night-mode dimming turns off the clock display.
* **Implementation:** Clear the interval timer in `setConfig()` if `showClock` evaluates to `false`, and restore it only when visible.
* **Why it matters for Pi Zero 2 W:** Eliminates background timers running in the background when the display is hidden or asleep.
* **Complexity:** Low

### 7. Compositions-Only CSS Night Dimming
* **Description:** Implement night mode dimming via a cheap overlay layer rather than applying CSS graphical filters.
* **Implementation:** Avoid applying `filter: brightness() sepia()` on the `#stage` container (which forces browser repaint cycles across the entire viewport). Instead, draw a fixed, full-screen `div` overlay with `pointer-events: none` and adjust its background `rgba(r, g, b, alpha)` to tint the screen.
* **Why it matters for Pi Zero 2 W:** CSS filters require heavy CPU/GPU rendering resources. A simple transparent colored div is rendered via cheap hardware alpha-blending.
* **Complexity:** Low

### 8. Strict "Instant Cut" Mode
* **Description:** A configuration option to completely bypass transition animations.
* **Implementation:** Instantly toggle opacity (`entering.style.opacity = '1'`, `leaving.style.opacity = '0'`) without registering transition handlers.
* **Why it matters for Pi Zero 2 W:** Reduces transition CPU spikes to absolute zero, which is ideal if running other background services on the Pi Zero.
* **Complexity:** Low

---

## 3. Rendering Engine & CSS Optimization

### 9. Composite Containment (`contain: strict`)
* **Description:** Tell the browser layout engine that the stage layout is isolated from the rest of the document.
* **Implementation:** Apply `contain: strict;` and `content-visibility: auto;` to the `#stage` container and the OSD layout elements.
* **Why it matters for Pi Zero 2 W:** Prevents style changes in the OSD (like clock updates) from triggering recalculations or paint events on the large image layers underneath.
* **Complexity:** Low

### 10. WebP/AVIF Image Pipeline Preference
* **Description:** Request highly-compressed image formats (like WebP or AVIF) over standard JPEG to save download and decoding overhead.
* **Implementation:** Expose `image/webp,image/avif` in the preloader fetch headers, prompting the image service to return WebP/AVIF.
* **Why it matters for Pi Zero 2 W:** Smaller payloads mean less time spent on network I/O and faster, hardware-supported decoding inside the browser engine.
* **Complexity:** Low

### 11. Static Layer Hiding via CSS
* **Description:** Apply `display: none` or `visibility: hidden` to the inactive slide layers as soon as transitions end.
* **Implementation:** Toggle a CSS class in `swapLayers()` that applies `display: none` to the inactive layer.
* **Why it matters for Pi Zero 2 W:** Ensures the browser does not spend rendering cycles evaluating layout positions or drawing calculations for hidden elements.
* **Complexity:** Low

---

## 4. Network & Connection Efficiency

### 12. Lightweight SSE Heartbeat Throttling
* **Description:** Throttle the Server-Sent Events (SSE) keep-alive messages to occur once every 30 or 60 seconds, rather than high-frequency pings.
* **Implementation:** Configure the Fastify SSE plugin or heartbeat timers on the server to dispatch keep-alives at a lower frequency.
* **Why it matters for Pi Zero 2 W:** Minimizes TCP network stack interrupts on the Pi Zero's low-power Wi-Fi chip, saving system interrupts and power.
* **Complexity:** Low

### 13. Double-Buffered Preload Serialization
* **Description:** Restrict the client to downloading/preloading only one photo at a time.
* **Implementation:** Ensure the next image request is only fired when the previous transition completes and the stage is idle.
* **Why it matters for Pi Zero 2 W:** Downloading multiple images simultaneously will exhaust the Pi Zero's memory pool and network bandwidth, leading to transition stutters.
* **Complexity:** Low

### 14. Passive Event Listeners for Touch Gestures
* **Description:** Implement touch navigation features with passive event listeners.
* **Implementation:** Register event listeners with the `{ passive: true }` option:
  ```typescript
  element.addEventListener('touchstart', handler, { passive: true });
  ```
* **Why it matters for Pi Zero 2 W:** Tells the browser that the scroll/touch events will not call `preventDefault()`, allowing the compositor to animate gestures immediately without waiting for JavaScript execution.
* **Complexity:** Low

---

## 5. System Health & Resiliency

### 15. Dynamic Render Frame-Rate Capping
* **Description:** Cap the browser rendering loop to 30 FPS instead of 60 FPS when transitions are active.
* **Implementation:** Throttle CSS animation keyframes or configure Chromium's command-line flags (`--shared-raster-workgroup-size`, `--max-gum-fps=30`) inside the kiosk startup script.
* **Why it matters for Pi Zero 2 W:** Prevents overheating and CPU thermal throttling on fanless Pi Zero mounts.
* **Complexity:** Medium

### 16. Text-Only Offline Fallback Overlay
* **Description:** Display a basic text overlay on connection drops, avoiding loading heavy graphic icons or vector assets.
* **Implementation:** The OSD overlay updates to show a simple text badge `[Disconnected]` using CSS native layout variables.
* **Why it matters for Pi Zero 2 W:** Saves network resources and memory footprint on launch.
* **Complexity:** Low

### 17. System Fonts Stack
* **Description:** Avoid importing custom fonts (e.g., Google Fonts or TTF files) and rely entirely on native system fonts.
* **Implementation:** Specify `--font-family: system-ui, sans-serif;` in `tokens.css`.
* **Why it matters for Pi Zero 2 W:** Saves font rendering layout passes and prevents the browser from downloading and parsing large binary font files.
* **Complexity:** Low

### 18. Delayed Configuration Fetching
* **Description:** Delay fetching configuration and background states on startup to prioritize image preloading.
* **Implementation:** Sequence calls in `main.ts` so the image preload begins before calling system analytics or server state endpoints.
* **Why it matters for Pi Zero 2 W:** Smooths out initial memory allocation spikes when the browser first loads.
* **Complexity:** Low

---

## 6. Server-Side Offloading (To Protect the Client)

### 19. Optional Server-Burned Metadata OSD (Burn-In)
* **Description:** Let the server render the OSD metadata text directly onto the image buffer (burn-in) before sending it to the client.
* **Implementation:** Use `sharp` text overlay features on the server to draw a clean metadata banner at the bottom of the JPEG if the client has `burnInOsd = true` configured.
* **Why it matters for Pi Zero 2 W:** Removes the need to draw, position, and composite HTML overlay layers on top of the image container in the client, making rendering a pure full-screen image blit.
* **Complexity:** Medium

### 20. Client-Side Exception Log Catcher
* **Description:** Export client console errors to the server via a lightweight API POST, rather than running console review panels locally on the client.
* **Implementation:** Override `window.onerror` and `console.error` to send a single compact JSON POST to `/api/v1/telemetry/log`.
* **Why it matters for Pi Zero 2 W:** Allows headless debugging without running debugging inspectors in the background of the Pi Zero's browser.
* **Complexity:** Low
