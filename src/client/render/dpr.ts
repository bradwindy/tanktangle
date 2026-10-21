type PixelRatioSource = Pick<Window, 'matchMedia' | 'devicePixelRatio'>;

/**
 * Calls onChange whenever devicePixelRatio changes, including when the CSS size does not (a window
 * dragged between a 1x and a 2x display), which neither ResizeObserver nor 'resize' reliably reports.
 * A resolution query matches a single ratio, so a new one is armed after every change (MDN's pattern).
 */
export function watchPixelRatio(onChange: () => void, source: PixelRatioSource = globalThis): void {
  const arm = () => {
    const query = source.matchMedia?.(`(resolution: ${source.devicePixelRatio || 1}dppx)`);
    query?.addEventListener?.(
      'change',
      () => {
        onChange();
        arm();
      },
      { once: true },
    );
  };
  arm();
}
