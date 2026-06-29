export function applyKenBurns(layer: HTMLElement, enable: boolean): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (enable && !reducedMotion) {
    layer.classList.add('ken-burns');
  } else {
    layer.classList.remove('ken-burns');
  }
}
