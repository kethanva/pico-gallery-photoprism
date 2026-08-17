# Top 20 Optimized Client-Side Features for Raspberry Pi Zero 2

> **Archive notice (2026-08-08):** Research input, not committed scope. Promote
> accepted requirements into root `spec.md` and track work in root `plan.md`.

The Raspberry Pi Zero 2 W features a quad-core 1GHz processor and 512MB of RAM. While significantly faster than the original Pi Zero, it remains heavily constrained by its memory limit and basic GPU. For a PhotoPrism client to run smoothly on this hardware (especially in a browser kiosk mode), the client-side code must aggressively prioritize memory management, DOM minimization, and GPU offloading.

Here are the top 20 features and architectural decisions to implement in the PicoGallery client specifically for the Raspberry Pi Zero 2:

## 1. DOM & Rendering Optimization
1. **Aggressive Virtualization (Windowing):** Implement a virtualized list or grid (e.g., using `virtua` or `@tanstack/react-virtual`). The DOM should never contain more than 50-100 `<img>` nodes at any given time, regardless of the library size (12k+ photos).
2. **CSS `content-visibility: auto`:** Apply CSS containment to off-screen elements. This tells the browser engine to skip layout and painting for grid items not currently in the viewport.
3. **Canvas-Based Rendering for Mini-Maps/Scrubbers:** If implementing a fast-scroll scrubber, render it using a single `<canvas>` element rather than thousands of DOM nodes to save memory.
4. **Disable CSS `backdrop-filter` (Glassmorphism):** Real-time blur effects destroy low-end GPU performance. Use solid, opaque background colors for modals, overlays, and headers.
5. **Opaque UI Elements:** Avoid CSS `opacity` or `rgba` where possible to reduce the compositing workload on the Pi's display server.
6. **Hardware-Accelerated Transitions:** Limit all CSS animations to `transform` and `opacity` properties (e.g., `transform: translate3d(...)`) to ensure they run on the GPU rather than blocking the CPU.

## 2. Image Loading & Memory Management
7. **Strict Resolution Matching:** Never load an image larger than the CSS pixel dimensions of its container. The client must intelligently request the exact thumbnail size (e.g., `fit_720`) based on viewport size.
8. **Aggressive DOM Node Recycling:** When images leave the viewport, actively set their `src` attribute to empty or a 1x1 pixel data URI. This forces the browser to free up decoded image memory, which is critical on a 512MB device.
9. **Pre-fetching Slideshow Images:** In slideshow mode, decode the *next* image invisibly before the transition occurs to prevent CPU spikes and stuttering during the slide animation.
10. **Low-Resolution Placeholders:** Use lightweight CSS colors or 16x16 pixel BlurHash placeholders while scrolling, only loading actual thumbnails when the scroll velocity drops.

## 3. JavaScript & Main Thread Performance
11. **Web Workers for Metadata Processing:** When the client receives the 12,000+ item JSON payload from the server, parse and sort the data in a background Web Worker so the main UI thread doesn't freeze.
12. **Debounced and Throttled Event Handlers:** Heavily throttle `scroll`, `resize`, and `mousemove` events to a maximum of 15-30 frames per second to avoid saturating the event loop.
13. **Batch DOM Layout Reads/Writes:** Use `requestAnimationFrame` to batch DOM reads and writes, preventing layout thrashing (forced synchronous layout).
14. **Pause Background Activity on Idle:** If no user input is detected for a minute, pause any polling, background pre-fetching, or hidden animations to allow the CPU to cool down (preventing thermal throttling).
15. **Minimal Global State Management:** Avoid heavy state libraries (like Redux). Use native Context API or lightweight signals (like Preact Signals or Zustand) to minimize React reconciliation overhead.

## 4. Caching & Network Optimization
16. **IndexedDB Metadata Caching:** Cache the entire photo list (metadata only) in the browser's IndexedDB. The client can boot instantly from the local cache and only fetch delta updates from the server.
17. **Service Worker Asset Caching (PWA):** Cache all HTML, JS, CSS, and static icon assets locally so the browser doesn't spend CPU cycles negotiating network requests for the app shell.
18. **HTTP/2 Multiplexing:** Ensure the backend server delivers thumbnails over HTTP/2 to prevent connection-pooling limits from slowing down rapid grid scrolling.

## 5. UI/UX for Kiosk Deployments
19. **Keyboard/Remote-First Navigation:** Optimize the interface to be fully navigable via Arrow Keys, Enter, and Escape. This is ideal for Pi Zero 2 setups running a TV interface with a basic infrared/Bluetooth remote.
20. **Performance Toggle (Low-Power Mode):** Provide a user-facing toggle in the UI that disables all non-essential features (e.g., slideshow crossfades, hover effects, high-res prefetching) to guarantee smooth basic functionality.
