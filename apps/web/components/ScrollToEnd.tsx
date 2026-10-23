'use client';

import { useEffect, useRef } from 'react';

/**
 * A horizontal scroller that starts at its right edge, where the newest commits are. When the
 * content grows (a live update added a stop) it follows the new end, unless you had scrolled
 * away from it.
 */
export function ScrollToEnd({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const lastWidth = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastWidth.current !== el.scrollWidth && atEnd.current) el.scrollLeft = el.scrollWidth;
    lastWidth.current = el.scrollWidth;
  });

  return (
    <div
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
      }}
    >
      {children}
    </div>
  );
}
