'use client';

import { useEffect, useRef } from 'react';

/** A horizontal scroller that starts at its right edge, where the newest commits are. */
export function ScrollToEnd({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
