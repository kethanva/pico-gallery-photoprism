export class ClockOverlay {
  private el: HTMLElement;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'pico-clock';
    this.el.setAttribute('aria-hidden', 'true');
    root.appendChild(this.el);
  }

  start(): void {
    this.tick();
    this.interval = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private tick(): void {
    const now = new Date();
    this.el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
