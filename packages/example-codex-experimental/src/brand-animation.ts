import lottiePlayerModule from 'lottie-web/build/player/lottie_light.js';
import type { LottiePlayer } from 'lottie-web';

import logoAnimationData from './assets/loom-js-logo.json' with { type: 'json' };

const host = globalThis as unknown as {
  readonly document: Document;
  readonly matchMedia?: (query: string) => MediaQueryList;
};
const lottiePlayer = lottiePlayerModule as unknown as LottiePlayer;
const brandAnimation = host.document.querySelector<HTMLElement>('#hero-brand-animation');

function initializeBrandAnimation(container: HTMLElement): void {
  if (host.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;

  try {
    const animation = lottiePlayer.loadAnimation({
      container,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      animationData: logoAnimationData,
      rendererSettings: {
        preserveAspectRatio: 'xMidYMid meet',
        progressiveLoad: true,
      },
    });
    animation.addEventListener('DOMLoaded', () => {
      container.classList.add('is-animated');
    });
    animation.addEventListener('data_failed', () => {
      animation.destroy();
      container.classList.remove('is-animated');
    });
  } catch {
    container.classList.remove('is-animated');
  }
}

if (brandAnimation !== null) initializeBrandAnimation(brandAnimation);
