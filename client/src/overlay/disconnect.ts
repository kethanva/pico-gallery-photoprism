export class DisconnectBadge {
  private badge: HTMLElement;

  constructor(root: HTMLElement) {
    this.badge = document.createElement('div');
    this.badge.className = 'disconnect-badge';
    this.badge.textContent = 'Reconnecting…';
    this.badge.setAttribute('role', 'status');
    this.badge.setAttribute('aria-live', 'assertive');
    root.appendChild(this.badge);
  }

  show(): void { this.badge.classList.add('visible'); }
  hide(): void { this.badge.classList.remove('visible'); }
}
